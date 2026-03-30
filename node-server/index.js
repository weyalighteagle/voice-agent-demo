import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { TOOLS } from "./lib/tools.js";
import { searchKnowledgeBase, formatKBResults } from "./lib/knowledge-base.js";
import { fetchVoiceAgentConfig } from "./lib/fetch-config.js";
import { containsWakeWord } from "./lib/wake-word.js";

dotenv.config();

// ── Env & config ──────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BACKEND_API_URL = process.env.BACKEND_API_URL;
const PORT = process.env.PORT ?? 3000;

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
    prompt += ` Özel isimler ve sık geçen kelimeler: ${properNouns}.`;
    if (wakeWord) {
      prompt += ` "${wakeWord}" bir isimdir, bu şekilde yazılmalıdır.`;
      prompt += ` Sessizlik veya belirsiz ses varsa boş bırak, olmayan kelimeleri üretme.`;
    }
    return prompt;
  }

  if (language === "en") {
    let prompt = "This is an English meeting recording. Transcribe only in English.";
    prompt += ` Proper nouns and common terms: ${properNouns}.`;
    if (wakeWord) {
      prompt += ` "${wakeWord}" is a name, spell it as shown.`;
      prompt += ` If there is silence or unclear audio, leave it empty. Do not hallucinate words.`;
    }
    return prompt;
  }

  return "";
}

