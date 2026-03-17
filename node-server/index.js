import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { TOOLS } from "./lib/tools.js";
import { searchKnowledgeBase, formatKBResults } from "./lib/knowledge-base.js";
 
dotenv.config();
 
// ── Env & config ──────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT ?? 3000;
 
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │  MODEL: gpt-4o-realtime-preview-2025-06-03                                 │
// │  En güncel preview snapshot — gpt-realtime GA modeline geçmek için         │
// │  client tarafında da event isim değişiklikleri gerektiğinden (örn.         │
// │  response.audio.delta → response.output_audio.delta), şu anda beta        │
// │  arayüzünde kalıp en yeni preview snapshot'ı kullanıyoruz.                │
// │                                                                             │
// │  GA'ya geçiş yapılacaksa:                                                  │
// │  1. OpenAI-Beta header'ını kaldır                                          │
// │  2. session.type: "realtime" ekle                                          │
// │  3. audio format yapısını değiştir (audio.input.format: {type, rate})      │
// │  4. Client event isimlerini güncelle                                       │
// │  5. Model string'ini "gpt-realtime" yap                                    │
// └─────────────────────────────────────────────────────────────────────────────┘
const OPENAI_MODEL = "gpt-4o-realtime-preview-2025-06-03";
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`;
 
if (!OPENAI_API_KEY) {
  console.error("[relay] OPENAI_API_KEY is required");
  process.exit(1);
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
 
  // Beta header ile bağlanıyoruz — client uyumluluğu için
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
 
  const messageQueue = [];
 
  openaiWs.on("open", () => {
    console.log("[relay] Connected to OpenAI Realtime API");
 
    const sessionUpdate = {
      type: "session.update",
      session: {
        model: OPENAI_MODEL,
        voice: "ash",
        instructions: `# WEYA — Light Eagle Dijital Ekip Üyesi
 
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
- Sonuç yoksa veya emin değilsen "Bu konuda kesin bilgim yok, kontrol etmem gerekir" de, uydurma`,
 
        // ── Tools: KB devre dışıysa tool tanımlama ───────────────────────────
        ...(KB_ENABLED ? { tools: TOOLS } : {}),
 
        // ── Semantic VAD: toplantıda insanları kesmemesi için ─────────────────
        // server_vad yerine semantic_vad kullanıyoruz — kullanıcının cümlesini
        // bitirip bitirmediğini anlamsal olarak algılıyor, düşünme
        // duraklamalarında erken yanıt vermiyor.
        turn_detection: {
          type: "semantic_vad",
          eagerness: "low",
        },
 
        // ── Transcription: whisper-1 yerine daha doğru model ─────────────────
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "tr",
        },
 
        // ── Audio format ─────────────────────────────────────────────────────
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
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
        console.log("[relay] Session updated — voice:", msg.session?.voice, "| turn_detection:", msg.session?.turn_detection?.type);
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
    KB_ENABLED,
  });
});
 
