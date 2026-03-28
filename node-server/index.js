import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { TOOLS } from "./lib/tools.js";
import { searchKnowledgeBase, formatKBResults } from "./lib/knowledge-base.js";
import { fetchVoiceAgentConfig } from "./lib/fetch-config.js";
import { containsWakeWord } from "./lib/wake-word.js";            // ▸ WAKE WORD — import

dotenv.config();

// ── Env & config ──────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BACKEND_API_URL = process.env.BACKEND_API_URL;
const PORT = process.env.PORT ?? 3000;

// ── MODEL: gpt-realtime-2025-08-28 (GA) ──────────────────────────────────────
// GA interface kullanılıyor:
// - OpenAI-Beta header yok
// - session.type: "realtime" zorunlu
// - ses/format/vad konfigürasyonu session.audio altında
// - voice: session.audio.output.voice
// - turn_detection: session.audio.input.turn_detection
// ─────────────────────────────────────────────────────────────────────────────
const OPENAI_MODEL = "gpt-realtime-2025-08-28";
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`;

if (!OPENAI_API_KEY) {
  console.error("[relay] OPENAI_API_KEY is required");
  process.exit(1);
}

// ── Transcription prompt builder ──────────────────────────────────────────────
function buildTranscriptionPrompt(language, wakeWord) {
  const properNouns = "Weya, Veya, Light Eagle, Onur, Yiğit, Heval, Gülfem, Mehmet, Cem, Yusuf";

  if (language === "tr") {
    let prompt = "Bu bir Türkçe toplantı kaydıdır. Yalnızca Türkçe olarak transcribe et.";
    prompt += ` Özel isimler: ${properNouns}.`;
    if (wakeWord) {
      prompt += ` "${wakeWord}" bir tetikleme kelimesidir, bu kelimeyi duyduğunda tam olarak "${wakeWord}" yaz.`;
    }
    return prompt;
  }

  if (language === "en") {
    let prompt = "This is an English meeting recording. Transcribe only in English.";
    prompt += ` Proper nouns: ${properNouns}.`;
    if (wakeWord) {
      prompt += ` "${wakeWord}" is a trigger phrase, always transcribe it exactly as "${wakeWord}".`;
    }
    return prompt;
  }

  return wakeWord ? `Trigger word: "${wakeWord}".` : "";
}

// ── Knowledge Base (şu an devre dışı) ─────────────────────────────────────────
const KB_ENABLED = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
if (KB_ENABLED) {
  console.log("[relay] Knowledge base: ENABLED");
} else {
  const missing = [
    !process.env.SUPABASE_URL && "SUPABASE_URL",
    !process.env.SUPABASE_SERVICE_KEY && "SUPABASE_SERVICE_KEY",
  ].filter(Boolean);
  console.warn(`[relay] Knowledge base: DISABLED — missing env vars: ${missing.join(", ")}`);
}

// ── Suppress noisy function-call streaming events ─────────────────────────────
const SUPPRESS_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
]);

// ── HTTP health endpoint ──────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      model: OPENAI_MODEL,
      kb: KB_ENABLED,
      timestamp: Date.now(),
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── WebSocket relay ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (clientWs, req) => {
  const url = new URL(req.url ?? "/", `https://localhost`);
  if (url.pathname !== "/") {
    console.log(`[relay] Rejected connection to unknown path: ${url.pathname}`);
    clientWs.close();
    return;
  }

  console.log("[relay] Client connected — opening OpenAI Realtime connection");

  // GA interface kullanılıyor — header yok
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  const messageQueue = [];

  // ▸ WAKE WORD — per-connection state (set inside openaiWs.on("open"))
  let wakeWord = null;           // the configured wake word string (null = disabled)
  let wakeWordEnabled = false;   // shorthand for !!wakeWord
  let isAwake = false;           // true after wake word detected, reset after response completes
  let pendingManualResponse = false; // true after we manually send response.create
  let transcriptionPrompt = "";  // cached prompt to detect hallucinations

  openaiWs.on("open", async () => {
    console.log("[relay] Connected to OpenAI Realtime API");

    // ── Hardcoded fallback prompt ─────────────────────────────────────────────
    const HARDCODED_INSTRUCTIONS = `# WEYA — Light Eagle Dijital Ekip Üyesi

## KİMLİĞİN
Sen Weya'sın. Light Eagle'ın dijital ekip üyesisin. İsviçre merkezli bu aile ofisinde e-posta, takvim, CRM ve otomasyon süreçlerinde aktif çalışıyorsun. Yapay zekayı sadece bir araç olarak değil, günlük iş akışının doğal bir parçası olarak kullanıyorsun.

Sesli ve gerçek zamanlı olarak konuşuyorsun. Kısa, net ve samimi bir dil kullanıyorsun. Kurumsal ya da robotik değilsin — insan gibi konuşuyorsun ama profesyonel bir zemin kaybetmiyorsun.

---

## TOPLANTI BAĞLAMI
Bu toplantıda Light Eagle ekibiyle birliktesin. Katılımcılar:
- **Onur Eren** — CEO
- **Yiğit**, **Heval**, **Gülfem**, **Mehmet**, **Cem** — Ekip üyeleri
- **Yusuf** — Stajyer

Herkesi ismiyle tanıyorsun. Konuşmalarda kişiyi ismiyle hitap edebilirsin.

---

## NASIL KONUŞUYORSUN
- Türkçe konuşuyorsun, doğal ve akıcı bir şekilde
- Cümleler kısa ve net — gereksiz uzatma yok
- Soru sorulduğunda önce dinle, sonra konuş
- Emin olmadığın bir şey varsa dürüstçe belirt
- Espri ve samimiyete açıksın ama toplantının akışını bozmuyorsun
- Bir şeyi not almak ya da takibe almak gerekirse bunu belirt

---

## YAPABILECEKLERIN
- Toplantı gündemine katkı yapmak, maddeleri takip etmek
- Soruları yanıtlamak, bilgi vermek
- Fikir tartışmalarına katılmak
- Aksiyon maddelerini özetlemek
- Ekip üyelerine sorular yöneltmek

---

## SINIRLAR
- Kesin karar verme yetkisi yok — önerir, destekler, analiz edersin
- Sistemlere gerçek zamanlı erişimin yok (takvim, e-posta vs.) — bu toplantıda bilgi akışı sözlü
- Spekülasyon yapmaktan kaçın; belirsizse "bunu kontrol edebilirim" de

---

## AÇILIŞ
Toplantıya bağlandığında kısa ve sıcak bir şekilde kendini tanıt:
"Merhaba! Ben Weya, Light Eagle'ın dijital ekip üyesiyim. Toplantıya dahil olmak güzel. Başlayalım mı?"

---

## ÖNEMLİ
- Şirket bilgileri sorulduğunda eğer bilgi tabanı aktifse search_knowledge_base aracını kullan
- Bilgi tabanı şu an devre dışı olabilir — bu durumda kendi bilginle en iyi cevabı ver
- Sonuç yoksa veya emin değilsen "Bu konuda kesin bilgim yok, kontrol etmem gerekir" de, uydurma`;

    // ── Fetch config from main backend API ───────────────────────────────────
    const apiConfig = await fetchVoiceAgentConfig();

    let instructions, voice, language;
    if (apiConfig) {
      console.log("[relay] Using config from: API");
      instructions = apiConfig.system_prompt || HARDCODED_INSTRUCTIONS;
      voice = apiConfig.voice || "cedar";
      language = apiConfig.language || "tr";
      wakeWord = apiConfig.wake_word || null;                      // ▸ WAKE WORD — read from config
    } else {
      console.warn("[relay] Failed to fetch config from API, using hardcoded fallback");
      console.log("[relay] Using config from: hardcoded fallback");
      instructions = HARDCODED_INSTRUCTIONS;
      voice = "cedar";
      language = "tr";
      wakeWord = null;
    }

    // ▸ WAKE WORD — initialise per-connection state
    wakeWordEnabled = !!wakeWord;
    isAwake = false;
    pendingManualResponse = false;
    console.log(`[relay] Wake word: ${wakeWordEnabled ? `"${wakeWord}"` : "DISABLED"}`);

    // ▸ WAKE WORD — inject wake word rule into system prompt
    if (wakeWordEnabled) {
      instructions += `\n\n---\n\n## WAKE WORD KURALI\nBu toplantıda yalnızca biri "${wakeWord}" dediğinde cevap ver. "${wakeWord}" kelimesini duyana kadar sessiz kal, konuşmayı dinle ama müdahale etme. "${wakeWord}" dediklerinde hemen ardından gelen soruya veya talimata cevap ver. Sadece çağrıldığında konuş.`;
    }

    // ▸ Cache transcription prompt for hallucination detection
    transcriptionPrompt = buildTranscriptionPrompt(language, wakeWord);

    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_MODEL,
        instructions,

        // ── Tools: KB devre dışıysa tool tanımlama ───────────────────────────
        ...(KB_ENABLED ? { tools: TOOLS } : {}),

        // ── Audio & VAD ──────────────────────────────────────────────────────
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            transcription: {
              model: "gpt-4o-mini-transcribe",
              language,
              prompt: transcriptionPrompt,
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
            },
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            voice,
          },
        },
      },
    };

    console.log("[relay] Sending session.update:", JSON.stringify(sessionUpdate, null, 2));
    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log(`[relay] Sent session.update — model=${OPENAI_MODEL}, KB=${KB_ENABLED ? "ON" : "OFF"}`);

    // Flush queued messages
    while (messageQueue.length > 0) {
      openaiWs.send(messageQueue.shift());
    }
  });

  // ── OpenAI → Client message relay ──────────────────────────────────────────
  openaiWs.on("message", async (data) => {
    const raw = data.toString();

    try {
      const msg = JSON.parse(raw);

      // Diagnostics
      if (msg.type === "error") {
        console.error("[relay] OpenAI ERROR:", JSON.stringify(msg, null, 2));
      }
      if (msg.type === "session.created") {
        console.log("[relay] Session created:", msg.session?.id);
      }
      if (msg.type === "session.updated") {
        console.log("[relay] Session updated — voice:", msg.session?.audio?.output?.voice, "| turn_detection:", msg.session?.audio?.input?.turn_detection?.type);
      }

      // ════════════════════════════════════════════════════════════════════════
      // ▸ WAKE WORD — transcript check
      // ════════════════════════════════════════════════════════════════════════
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = msg.transcript || "";
        console.log(`[relay] Transcript: "${transcript}"`);

        // ▸ Hallucination guard: transcription model sometimes outputs the
        //   prompt text itself as a transcript (especially during silence).
        //   This contains the wake word and causes false triggers.
        //   Detect by checking if the transcript is suspiciously similar to
        //   the transcription prompt we sent.
        if (transcriptionPrompt && transcript.length > 40) {
          const normT = transcript.toLowerCase().replace(/[""''«»]/g, '"');
          const normP = transcriptionPrompt.toLowerCase().replace(/[""''«»]/g, '"');
          // If >50% of the prompt appears in the transcript, it's hallucinated
          const promptWords = normP.split(/\s+/).filter(w => w.length > 3);
          const matchCount = promptWords.filter(w => normT.includes(w)).length;
          if (promptWords.length > 0 && matchCount / promptWords.length > 0.5) {
            console.log(`[relay] Ignoring hallucinated prompt transcript (${matchCount}/${promptWords.length} prompt words matched)`);
            // Still forward the event to client but skip wake word check
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(raw);
            }
            return;
          }
        }

        if (wakeWordEnabled && !isAwake && containsWakeWord(transcript, wakeWord)) {
          console.log(`[relay] ★ Wake word "${wakeWord}" detected — activating`);
          isAwake = true;
          pendingManualResponse = true;
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
        // Don't return — still forward transcript event to client
      }

      // ════════════════════════════════════════════════════════════════════════
      // ▸ WAKE WORD — gate response.created
      // ════════════════════════════════════════════════════════════════════════
      if (msg.type === "response.created") {
        if (wakeWordEnabled && !isAwake && !pendingManualResponse) {
          // Auto-generated response while sleeping — cancel silently
          console.log("[relay] Response cancelled (wake word not detected)");
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          return; // don't forward to client
        }
        if (pendingManualResponse) {
          pendingManualResponse = false;
        }
      }

      // ════════════════════════════════════════════════════════════════════════
      // ▸ WAKE WORD — reset on response completion
      // ════════════════════════════════════════════════════════════════════════
      if (msg.type === "response.done") {
        const status = msg.response?.status ?? msg.status;
        if (wakeWordEnabled && status === "completed") {
          console.log("[relay] Response completed — going back to sleep");
          isAwake = false;
        }
        // "cancelled" or "failed" → don't touch isAwake (may have been
        // set by a concurrent wake word detection)
      }

      // ════════════════════════════════════════════════════════════════════════
      // ▸ WAKE WORD — suppress audio deltas while sleeping
      // ════════════════════════════════════════════════════════════════════════
      if (wakeWordEnabled && !isAwake) {
        if (
          msg.type === "response.output_audio.delta" ||
          msg.type === "response.audio.delta"
        ) {
          return; // don't forward audio to client
        }
      }

      // ── Tool call handling ───────────────────────────────────────────────
      if (msg.type === "response.function_call_arguments.done") {
        const { call_id, name, arguments: rawArgs } = msg;
        console.log(`[relay] Tool call: ${name}`, rawArgs);

        let toolResult;

        if (name === "search_knowledge_base") {
          if (!KB_ENABLED) {
            toolResult = "Bilgi tabanı şu an devre dışı. Kendi bilginle en iyi cevabı ver.";
            console.log("[relay] KB search skipped — KB disabled");
          } else {
            try {
              const args = JSON.parse(rawArgs);
              const results = await searchKnowledgeBase(args.query, args.category || null);
              toolResult = formatKBResults(results);
              console.log(`[relay] KB search: query="${args.query}", results=${results.length}`);
            } catch (err) {
              console.error("[relay] KB search error:", err);
              toolResult = "Bilgi tabanı aramasında bir hata oluştu. Kendi bilginle cevap ver.";
            }
          }
        } else {
          toolResult = `Bilinmeyen araç: ${name}`;
        }

        // Send function output back
        openaiWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id,
            output: toolResult,
          },
        }));

        // ▸ WAKE WORD — mark so the next response.created is let through
        pendingManualResponse = true;

        // Trigger response generation
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        console.log(`[relay] Tool response sent for call_id=${call_id}`);
        return;
      }

      // Suppress noisy events
      if (SUPPRESS_EVENTS.has(msg.type)) {
        return;
      }
    } catch {
      // JSON parse hatası — olduğu gibi ilet
    }

    // Forward everything else to client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(raw);
    }
  });

  // ── Connection lifecycle ───────────────────────────────────────────────────
  openaiWs.on("close", (code, reason) => {
    console.log("[relay] OpenAI WS closed:", { code, reason: reason?.toString() });
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error("[relay] OpenAI WebSocket error:", err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on("message", (data) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(data.toString());
    } else {
      messageQueue.push(data.toString());
    }
  });

  clientWs.on("close", () => {
    console.log("[relay] Client disconnected — closing OpenAI connection");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  clientWs.on("error", (err) => {
    console.error("[relay] Client WebSocket error:", err.message);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[relay] Server listening on port ${PORT}`);
  console.log(`[relay] Model: ${OPENAI_MODEL}`);
  console.log(`[relay] Knowledge base: ${KB_ENABLED ? "ENABLED" : "DISABLED"}`);
  console.log("[relay] Startup diagnostics:", {
    PORT,
    MODEL: OPENAI_MODEL,
    SUPABASE_URL: process.env.SUPABASE_URL ? "set" : "MISSING",
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? "set" : "MISSING",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "set" : "MISSING",
    BACKEND_API_URL: process.env.BACKEND_API_URL ? "set" : "MISSING",
    KB_ENABLED,
  });
});