// ── Knowledge Base ────────────────────────────────────────────────────────────
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

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  const messageQueue = [];

  // ══════════════════════════════════════════════════════════════════════════
  // ▸ WAKE WORD — per-connection state
  // ══════════════════════════════════════════════════════════════════════════
  let wakeWord = null;
  let wakeWordEnabled = false;
  let isAwake = false;               // true = wake word detected, bot may speak
  let pendingManualResponse = false;  // true = we sent response.create, next response.created is ours
  let transcriptionPrompt = "";
  let activeResponseId = null;        // currently active legitimate response ID
  let awaitingToolFollowUp = false;   // true = tool call done, waiting for follow-up response
  // Track response IDs we intentionally blocked so response.done for those
  // IDs does not affect sleep state.
  const blockedResponseIds = new Set();

  // ▸ DEBUG — structured state logger
  function logState(context) {
    console.log(`[state] ${context} | awake=${isAwake} pending=${pendingManualResponse} resp=${activeResponseId || "none"} toolFollowUp=${awaitingToolFollowUp}`);
  }

  openaiWs.on("open", async () => {
    console.log("[relay] Connected to OpenAI Realtime API");

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
- Sonuç yoksa veya emin değilsen "Bu konuda kesin bilgim yok, kontrol etmem gerekir" de, uydurma

---

## TARİH FİLTRESİ
Geçmiş toplantılarla ilgili sorularda MUTLAKA date_from ve date_to parametrelerini kullan. "Geçen hafta" → geçen haftanın Pazartesi 00:00 ile Pazar 23:59 aralığı. "Dün" → dünün 00:00-23:59 aralığı. "Geçen Cuma" → en son Cuma'nın tarihi. Bugünün tarihini referans al. Tarih belirtilmemişse parametreleri boş bırak.`;

    // ── Fetch config from main backend API ───────────────────────────────────
    const apiConfig = await fetchVoiceAgentConfig();

    let instructions, voice, language;
    if (apiConfig) {
      console.log("[relay] Using config from: API");
      instructions = apiConfig.system_prompt || HARDCODED_INSTRUCTIONS;
      voice = apiConfig.voice || "cedar";
      language = apiConfig.language || "tr";
      wakeWord = apiConfig.wake_word || null;
    } else {
      console.warn("[relay] Failed to fetch config from API, using hardcoded fallback");
      console.log("[relay] Using config from: hardcoded fallback");
      instructions = HARDCODED_INSTRUCTIONS;
      voice = "cedar";
      language = "tr";
      wakeWord = null;
    }

    // ▸ Initialise state
    wakeWordEnabled = !!wakeWord;
    isAwake = false;
    pendingManualResponse = false;
    activeResponseId = null;
    awaitingToolFollowUp = false;
    blockedResponseIds.clear();
    console.log(`[relay] Wake word: ${wakeWordEnabled ? `"${wakeWord}"` : "DISABLED"}`);

    if (wakeWordEnabled) {
      instructions += `\n\n---\n\n## WAKE WORD KURALI\nBu toplantıda yalnızca biri "${wakeWord}" dediğinde cevap ver. "${wakeWord}" kelimesini duyana kadar sessiz kal, konuşmayı dinle ama müdahale etme. "${wakeWord}" dediklerinde hemen ardından gelen soruya veya talimata cevap ver. Sadece çağrıldığında konuş.`;
    }

    transcriptionPrompt = buildTranscriptionPrompt(language, wakeWord);

    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_MODEL,
        instructions,
        ...(KB_ENABLED ? { tools: TOOLS } : {}),
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: "gpt-4o-mini-transcribe-2025-12-15",
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
            format: { type: "audio/pcm", rate: 24000 },
            voice,
          },
        },
      },
    };

    console.log("[relay] Sending session.update:", JSON.stringify(sessionUpdate, null, 2));
    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log(`[relay] Sent session.update — model=${OPENAI_MODEL}, KB=${KB_ENABLED ? "ON" : "OFF"}`);

    while (messageQueue.length > 0) {
      openaiWs.send(messageQueue.shift());
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── OpenAI → Client message relay
  // ══════════════════════════════════════════════════════════════════════════
  openaiWs.on("message", async (data) => {
    const raw = data.toString();

    try {
      const msg = JSON.parse(raw);

      // ── Error handling — suppress cancel spam ───────────────────────────
      if (msg.type === "error") {
        if (msg.error?.code === "response_cancel_not_active") {
          return;
        }
        console.error("[relay] OpenAI ERROR:", JSON.stringify(msg, null, 2));
      }

      if (msg.type === "session.created") {
        console.log("[relay] Session created:", msg.session?.id);
      }
      if (msg.type === "session.updated") {
        console.log("[relay] Session updated — voice:", msg.session?.audio?.output?.voice,
          "| turn_detection:", msg.session?.audio?.input?.turn_detection?.type);
      }

      // ════════════════════════════════════════════════════════════════════
      // ▸ TRANSCRIPT — wake word detection + hallucination guards
      // ════════════════════════════════════════════════════════════════════
      if (msg.type === "input_audio_buffer.speech_started") {
        console.log(`[vad] Speech started`);
        logState("speech-start");
      }
      if (msg.type === "input_audio_buffer.speech_stopped") {
        console.log(`[vad] Speech stopped`);
      }

      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = msg.transcript || "";
        console.log(`[relay] Transcript: "${transcript}"`);
        logState("transcript");

        // ── Guard: Prompt echo (ASR outputs its own prompt as transcript)
        if (transcriptionPrompt && transcript.length > 40) {
          const normT = transcript.toLowerCase().replace(/[""''«»]/g, '"');
          const normP = transcriptionPrompt.toLowerCase().replace(/[""''«»]/g, '"');
          const promptWords = normP.split(/\s+/).filter(w => w.length > 3);
          const matchCount = promptWords.filter(w => normT.includes(w)).length;
          if (promptWords.length > 0 && matchCount / promptWords.length > 0.5) {
            console.log(`[relay] HALLUCINATION BLOCKED — prompt echo (${matchCount}/${promptWords.length} words matched): "${transcript.slice(0, 80)}..."`);
            if (clientWs.readyState === WebSocket.OPEN) clientWs.send(raw);
            return;
          }
        }

        // ── Wake word detection (only when sleeping)
        if (wakeWordEnabled && !isAwake) {
          const wakeMatch = containsWakeWord(transcript, wakeWord);
          console.log(`[wake] containsWakeWord="${wakeMatch}" for: "${transcript}"`);
          if (wakeMatch) {
            // Check if there's meaningful content AFTER the wake word.
            const remainder = transcript.toLowerCase()
              .replace(/hey/gi, "")
              .replace(/weya/gi, "")
              .replace(/veya/gi, "")
              .replace(/wey[aä]/gi, "")
              .replace(/vey[aä]/gi, "")
              .replace(/[.,!?\s]/g, "")
              .trim();

            if (remainder.length >= 3) {
              // Wake word + real content → activate immediately
              console.log(`[relay] ★ WAKE WORD + CONTENT detected: "${transcript}" (remainder="${remainder}")`);
              isAwake = true;
              pendingManualResponse = true;
              logState("activated-with-content");
              openaiWs.send(JSON.stringify({ type: "response.create" }));
            } else {
              // Wake word alone → ignore, do not activate
              console.log(`[relay] WAKE WORD ONLY (no content): "${transcript}" — ignoring`);
              logState("wake-only-ignored");
            }
          } else {
            // No wake word → ignore
          }
        }
        // Always forward transcript to client
      }

      // ════════════════════════════════════════════════════════════════════
      // ▸ RESPONSE.CREATED — gate unwanted responses
      // ════════════════════════════════════════════════════════════════════
      if (msg.type === "response.created") {
        const respId = msg.response?.id || "unknown";
        console.log(`[relay] response.created id=${respId}`);
        logState("resp.created");

        if (wakeWordEnabled && !isAwake && !pendingManualResponse && !awaitingToolFollowUp) {
          // Auto-generated response while sleeping — cancel and mark as blocked.
          // Do NOT touch activeResponseId so state remains clean.
          console.log(`[relay] BLOCKING auto-response ${respId} (sleeping, no pending, no tool follow-up)`);
          blockedResponseIds.add(respId);
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          return;
        }

        // Legitimate response — accept and track
        activeResponseId = respId;
        if (pendingManualResponse) {
          console.log(`[relay] Consuming pendingManualResponse for ${respId}`);
          pendingManualResponse = false;
        }
        if (awaitingToolFollowUp) {
          console.log(`[relay] Tool follow-up response accepted: ${respId}`);
        }
        logState("resp.created-OK");
      }

      // ════════════════════════════════════════════════════════════════════
      // ▸ RESPONSE.DONE — track completion, manage sleep state
      // ════════════════════════════════════════════════════════════════════
      if (msg.type === "response.done") {
        const status = msg.response?.status ?? msg.status;
        const respId = msg.response?.id || "unknown";
        const output = msg.response?.output || [];
        const outputTypes = output.map(item => item.type);

        console.log(`[relay] response.done id=${respId} status=${status} outputs=[${outputTypes}]`);

        // If this was a response we intentionally blocked, ignore it entirely.
        if (blockedResponseIds.has(respId)) {
          blockedResponseIds.delete(respId);
          console.log(`[relay] response.done for blocked response ${respId} — skipping state change`);
          logState("resp.done-blocked");
          return;
        }

        for (const item of output) {
          if (item.type === "message" && item.content) {
            for (const c of item.content) {
              if ((c.type === "audio" || c.type === "output_audio") && c.transcript) {
                console.log(`[bot-transcript] "${c.transcript.slice(0, 200)}${c.transcript.length > 200 ? "..." : ""}"`);
              }
            }
          }
        }
        logState("resp.done");

        if (wakeWordEnabled) {
          if (status === "completed") {
            const hasToolCall = output.some(item => item.type === "function_call");

            if (hasToolCall) {
              // Tool call response — stay awake for follow-up
              awaitingToolFollowUp = true;
              console.log(`[relay] TOOL CALL detected in response — awaitingToolFollowUp=true, staying awake`);
            } else if (awaitingToolFollowUp) {
              // Follow-up after tool call — go to sleep
              awaitingToolFollowUp = false;
              isAwake = false;
              console.log(`[relay] TOOL FOLLOW-UP completed — going to sleep`);
            } else {
              // Normal response — go to sleep
              isAwake = false;
              console.log(`[relay] NORMAL response completed — going to sleep`);
            }
          } else if (status === "cancelled") {
            // User interrupted the bot — go back to sleep
            isAwake = false;
            awaitingToolFollowUp = false;
            console.log(`[relay] Response ${respId} cancelled by user interruption — going to sleep`);
          }
        }

        activeResponseId = null;
        logState("resp.done-final");
      }

      // ════════════════════════════════════════════════════════════════════
      // ▸ LOG — bot's spoken response text
      // ════════════════════════════════════════════════════════════════════
      if (msg.type === "response.output_audio_transcript.done" || msg.type === "response.audio_transcript.done") {
        console.log(`[bot-says] "${msg.transcript || ""}"`);
      }

      // ════════════════════════════════════════════════════════════════════
      // ▸ AUDIO SUPPRESSION — don't forward audio while sleeping
      // ════════════════════════════════════════════════════════════════════
      if (wakeWordEnabled && !isAwake) {
        if (
          msg.type === "response.output_audio.delta" ||
          msg.type === "response.audio.delta"
        ) {
          return;
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // ▸ TOOL CALL — KB search
      // ════════════════════════════════════════════════════════════════════
      if (msg.type === "response.function_call_arguments.done") {
        const { call_id, name, arguments: rawArgs } = msg;
        console.log(`[relay] TOOL CALL: ${name} args=${rawArgs}`);
        logState("tool-call");

        let toolResult;

        if (name === "search_knowledge_base") {
          if (!KB_ENABLED) {
            toolResult = "Bilgi tabanı şu an devre dışı. Kendi bilginle en iyi cevabı ver.";
            console.log("[relay] KB disabled — returning fallback message");
          } else {
            try {
              const args = JSON.parse(rawArgs);
              console.log(`[relay] KB SEARCH: query="${args.query}" category="${args.category}" from="${args.date_from || "-"}" to="${args.date_to || "-"}"`);
              const results = await searchKnowledgeBase(
                args.query,
                args.category || null,
                args.date_from || null,
                args.date_to || null
              );
              toolResult = formatKBResults(results);
              console.log(`[relay] KB RESULTS: ${results.length} documents found`);
              if (results.length > 0) {
                results.forEach((r, i) => {
                  console.log(`[relay]   [${i+1}] "${r.document_title}" (${r.category_name}) similarity=${(r.similarity * 100).toFixed(0)}%`);
                });
              }
            } catch (err) {
              console.error("[relay] KB search error:", err);
              toolResult = "Bilgi tabanı aramasında bir hata oluştu. Kendi bilginle cevap ver.";
            }
          }
        } else {
          toolResult = `Bilinmeyen araç: ${name}`;
        }

        // Send function output back to OpenAI
        openaiWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id,
            output: toolResult,
          },
        }));

        // Mark next response.created as legitimate
        pendingManualResponse = true;

        // Trigger follow-up response
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        console.log(`[relay] Tool output sent, response.create triggered for call_id=${call_id}`);
        logState("tool-done");
        return;
      }

      // Suppress noisy streaming events
      if (SUPPRESS_EVENTS.has(msg.type)) {
        return;
      }
    } catch {
      // JSON parse error — forward as-is
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
    logState("client-disconnect");
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
