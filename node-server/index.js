import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { TOOLS } from "./lib/tools.js";
import { searchKnowledgeBase, formatKBResults } from "./lib/knowledge-base.js";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT ?? 3000;
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.error("[relay] OPENAI_API_KEY is required");
  process.exit(1);
}

const KB_ENABLED = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
if (KB_ENABLED) {
  console.log("[relay] Knowledge base: ENABLED");
} else {
  const missing = [
    !process.env.SUPABASE_URL && "SUPABASE_URL",
    !process.env.SUPABASE_SERVICE_KEY && "SUPABASE_SERVICE_KEY",
  ].filter(Boolean);
  console.warn(`[relay] Knowledge base: DISABLED — missing env vars: ${missing.join(", ")}`);
  console.warn("[relay] Set these in the Railway service Variables tab to enable KB search.");
}

const SUPPRESS_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
]);

const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", kb: KB_ENABLED, timestamp: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

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
      "OpenAI-Beta": "realtime=v1",
    },
  });

  const messageQueue = [];

  openaiWs.on("open", () => {
    console.log("[relay] Connected to OpenAI Realtime API");

    const sessionUpdate = {
      type: "session.update",
      session: {
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "echo",
        instructions: `Senin adın Weya — Light Eagle'ın toplantı asistanı. Ana dilin Türkçe.

Konuşma tarzın:
- Doğal, akıcı, samimi. Robotik değil.
- Kısa konuş. 1-2 cümle yeter.
- "Tabii ki", "Elbette", "Harika" gibi dolgu kelimeler kullanma.
- Direkt cevap ver, giriş yapma.

Şirket bilgileri için search_knowledge_base aracını kullan. Sonuç yoksa "Bu konuda bilgim yok" de, uydurma.`,
        ...(KB_ENABLED ? { tools: TOOLS } : {}),
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
        },
        input_audio_transcription: {
          model: "whisper-1",
          language: "tr",
        },
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
      },
    };

    console.log("[relay] Sending session.update:", JSON.stringify(sessionUpdate, null, 2));
    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log("[relay] Sent session.update", KB_ENABLED ? "(with KB tools)" : "(no KB)");

    while (messageQueue.length > 0) {
      openaiWs.send(messageQueue.shift());
    }
  });

  openaiWs.on("message", async (data) => {
    const raw = data.toString();

    try {
      const msg = JSON.parse(raw);

      if (msg.type === "error") {
        console.error("[relay] OpenAI ERROR:", JSON.stringify(msg, null, 2));
      }
      if (msg.type === "session.created") {
        console.log("[relay] Session created:", msg.session?.id);
      }
      if (msg.type === "session.updated") {
        console.log("[relay] Session updated successfully");
      }

      if (msg.type === "response.function_call_arguments.done") {
        const { call_id, name, arguments: rawArgs } = msg;
        console.log(`[relay] Tool call: ${name}`, rawArgs);

        let toolResult;

        if (name === "search_knowledge_base") {
          try {
            const args = JSON.parse(rawArgs);
            const results = await searchKnowledgeBase(args.query, args.category || null);
            toolResult = formatKBResults(results);
            console.log(`[relay] KB search: query="${args.query}", results=${results.length}`);
          } catch (err) {
            console.error("[relay] KB search error:", err);
            toolResult = "Bilgi tabanı aramasında bir hata oluştu. Kendi bilginle cevap ver.";
          }
        } else {
          toolResult = `Bilinmeyen araç: ${name}`;
        }

        openaiWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call_id,
            output: toolResult,
          },
        }));

        openaiWs.send(JSON.stringify({ type: "response.create" }));
        console.log(`[relay] Tool response sent for call_id=${call_id}`);
        return;
      }

      if (SUPPRESS_EVENTS.has(msg.type)) {
        return;
      }
    } catch (err) {
      // parse hatası — olduğu gibi ilet
    }

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(raw);
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("[relay] OpenAI WS closed:", { code, reason: reason?.toString() });
    clientWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error("[relay] OpenAI WebSocket error:", err.message);
    clientWs.close();
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
    openaiWs.close();
  });

  clientWs.on("error", (err) => {
    console.error("[relay] Client WebSocket error:", err.message);
    openaiWs.close();
  });
});

httpServer.listen(PORT, () => {
  console.log(`[relay] Server listening on port ${PORT}`);
  console.log(`[relay] Knowledge base: ${KB_ENABLED ? "ENABLED" : "DISABLED"}`);
  console.log("[relay] Startup diagnostics:", {
    PORT: process.env.PORT,
    SUPABASE_URL: process.env.SUPABASE_URL ? "set" : "MISSING",
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? "set" : "MISSING",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "set" : "MISSING",
    KB_ENABLED,
  });
});
