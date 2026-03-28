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

// ── Connection counter for tracking ───────────────────────────────────────────
let connectionCounter = 0;

// ── Timestamp helper ──────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString();
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

// ── Knowledge Base ─────────────────────────────────────────────────────────────
const KB_ENABLED = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
if (KB_ENABLED) {
  console.log(`[relay][${ts()}] Knowledge base: ENABLED`);
} else {
  const missing = [
    !process.env.SUPABASE_URL && "SUPABASE_URL",
    !process.env.SUPABASE_SERVICE_KEY && "SUPABASE_SERVICE_KEY",
  ].filter(Boolean);
  console.warn(`[relay][${ts()}] Knowledge base: DISABLED — missing env vars: ${missing.join(", ")}`);
}

// ── Suppress noisy function-call streaming events ─────────────────────────────
const SUPPRESS_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
]);

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  console.log(`[http][${ts()}] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const body = JSON.stringify({
      status: "ok",
      model: OPENAI_MODEL,
      kb: KB_ENABLED,
      activeConnections: wss.clients.size,
      timestamp: Date.now(),
    });
    res.end(body);
    console.log(`[http][${ts()}] /health → 200 (activeConnections=${wss.clients.size})`);
    return;
  }
  res.writeHead(404);
  res.end();
  console.log(`[http][${ts()}] ${req.url} → 404`);
});

// ── WebSocket relay ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (clientWs, req) => {
  const connId = ++connectionCounter;
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const url = new URL(req.url ?? "/", `https://localhost`);
  const tag = `[conn#${connId}]`;

  console.log(`${tag}[${ts()}] ── NEW CLIENT CONNECTION ──`);
  console.log(`${tag}[${ts()}] Path: ${url.pathname}`);
  console.log(`${tag}[${ts()}] Client IP: ${clientIp}`);
  console.log(`${tag}[${ts()}] Headers: ${JSON.stringify(req.headers)}`);
  console.log(`${tag}[${ts()}] Total active connections: ${wss.clients.size}`);

  if (url.pathname !== "/") {
    console.log(`${tag}[${ts()}] Rejected — unknown path: ${url.pathname}`);
    clientWs.close();
    return;
  }

  console.log(`${tag}[${ts()}] Opening OpenAI Realtime WebSocket → ${OPENAI_REALTIME_URL}`);

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  const messageQueue = [];
  let wakeWord = null;
  let wakeWordEnabled = false;
  let isAwake = false;
  let pendingManualResponse = false;
  let transcriptionPrompt = "";

  // ── Counters for this connection ────────────────────────────────────────────
  let clientMsgCount = 0;
  let openaiMsgCount = 0;
  let audioChunksSent = 0;
  let audioChunksReceived = 0;
  let responsesCreated = 0;
  let responsesCancelled = 0;
  let responsesCompleted = 0;
  let toolCallCount = 0;
  let transcriptCount = 0;
  let wakeWordTriggerCount = 0;

  openaiWs.on("open", async () => {
    console.log(`${tag}[${ts()}] ✓ OpenAI WebSocket OPEN`);
    console.log(`${tag}[${ts()}] OpenAI WS readyState: ${openaiWs.readyState}`);

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

    // ── Fetch config ──────────────────────────────────────────────────────────
    console.log(`${tag}[${ts()}] Fetching voice agent config from API...`);
    const configFetchStart = Date.now();
    const apiConfig = await fetchVoiceAgentConfig();
    const configFetchMs = Date.now() - configFetchStart;

    let instructions, voice, language;
    if (apiConfig) {
      console.log(`${tag}[${ts()}] Config fetched from API in ${configFetchMs}ms`);
      console.log(`${tag}[${ts()}] Config details: voice=${apiConfig.voice}, language=${apiConfig.language}, wake_word=${apiConfig.wake_word}, prompt_length=${apiConfig.system_prompt?.length ?? 0}`);
      instructions = apiConfig.system_prompt || HARDCODED_INSTRUCTIONS;
      voice = apiConfig.voice || "cedar";
      language = apiConfig.language || "tr";
      wakeWord = apiConfig.wake_word || null;
    } else {
      console.warn(`${tag}[${ts()}] Config fetch failed (took ${configFetchMs}ms), using hardcoded fallback`);
      instructions = HARDCODED_INSTRUCTIONS;
      voice = "cedar";
      language = "tr";
      wakeWord = null;
    }

    wakeWordEnabled = !!wakeWord;
    isAwake = false;
    pendingManualResponse = false;
    console.log(`${tag}[${ts()}] Wake word: ${wakeWordEnabled ? `"${wakeWord}"` : "DISABLED"}`);
    console.log(`${tag}[${ts()}] Voice: ${voice}, Language: ${language}`);
    console.log(`${tag}[${ts()}] Instructions length: ${instructions.length} chars`);

    if (wakeWordEnabled) {
      instructions += `\n\n---\n\n## WAKE WORD KURALI\nBu toplantıda yalnızca biri "${wakeWord}" dediğinde cevap ver. "${wakeWord}" kelimesini duyana kadar sessiz kal, konuşmayı dinle ama müdahale etme. "${wakeWord}" dediklerinde hemen ardından gelen soruya veya talimata cevap ver. Sadece çağrıldığında konuş.`;
      console.log(`${tag}[${ts()}] Wake word rule injected into instructions`);
    }

    transcriptionPrompt = buildTranscriptionPrompt(language, wakeWord);
    console.log(`${tag}[${ts()}] Transcription prompt: "${transcriptionPrompt}"`);

    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_MODEL,
        instructions,
        ...(KB_ENABLED ? { tools: TOOLS } : {}),
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

    console.log(`${tag}[${ts()}] Sending session.update to OpenAI...`);
    console.log(`${tag}[${ts()}] session.update payload:`, JSON.stringify(sessionUpdate, null, 2));
    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log(`${tag}[${ts()}] session.update sent — model=${OPENAI_MODEL}, KB=${KB_ENABLED ? "ON" : "OFF"}, tools=${KB_ENABLED ? TOOLS.length : 0}`);

    // Flush queued messages
    if (messageQueue.length > 0) {
      console.log(`${tag}[${ts()}] Flushing ${messageQueue.length} queued messages`);
    }
    while (messageQueue.length > 0) {
      const queued = messageQueue.shift();
      openaiWs.send(queued);
      console.log(`${tag}[${ts()}] Flushed queued message (${queued.length} bytes)`);
    }
  });

  // ── OpenAI → Client message relay ──────────────────────────────────────────
  openaiWs.on("message", async (data) => {
    openaiMsgCount++;
    const raw = data.toString();
    const rawLen = raw.length;

    try {
      const msg = JSON.parse(raw);

      // ── Log every event type ────────────────────────────────────────────────
      const eventType = msg.type || "unknown";

      // Detailed logging per event type
      switch (eventType) {
        case "error":
          console.error(`${tag}[${ts()}] ✗ OpenAI ERROR:`, JSON.stringify(msg, null, 2));
          break;

        case "session.created":
          console.log(`${tag}[${ts()}] ✓ Session CREATED — id: ${msg.session?.id}, model: ${msg.session?.model}`);
          console.log(`${tag}[${ts()}]   session object keys: ${Object.keys(msg.session || {}).join(", ")}`);
          break;

        case "session.updated":
          console.log(`${tag}[${ts()}] ✓ Session UPDATED — voice: ${msg.session?.audio?.output?.voice}, turn_detection: ${msg.session?.audio?.input?.turn_detection?.type}, tools: ${msg.session?.tools?.length ?? 0}`);
          break;

        case "input_audio_buffer.speech_started":
          console.log(`${tag}[${ts()}] 🎙 SPEECH STARTED — user is speaking (item_id: ${msg.item_id || "n/a"})`);
          break;

        case "input_audio_buffer.speech_stopped":
          console.log(`${tag}[${ts()}] 🎙 SPEECH STOPPED — user stopped speaking (item_id: ${msg.item_id || "n/a"})`);
          break;

        case "input_audio_buffer.committed":
          console.log(`${tag}[${ts()}] 📦 Audio buffer COMMITTED (item_id: ${msg.item_id || "n/a"})`);
          break;

        case "conversation.item.created":
          console.log(`${tag}[${ts()}] 💬 Conversation item CREATED — id: ${msg.item?.id}, type: ${msg.item?.type}, role: ${msg.item?.role || "n/a"}`);
          break;

        case "conversation.item.deleted":
          console.log(`${tag}[${ts()}] 🗑 Conversation item DELETED — id: ${msg.item?.id || msg.item_id || "n/a"}`);
          break;

        case "conversation.item.truncated":
          console.log(`${tag}[${ts()}] ✂ Conversation item TRUNCATED — id: ${msg.item_id || "n/a"}, audio_end_ms: ${msg.audio_end_ms || "n/a"}`);
          break;

        case "conversation.item.input_audio_transcription.completed":
          transcriptCount++;
          const transcript = msg.transcript || "";
          console.log(`${tag}[${ts()}] 📝 TRANSCRIPT #${transcriptCount}: "${transcript}" (item_id: ${msg.item_id || "n/a"}, length: ${transcript.length})`);

          // Hallucination guard
          if (transcriptionPrompt && transcript.length > 40) {
            const normT = transcript.toLowerCase().replace(/[""''«»]/g, '"');
            const normP = transcriptionPrompt.toLowerCase().replace(/[""''«»]/g, '"');
            const promptWords = normP.split(/\s+/).filter(w => w.length > 3);
            const matchCount = promptWords.filter(w => normT.includes(w)).length;
            const matchRatio = promptWords.length > 0 ? matchCount / promptWords.length : 0;
            console.log(`${tag}[${ts()}]   Hallucination check: ${matchCount}/${promptWords.length} prompt words matched (ratio: ${matchRatio.toFixed(2)})`);
            if (promptWords.length > 0 && matchRatio > 0.5) {
              console.log(`${tag}[${ts()}]   ⚠ HALLUCINATED transcript detected — skipping wake word check`);
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(raw);
              }
              return;
            }
          }

          // Wake word check
          if (wakeWordEnabled) {
            const wakeWordDetected = !isAwake && containsWakeWord(transcript, wakeWord);
            console.log(`${tag}[${ts()}]   Wake word check: enabled=${wakeWordEnabled}, isAwake=${isAwake}, detected=${wakeWordDetected}`);
            if (wakeWordDetected) {
              wakeWordTriggerCount++;
              console.log(`${tag}[${ts()}]   ★ WAKE WORD "${wakeWord}" DETECTED (#${wakeWordTriggerCount}) — activating & sending response.create`);
              isAwake = true;
              pendingManualResponse = true;
              openaiWs.send(JSON.stringify({ type: "response.create" }));
            }
          }
          break;

        case "conversation.item.input_audio_transcription.failed":
          console.warn(`${tag}[${ts()}] ⚠ Transcription FAILED — item_id: ${msg.item_id || "n/a"}, error: ${JSON.stringify(msg.error || {})}`);
          break;

        case "response.created":
          responsesCreated++;
          console.log(`${tag}[${ts()}] 🤖 Response CREATED #${responsesCreated} — response_id: ${msg.response?.id || "n/a"}, status: ${msg.response?.status || "n/a"}`);
          console.log(`${tag}[${ts()}]   Wake state: wakeWordEnabled=${wakeWordEnabled}, isAwake=${isAwake}, pendingManualResponse=${pendingManualResponse}`);

          if (wakeWordEnabled && !isAwake && !pendingManualResponse) {
            responsesCancelled++;
            console.log(`${tag}[${ts()}]   🚫 CANCELLING response #${responsesCreated} (wake word not detected, cancel count: ${responsesCancelled})`);
            openaiWs.send(JSON.stringify({ type: "response.cancel" }));
            return;
          }
          if (pendingManualResponse) {
            console.log(`${tag}[${ts()}]   Clearing pendingManualResponse flag`);
            pendingManualResponse = false;
          }
          break;

        case "response.output_item.added":
          console.log(`${tag}[${ts()}] 📤 Response output item ADDED — item_id: ${msg.item?.id || "n/a"}, type: ${msg.item?.type || "n/a"}`);
          break;

        case "response.output_item.done":
          console.log(`${tag}[${ts()}] ✓ Response output item DONE — item_id: ${msg.item?.id || "n/a"}, type: ${msg.item?.type || "n/a"}`);
          break;

        case "response.content_part.added":
          console.log(`${tag}[${ts()}] 📎 Response content part ADDED — type: ${msg.part?.type || "n/a"}`);
          break;

        case "response.content_part.done":
          console.log(`${tag}[${ts()}] ✓ Response content part DONE — type: ${msg.part?.type || "n/a"}`);
          break;

        case "response.text.delta":
          console.log(`${tag}[${ts()}] 📝 Response text delta: "${(msg.delta || "").substring(0, 100)}${(msg.delta || "").length > 100 ? "..." : ""}"`);
          break;

        case "response.text.done":
          console.log(`${tag}[${ts()}] ✓ Response text DONE — full text length: ${(msg.text || "").length}`);
          break;

        case "response.audio_transcript.delta":
          // Log first 80 chars of each delta
          console.log(`${tag}[${ts()}] 🗣 Audio transcript delta: "${(msg.delta || "").substring(0, 80)}${(msg.delta || "").length > 80 ? "..." : ""}"`);
          break;

        case "response.audio_transcript.done":
          console.log(`${tag}[${ts()}] ✓ Audio transcript DONE — full transcript length: ${(msg.transcript || "").length}, text: "${(msg.transcript || "").substring(0, 150)}"`);
          break;

        case "response.output_audio.delta":
        case "response.audio.delta":
          audioChunksReceived++;
          if (audioChunksReceived % 50 === 1) {
            console.log(`${tag}[${ts()}] 🔊 Audio delta chunk #${audioChunksReceived} (${rawLen} bytes payload)`);
          }
          // Wake word gate
          if (wakeWordEnabled && !isAwake) {
            console.log(`${tag}[${ts()}]   🔇 Audio suppressed (sleeping, chunk #${audioChunksReceived})`);
            return;
          }
          break;

        case "response.audio.done":
        case "response.output_audio.done":
          console.log(`${tag}[${ts()}] ✓ Audio stream DONE — total audio chunks received so far: ${audioChunksReceived}`);
          break;

        case "response.done":
          responsesCompleted++;
          const status = msg.response?.status ?? msg.status;
          const usage = msg.response?.usage;
          console.log(`${tag}[${ts()}] ✅ Response DONE #${responsesCompleted} — status: ${status}, response_id: ${msg.response?.id || "n/a"}`);
          if (usage) {
            console.log(`${tag}[${ts()}]   Usage: input_tokens=${usage.input_tokens || 0}, output_tokens=${usage.output_tokens || 0}, total_tokens=${usage.total_tokens || 0}`);
            if (usage.input_token_details) {
              console.log(`${tag}[${ts()}]   Input token details:`, JSON.stringify(usage.input_token_details));
            }
            if (usage.output_token_details) {
              console.log(`${tag}[${ts()}]   Output token details:`, JSON.stringify(usage.output_token_details));
            }
          }
          if (msg.response?.output) {
            console.log(`${tag}[${ts()}]   Output items: ${msg.response.output.length}`);
            msg.response.output.forEach((item, idx) => {
              console.log(`${tag}[${ts()}]   Output[${idx}]: type=${item.type}, role=${item.role || "n/a"}, id=${item.id || "n/a"}`);
            });
          }

          if (wakeWordEnabled && status === "completed") {
            console.log(`${tag}[${ts()}]   Going back to sleep (wake word mode)`);
            isAwake = false;
          }
          if (status === "cancelled") {
            console.log(`${tag}[${ts()}]   Response was cancelled`);
          }
          if (status === "failed") {
            console.error(`${tag}[${ts()}]   Response FAILED — error: ${JSON.stringify(msg.response?.status_details || {})}`);
          }
          break;

        case "rate_limits.updated":
          console.log(`${tag}[${ts()}] ⏱ Rate limits updated:`, JSON.stringify(msg.rate_limits || []));
          break;

        // ── Tool call events ──────────────────────────────────────────────────
        case "response.function_call_arguments.delta":
          // Logged but suppressed from client
          console.log(`${tag}[${ts()}] 🔧 Tool args delta: call_id=${msg.call_id || "n/a"}, delta_len=${(msg.delta || "").length}`);
          break;

        case "response.function_call_arguments.done": {
          toolCallCount++;
          const { call_id, name, arguments: rawArgs } = msg;
          console.log(`${tag}[${ts()}] 🔧 TOOL CALL #${toolCallCount} COMPLETE: name=${name}, call_id=${call_id}`);
          console.log(`${tag}[${ts()}]   Raw arguments: ${rawArgs}`);

          let toolResult;

          if (name === "search_knowledge_base") {
            if (!KB_ENABLED) {
              toolResult = "Bilgi tabanı şu an devre dışı. Kendi bilginle en iyi cevabı ver.";
              console.log(`${tag}[${ts()}]   KB search SKIPPED — KB disabled`);
            } else {
              try {
                const args = JSON.parse(rawArgs);
                console.log(`${tag}[${ts()}]   KB search: query="${args.query}", category="${args.category || "null"}"`);
                const searchStart = Date.now();
                const results = await searchKnowledgeBase(args.query, args.category || null);
                const searchMs = Date.now() - searchStart;
                toolResult = formatKBResults(results);
                console.log(`${tag}[${ts()}]   KB search completed in ${searchMs}ms — ${results.length} results`);
                if (results.length > 0) {
                  results.forEach((r, i) => {
                    console.log(`${tag}[${ts()}]     Result[${i}]: title="${r.document_title}", category="${r.category_name}", similarity=${(r.similarity * 100).toFixed(1)}%, content_len=${r.content?.length || 0}`);
                  });
                }
              } catch (err) {
                console.error(`${tag}[${ts()}]   KB search ERROR:`, err.message, err.stack);
                toolResult = "Bilgi tabanı aramasında bir hata oluştu. Kendi bilginle cevap ver.";
              }
            }
          } else {
            toolResult = `Bilinmeyen araç: ${name}`;
            console.warn(`${tag}[${ts()}]   Unknown tool: ${name}`);
          }

          console.log(`${tag}[${ts()}]   Sending function_call_output (${toolResult.length} chars) for call_id=${call_id}`);
          openaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id,
              output: toolResult,
            },
          }));

          isAwake = true;
          pendingManualResponse = true;
          console.log(`${tag}[${ts()}]   Re-asserting awake state for follow-up response`);

          openaiWs.send(JSON.stringify({ type: "response.create" }));
          console.log(`${tag}[${ts()}]   response.create sent after tool output`);
          return;
        }

        default:
          // Log any unhandled event types
          if (!SUPPRESS_EVENTS.has(eventType)) {
            console.log(`${tag}[${ts()}] 📨 OpenAI event: ${eventType} (${rawLen} bytes)`);
          }
          break;
      }

      // Suppress noisy events from client
      if (SUPPRESS_EVENTS.has(msg.type)) {
        return;
      }
    } catch (parseErr) {
      console.warn(`${tag}[${ts()}] ⚠ Failed to parse OpenAI message (${rawLen} bytes): ${parseErr.message}`);
    }

    // Forward to client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(raw);
    } else {
      console.warn(`${tag}[${ts()}] Client WS not open (state=${clientWs.readyState}), dropping message`);
    }
  });

  // ── Connection lifecycle ───────────────────────────────────────────────────
  openaiWs.on("close", (code, reason) => {
    console.log(`${tag}[${ts()}] ── OpenAI WS CLOSED ──`);
    console.log(`${tag}[${ts()}]   Code: ${code}, Reason: ${reason?.toString() || "none"}`);
    console.log(`${tag}[${ts()}]   Session stats: openaiMsgs=${openaiMsgCount}, clientMsgs=${clientMsgCount}, audioChunksSent=${audioChunksSent}, audioChunksReceived=${audioChunksReceived}`);
    console.log(`${tag}[${ts()}]   Response stats: created=${responsesCreated}, completed=${responsesCompleted}, cancelled=${responsesCancelled}`);
    console.log(`${tag}[${ts()}]   Tool calls: ${toolCallCount}, Transcripts: ${transcriptCount}, Wake word triggers: ${wakeWordTriggerCount}`);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error(`${tag}[${ts()}] ✗ OpenAI WebSocket ERROR: ${err.message}`);
    console.error(`${tag}[${ts()}]   Error details:`, err.code, err.type);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on("message", (data) => {
    clientMsgCount++;
    const dataStr = data.toString();
    const dataLen = dataStr.length;

    // Parse client message to log details
    try {
      const clientMsg = JSON.parse(dataStr);
      if (clientMsg.type === "input_audio_buffer.append") {
        audioChunksSent++;
        if (audioChunksSent % 100 === 1) {
          console.log(`${tag}[${ts()}] 🎤 Client audio chunk #${audioChunksSent} (audio_len=${clientMsg.audio?.length || 0})`);
        }
      } else {
        console.log(`${tag}[${ts()}] ← Client msg #${clientMsgCount}: type=${clientMsg.type} (${dataLen} bytes)`);
      }
    } catch {
      console.log(`${tag}[${ts()}] ← Client msg #${clientMsgCount}: (unparseable, ${dataLen} bytes)`);
    }

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(dataStr);
    } else {
      messageQueue.push(dataStr);
      console.log(`${tag}[${ts()}]   OpenAI WS not ready (state=${openaiWs.readyState}), queued (queue_size=${messageQueue.length})`);
    }
  });

  clientWs.on("close", (code, reason) => {
    console.log(`${tag}[${ts()}] ── CLIENT DISCONNECTED ──`);
    console.log(`${tag}[${ts()}]   Code: ${code}, Reason: ${reason?.toString() || "none"}`);
    console.log(`${tag}[${ts()}]   Final stats: clientMsgs=${clientMsgCount}, openaiMsgs=${openaiMsgCount}`);
    console.log(`${tag}[${ts()}]   Audio: sent=${audioChunksSent}, received=${audioChunksReceived}`);
    console.log(`${tag}[${ts()}]   Responses: created=${responsesCreated}, completed=${responsesCompleted}, cancelled=${responsesCancelled}`);
    console.log(`${tag}[${ts()}]   Tools: ${toolCallCount}, Transcripts: ${transcriptCount}, Wake triggers: ${wakeWordTriggerCount}`);
    console.log(`${tag}[${ts()}]   Remaining connections: ${wss.clients.size - 1}`);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  clientWs.on("error", (err) => {
    console.error(`${tag}[${ts()}] ✗ Client WebSocket ERROR: ${err.message}`);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  // Ping/pong monitoring
  clientWs.on("ping", (data) => {
    console.log(`${tag}[${ts()}] 🏓 Client PING received`);
  });
  clientWs.on("pong", (data) => {
    console.log(`${tag}[${ts()}] 🏓 Client PONG received`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[relay][${ts()}] ════════════════════════════════════════════`);
  console.log(`[relay][${ts()}] Server listening on port ${PORT}`);
  console.log(`[relay][${ts()}] Model: ${OPENAI_MODEL}`);
  console.log(`[relay][${ts()}] Realtime URL: ${OPENAI_REALTIME_URL}`);
  console.log(`[relay][${ts()}] Knowledge base: ${KB_ENABLED ? "ENABLED" : "DISABLED"}`);
  console.log(`[relay][${ts()}] Startup diagnostics:`, JSON.stringify({
    PORT,
    MODEL: OPENAI_MODEL,
    SUPABASE_URL: process.env.SUPABASE_URL ? "set" : "MISSING",
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? "set" : "MISSING",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "set" : "MISSING",
    BACKEND_API_URL: process.env.BACKEND_API_URL ? "set" : "MISSING",
    KB_ENABLED,
  }, null, 2));
  console.log(`[relay][${ts()}] Node version: ${process.version}`);
  console.log(`[relay][${ts()}] Platform: ${process.platform} ${process.arch}`);
  console.log(`[relay][${ts()}] Memory: ${JSON.stringify(process.memoryUsage())}`);
  console.log(`[relay][${ts()}] ════════════════════════════════════════════`);
});

// ── Process-level event logging ───────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error(`[relay][${ts()}] ✗ UNCAUGHT EXCEPTION:`, err.message, err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`[relay][${ts()}] ✗ UNHANDLED REJECTION:`, reason);
});

process.on("SIGTERM", () => {
  console.log(`[relay][${ts()}] Received SIGTERM — shutting down gracefully`);
  wss.clients.forEach((ws) => ws.close());
  httpServer.close(() => {
    console.log(`[relay][${ts()}] HTTP server closed`);
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log(`[relay][${ts()}] Received SIGINT — shutting down`);
  wss.clients.forEach((ws) => ws.close());
  httpServer.close(() => {
    console.log(`[relay][${ts()}] HTTP server closed`);
    process.exit(0);
  });
});
