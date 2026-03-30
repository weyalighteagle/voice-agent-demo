import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { TOOLS } from "./lib/tools.js";
import { searchKnowledgeBase, formatKBResults } from "./lib/knowledge-base.js";
import { fetchVoiceAgentConfig } from "./lib/fetch-config.js";
import { containsWakeWord } from "./lib/wake-word.js";
import { WhisperTranscriber, isWhisperEnabled } from "./lib/whisper-transcription.js";

dotenv.config();

// ── Env & config ──────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BACKEND_API_URL = process.env.BACKEND_API_URL;
const PORT = process.env.PORT ?? 3000;

const OPENAI_MODEL = "gpt-realtime-2025-08-28";
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`;

// ── Transcription engine selection ────────────────────────────────────────────
// WHISPER_TRANSCRIPTION=true → Whisper API (batch, better Turkish accuracy)
// Otherwise → OpenAI Realtime built-in transcription (streaming but worse Turkish)
const USE_WHISPER = isWhisperEnabled();
console.log(`[relay] Transcription engine: ${USE_WHISPER ? `Whisper (${process.env.WHISPER_MODEL || "whisper-1"})` : "OpenAI Realtime built-in"}`);

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
      transcription: USE_WHISPER ? `whisper-${process.env.WHISPER_MODEL || "whisper-1"}` : "openai-realtime",
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
  let isAwake = false;
  let pendingManualResponse = false;
  let transcriptionPrompt = "";
  let activeResponseId = null;
  let awaitingToolFollowUp = false;
  let pendingWakeUpTimer = null;
  let language = "tr";

  // ▸ Whisper transcriber instance (per connection)
  let whisper = null;

  // ▸ DEBUG — structured state logger
  function logState(context) {
    const wakeUp = pendingWakeUpTimer ? `${Math.max(0, Math.round((pendingWakeUpTimer - Date.now()) / 1000))}s` : "none";
    console.log(`[state] ${context} | awake=${isAwake} pending=${pendingManualResponse} resp=${activeResponseId || "none"} toolFollowUp=${awaitingToolFollowUp} wakeUp=${wakeUp}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ▸ TRANSCRIPT HANDLER — shared between Whisper and OpenAI fallback
  // ══════════════════════════════════════════════════════════════════════════
  function handleTranscript(transcript, source = "whisper") {
    console.log(`[relay] Transcript (${source}): "${transcript}"`);
    logState("transcript");

    // ── Wake word detection (only when sleeping)
    if (wakeWordEnabled && !isAwake) {
      const wakeMatch = containsWakeWord(transcript, wakeWord);
      console.log(`[wake] containsWakeWord="${wakeMatch}" for: "${transcript}"`);
      if (wakeMatch) {
        const remainder = transcript.toLowerCase()
          .replace(/hey/gi, "")
          .replace(/weya/gi, "")
          .replace(/veya/gi, "")
          .replace(/wey[aä]/gi, "")
          .replace(/vey[aä]/gi, "")
          .replace(/[.,!?\s]/g, "")
          .trim();

        if (remainder.length >= 3) {
          console.log(`[relay] ★ WAKE WORD + CONTENT detected: "${transcript}" (remainder="${remainder}")`);
          isAwake = true;
          pendingManualResponse = true;
          pendingWakeUpTimer = null;
          logState("activated-with-content");
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        } else {
          console.log(`[relay] WAKE WORD ONLY (no content): "${transcript}" — waiting for follow-up`);
          pendingWakeUpTimer = Date.now() + 8000;
          logState("pending-wakeup");
        }
      } else if (pendingWakeUpTimer && Date.now() < pendingWakeUpTimer) {
        const content = transcript.replace(/[.,!?\s]/g, "").trim();
        if (content.length >= 3) {
          console.log(`[relay] ★ FOLLOW-UP CONTENT after wake word: "${transcript}"`);
          isAwake = true;
          pendingManualResponse = true;
          pendingWakeUpTimer = null;
          logState("activated-follow-up");
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        } else {
          console.log(`[relay] Follow-up transcript too short, still waiting: "${transcript}"`);
        }
      } else {
        if (pendingWakeUpTimer && Date.now() >= pendingWakeUpTimer) {
          console.log(`[relay] Pending wake-up expired`);
          pendingWakeUpTimer = null;
        }
      }
    }
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

    let instructions, voice;
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
    pendingWakeUpTimer = null;
    console.log(`[relay] Wake word: ${wakeWordEnabled ? `"${wakeWord}"` : "DISABLED"}`);

    if (wakeWordEnabled) {
      instructions += `\n\n---\n\n## WAKE WORD KURALI\nBu toplantıda yalnızca biri "${wakeWord}" dediğinde cevap ver. "${wakeWord}" kelimesini duyana kadar sessiz kal, konuşmayı dinle ama müdahale etme. "${wakeWord}" dediklerinde hemen ardından gelen soruya veya talimata cevap ver. Sadece çağrıldığında konuş.`;
    }

    transcriptionPrompt = buildTranscriptionPrompt(language, wakeWord);

    // ── Initialise Whisper transcriber (if enabled) ──────────────────────────
    if (USE_WHISPER) {
      whisper = new WhisperTranscriber({
        language,
        sampleRate: 24000,
        prompt: transcriptionPrompt,
        onTranscript: (transcript) => {
          handleTranscript(transcript, "whisper");
        },
        onError: (err) => {
          console.error("[relay] Whisper error:", err.message);
        },
      });
      console.log("[relay] Whisper transcriber ready");
    }

    // ── Session update ───────────────────────────────────────────────────────
    // When Whisper is active, we disable OpenAI's input transcription to avoid
    // duplicate processing and reduce hallucinations. The Realtime API still
    // hears and understands audio for responses — only transcript callbacks change.
    const audioInputConfig = {
      format: { type: "audio/pcm", rate: 24000 },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
      },
    };

    // Only add OpenAI transcription if Whisper is NOT active
    if (!USE_WHISPER) {
      audioInputConfig.transcription = {
        model: "gpt-4o-mini-transcribe-2025-12-15",
        language,
        prompt: transcriptionPrompt,
      };
    }

    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_MODEL,
        instructions,
        ...(KB_ENABLED ? { tools: TOOLS } : {}),
        audio: {
          input: audioInputConfig,
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice,
          },
        },
      },
    };

    console.log("[relay] Sending session.update:", JSON.stringify(sessionUpdate, null, 2));
    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log(`[relay] Sent session.update — model=${OPENAI_MODEL}, KB=${KB_ENABLED ? "ON" : "OFF"}, transcription=${USE_WHISPER ? "whisper" : "openai-realtime"}`);

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
      // ▸ VAD EVENTS — drive Whisper buffer lifecycle
      // ════════════════════════════════════════════════════════════════════
      if (msg.type === "input_audio_buffer.speech_started") {
        console.log(`[vad] Speech started`);
        logState("speech-start");

        // Clear Whisper buffer — new utterance starting
        if (USE_WHISPER && whisper) {
          whisper.clear();
        }
      }

      if (msg.type === "input_audio_buffer.speech_stopped") {
        console.log(`[vad] Speech stopped`);

        // Flush Whisper buffer — utterance ended, transcribe now
        if (USE_WHISPER && whisper) {
          whisper.flush().catch((err) => {
            console.error("[relay] Whisper flush error:", err.message);
          });
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // ▸ TRANSCRIPT — OpenAI built-in (only used when Whisper is off)
      // ════════════════════════════════════════════════════════════════════
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = msg.transcript || "";

        if (USE_WHISPER) {
          // Whisper is active — ignore OpenAI transcripts for wake word
          console.log(`[relay] OpenAI transcript (ignored, using Whisper): "${transcript}"`);
        } else {
          // OpenAI fallback path — full processing

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

          handleTranscript(transcript, "openai-realtime");
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // ▸ RESPONSE.CREATED — gate unwanted responses
      // ════════════════════════════════════════════════════════════════════
      if (msg.type === "response.created") {
        const respId = msg.response?.id || "unknown";
        console.log(`[relay] response.created id=${respId}`);
        logState("resp.created");

        if (wakeWordEnabled && !isAwake && !pendingManualResponse && !awaitingToolFollowUp) {
          console.log(`[relay] BLOCKING auto-response ${respId} (sleeping, no pending, no tool follow-up)`);
          activeResponseId = respId;
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          return;
        }

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
              awaitingToolFollowUp = true;
              console.log(`[relay] TOOL CALL detected in response — awaitingToolFollowUp=true, staying awake`);
            } else if (awaitingToolFollowUp) {
              awaitingToolFollowUp = false;
              isAwake = false;
              console.log(`[relay] TOOL FOLLOW-UP completed — going to sleep`);
            } else {
              isAwake = false;
              console.log(`[relay] NORMAL response completed — going to sleep`);
            }
          } else if (status === "cancelled") {
            console.log(`[relay] Response ${respId} was cancelled`);
          }
        }

        activeResponseId = null;
        logState("resp.done-final");
      }

      // ▸ LOG — bot's spoken response text
      if (msg.type === "response.output_audio_transcript.done" || msg.type === "response.audio_transcript.done") {
        console.log(`[bot-says] "${msg.transcript || ""}"`);
      }

      // ▸ AUDIO SUPPRESSION — don't forward audio while sleeping
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

        openaiWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id,
            output: toolResult,
          },
        }));

        pendingManualResponse = true;
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

  // ══════════════════════════════════════════════════════════════════════════
  // ── Client → OpenAI message relay + Whisper audio feed
  // ══════════════════════════════════════════════════════════════════════════
  clientWs.on("message", (data) => {
    const raw = data.toString();

    // ── Intercept audio messages to feed Whisper ────────────────────────────
    if (USE_WHISPER && whisper) {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "input_audio_buffer.append" && msg.audio) {
          // Decode base64 PCM16 and feed to Whisper buffer
          const pcmBuffer = Buffer.from(msg.audio, "base64");
          whisper.feedAudio(pcmBuffer);
        }
      } catch {
        // Not JSON or parse error — ignore, still forward to OpenAI
      }
    }

    // Always forward to OpenAI (it still needs audio for understanding + VAD)
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(raw);
    } else {
      messageQueue.push(raw);
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

  clientWs.on("close", () => {
    console.log("[relay] Client disconnected — closing connections");
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
  console.log(`[relay] Transcription: ${USE_WHISPER ? `Whisper (${process.env.WHISPER_MODEL || "whisper-1"})` : "OpenAI Realtime built-in"}`);
  console.log("[relay] Startup diagnostics:", {
    PORT,
    MODEL: OPENAI_MODEL,
    SUPABASE_URL: process.env.SUPABASE_URL ? "set" : "MISSING",
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? "set" : "MISSING",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "set" : "MISSING",
    WHISPER_TRANSCRIPTION: USE_WHISPER ? "ENABLED" : "DISABLED",
    WHISPER_MODEL: process.env.WHISPER_MODEL || "whisper-1 (default)",
    BACKEND_API_URL: process.env.BACKEND_API_URL ? "set" : "MISSING",
    KB_ENABLED,
  });
});
