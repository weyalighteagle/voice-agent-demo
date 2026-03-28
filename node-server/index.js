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
  process.stderr.write("[relay] OPENAI_API_KEY is required\n");
  process.exit(1);
}

// ── Connection counter ────────────────────────────────────────────────────────
let connectionCounter = 0;

// ── Logger — process.stdout.write ile anında flush ────────────────────────────
function log(msg) {
  process.stdout.write(msg + "\n");
}
function logErr(msg) {
  process.stderr.write(msg + "\n");
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
  log("[relay] Knowledge base: ENABLED");
} else {
  const missing = [
    !process.env.SUPABASE_URL && "SUPABASE_URL",
    !process.env.SUPABASE_SERVICE_KEY && "SUPABASE_SERVICE_KEY",
  ].filter(Boolean);
  log("[relay] Knowledge base: DISABLED — missing: " + missing.join(", "));
}

// ── Suppress from client relay only ──────────────────────────────────────────
const SUPPRESS_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
]);

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  log("[http] " + req.method + " " + req.url);

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      model: OPENAI_MODEL,
      kb: KB_ENABLED,
      activeConnections: wss.clients.size,
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
  const connId = ++connectionCounter;
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const url = new URL(req.url ?? "/", "https://localhost");
  const T = "[c" + connId + "]";

  log(T + " NEW_CONN ip=" + clientIp + " path=" + url.pathname + " total=" + wss.clients.size);

  if (url.pathname !== "/") {
    log(T + " REJECTED bad path");
    clientWs.close();
    return;
  }

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: { Authorization: "Bearer " + OPENAI_API_KEY },
  });

  const messageQueue = [];
  let wakeWord = null;
  let wakeWordEnabled = false;
  let isAwake = false;
  let pendingManualResponse = false;
  let transcriptionPrompt = "";

  let clientMsgCount = 0;
  let openaiMsgCount = 0;
  let audioIn = 0;
  let audioOut = 0;
  let respCreated = 0;
  let respDone = 0;
  let respCancelled = 0;
  let toolCalls = 0;
  let transcripts = 0;
  let wakeTriggers = 0;

  openaiWs.on("open", async () => {
    log(T + " OPENAI_WS_OPEN");

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

    log(T + " Fetching config...");
    const t0 = Date.now();
    const apiConfig = await fetchVoiceAgentConfig();
    log(T + " Config fetch: " + (Date.now() - t0) + "ms result=" + (apiConfig ? "OK" : "FAILED"));

    let instructions, voice, language;
    if (apiConfig) {
      instructions = apiConfig.system_prompt || HARDCODED_INSTRUCTIONS;
      voice = apiConfig.voice || "cedar";
      language = apiConfig.language || "tr";
      wakeWord = apiConfig.wake_word || null;
      log(T + " Config: voice=" + voice + " lang=" + language + " wake=" + wakeWord + " prompt_len=" + instructions.length);
    } else {
      instructions = HARDCODED_INSTRUCTIONS;
      voice = "cedar";
      language = "tr";
      wakeWord = null;
      log(T + " Using hardcoded fallback");
    }

    wakeWordEnabled = !!wakeWord;
    isAwake = false;
    pendingManualResponse = false;

    if (wakeWordEnabled) {
      instructions += '\n\n---\n\n## WAKE WORD KURALI\nBu toplantıda yalnızca biri "' + wakeWord + '" dediğinde cevap ver. "' + wakeWord + '" kelimesini duyana kadar sessiz kal, konuşmayı dinle ama müdahale etme. "' + wakeWord + '" dediklerinde hemen ardından gelen soruya veya talimata cevap ver. Sadece çağrıldığında konuş.';
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
            format: { type: "audio/pcm", rate: 24000 },
            voice,
          },
        },
      },
    };

    openaiWs.send(JSON.stringify(sessionUpdate));
    log(T + " session.update SENT model=" + OPENAI_MODEL + " KB=" + KB_ENABLED);

    if (messageQueue.length > 0) {
      log(T + " Flushing " + messageQueue.length + " queued msgs");
      while (messageQueue.length > 0) openaiWs.send(messageQueue.shift());
    }
  });

  // ── OpenAI → Client ────────────────────────────────────────────────────────
  openaiWs.on("message", async (data) => {
    openaiMsgCount++;
    const raw = data.toString();

    try {
      const msg = JSON.parse(raw);
      const t = msg.type || "unknown";

      switch (t) {
        case "error":
          logErr(T + " OAI_ERROR: " + JSON.stringify(msg));
          break;

        case "session.created":
          log(T + " SESSION_CREATED id=" + (msg.session?.id || "-"));
          break;

        case "session.updated":
          log(T + " SESSION_UPDATED voice=" + (msg.session?.audio?.output?.voice || "-") + " vad=" + (msg.session?.audio?.input?.turn_detection?.type || "-"));
          break;

        case "input_audio_buffer.speech_started":
          log(T + " SPEECH_START");
          break;

        case "input_audio_buffer.speech_stopped":
          log(T + " SPEECH_STOP");
          break;

        case "input_audio_buffer.committed":
          log(T + " AUDIO_COMMITTED item=" + (msg.item_id || "-"));
          break;

        case "conversation.item.created":
          log(T + " ITEM_CREATED id=" + (msg.item?.id || "-") + " type=" + (msg.item?.type || "-") + " role=" + (msg.item?.role || "-"));
          break;

        case "conversation.item.input_audio_transcription.completed": {
          transcripts++;
          const transcript = msg.transcript || "";
          log(T + " TRANSCRIPT #" + transcripts + ': "' + transcript + '"');

          if (transcriptionPrompt && transcript.length > 40) {
            const normT = transcript.toLowerCase().replace(/[""''«»]/g, '"');
            const normP = transcriptionPrompt.toLowerCase().replace(/[""''«»]/g, '"');
            const promptWords = normP.split(/\s+/).filter(w => w.length > 3);
            const matchCount = promptWords.filter(w => normT.includes(w)).length;
            const ratio = promptWords.length > 0 ? matchCount / promptWords.length : 0;
            if (ratio > 0.5) {
              log(T + " HALLUCINATION " + matchCount + "/" + promptWords.length + " skip wake");
              if (clientWs.readyState === WebSocket.OPEN) clientWs.send(raw);
              return;
            }
          }

          if (wakeWordEnabled && !isAwake && containsWakeWord(transcript, wakeWord)) {
            wakeTriggers++;
            log(T + " WAKE_DETECTED #" + wakeTriggers);
            isAwake = true;
            pendingManualResponse = true;
            openaiWs.send(JSON.stringify({ type: "response.create" }));
          }
          break;
        }

        case "conversation.item.input_audio_transcription.failed":
          log(T + " TRANSCRIPT_FAIL: " + JSON.stringify(msg.error || {}));
          break;

        case "response.created":
          respCreated++;
          log(T + " RESP_CREATED #" + respCreated + " id=" + (msg.response?.id || "-") + " awake=" + isAwake + " pending=" + pendingManualResponse);
          if (wakeWordEnabled && !isAwake && !pendingManualResponse) {
            respCancelled++;
            log(T + " RESP_CANCEL (sleeping) #" + respCancelled);
            openaiWs.send(JSON.stringify({ type: "response.cancel" }));
            return;
          }
          if (pendingManualResponse) pendingManualResponse = false;
          break;

        case "response.output_item.added":
          log(T + " OUT_ITEM_ADD type=" + (msg.item?.type || "-"));
          break;

        case "response.output_item.done":
          log(T + " OUT_ITEM_DONE type=" + (msg.item?.type || "-"));
          break;

        case "response.content_part.added":
          log(T + " CONTENT_PART_ADD type=" + (msg.part?.type || "-"));
          break;

        case "response.content_part.done":
          log(T + " CONTENT_PART_DONE");
          break;

        case "response.audio_transcript.delta":
          log(T + " TXT_DELTA: " + (msg.delta || "").substring(0, 60));
          break;

        case "response.audio_transcript.done":
          log(T + " TXT_DONE: " + (msg.transcript || "").substring(0, 120));
          break;

        case "response.output_audio.delta":
        case "response.audio.delta":
          audioOut++;
          if (audioOut <= 2 || audioOut % 200 === 0) {
            log(T + " AUDIO_OUT #" + audioOut);
          }
          if (wakeWordEnabled && !isAwake) return;
          break;

        case "response.audio.done":
        case "response.output_audio.done":
          log(T + " AUDIO_OUT_DONE chunks=" + audioOut);
          break;

        case "response.done": {
          respDone++;
          const st = msg.response?.status ?? msg.status;
          const u = msg.response?.usage;
          log(T + " RESP_DONE #" + respDone + " status=" + st);
          if (u) log(T + "   tokens in=" + (u.input_tokens || 0) + " out=" + (u.output_tokens || 0));
          if (wakeWordEnabled && st === "completed") {
            log(T + "   sleep");
            isAwake = false;
          }
          break;
        }

        case "rate_limits.updated":
          log(T + " RATE_LIMITS " + JSON.stringify(msg.rate_limits || []));
          break;

        case "response.function_call_arguments.delta":
          break;

        case "response.function_call_arguments.done": {
          toolCalls++;
          const { call_id, name, arguments: rawArgs } = msg;
          log(T + " TOOL #" + toolCalls + " " + name + " call=" + call_id + " args=" + rawArgs);

          let toolResult;
          if (name === "search_knowledge_base") {
            if (!KB_ENABLED) {
              toolResult = "Bilgi tabanı şu an devre dışı. Kendi bilginle en iyi cevabı ver.";
              log(T + "   KB disabled");
            } else {
              try {
                const args = JSON.parse(rawArgs);
                const t0 = Date.now();
                const results = await searchKnowledgeBase(args.query, args.category || null);
                toolResult = formatKBResults(results);
                log(T + "   KB: q=" + args.query + " results=" + results.length + " ms=" + (Date.now() - t0));
              } catch (err) {
                logErr(T + "   KB_ERR: " + err.message);
                toolResult = "Bilgi tabanı aramasında bir hata oluştu. Kendi bilginle cevap ver.";
              }
            }
          } else {
            toolResult = "Bilinmeyen araç: " + name;
          }

          openaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id, output: toolResult },
          }));
          isAwake = true;
          pendingManualResponse = true;
          openaiWs.send(JSON.stringify({ type: "response.create" }));
          log(T + "   tool_output sent + response.create");
          return;
        }

        default:
          log(T + " EVT:" + t);
          break;
      }

      if (SUPPRESS_EVENTS.has(msg.type)) return;

    } catch (e) {
      log(T + " PARSE_ERR " + e.message);
    }

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(raw);
    }
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  openaiWs.on("close", (code, reason) => {
    log(T + " OAI_CLOSED code=" + code);
    log(T + "   stats oai=" + openaiMsgCount + " cli=" + clientMsgCount + " aIn=" + audioIn + " aOut=" + audioOut + " resp=" + respCreated + "/" + respDone + "/" + respCancelled + " tools=" + toolCalls + " tr=" + transcripts + " wake=" + wakeTriggers);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  openaiWs.on("error", (err) => {
    logErr(T + " OAI_ERR: " + err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on("message", (data) => {
    clientMsgCount++;
    const s = data.toString();

    try {
      const m = JSON.parse(s);
      if (m.type === "input_audio_buffer.append") {
        audioIn++;
        if (audioIn <= 2 || audioIn % 500 === 0) {
          log(T + " AUDIO_IN #" + audioIn);
        }
      } else {
        log(T + " CLI:" + m.type);
      }
    } catch {
      log(T + " CLI:raw " + s.length + "b");
    }

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(s);
    } else {
      messageQueue.push(s);
      log(T + " QUEUED q=" + messageQueue.length);
    }
  });

  clientWs.on("close", (code) => {
    log(T + " CLI_CLOSED code=" + code);
    log(T + "   final cli=" + clientMsgCount + " oai=" + openaiMsgCount + " aIn=" + audioIn + " aOut=" + audioOut + " resp=" + respCreated + "/" + respDone + "/" + respCancelled + " tools=" + toolCalls + " tr=" + transcripts + " wake=" + wakeTriggers);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  clientWs.on("error", (err) => {
    logErr(T + " CLI_ERR: " + err.message);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  log("========================================");
  log("[relay] STARTED port=" + PORT);
  log("[relay] model=" + OPENAI_MODEL);
  log("[relay] KB=" + (KB_ENABLED ? "ON" : "OFF"));
  log("[relay] node=" + process.version + " " + process.platform + "/" + process.arch);
  log("[relay] env OPENAI=" + (process.env.OPENAI_API_KEY ? "set" : "MISSING") + " SUPABASE=" + (process.env.SUPABASE_URL ? "set" : "MISSING") + " BACKEND=" + (process.env.BACKEND_API_URL ? "set" : "MISSING"));
  log("========================================");
});

process.on("uncaughtException", (err) => {
  logErr("[relay] UNCAUGHT: " + err.message + "\n" + err.stack);
});
process.on("unhandledRejection", (reason) => {
  logErr("[relay] UNHANDLED: " + reason);
});
process.on("SIGTERM", () => {
  log("[relay] SIGTERM");
  wss.clients.forEach((ws) => ws.close());
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  log("[relay] SIGINT");
  wss.clients.forEach((ws) => ws.close());
  httpServer.close(() => process.exit(0));
});
