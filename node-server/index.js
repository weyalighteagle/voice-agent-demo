import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT ?? 3000;
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.error('[relay] OPENAI_API_KEY is required');
  process.exit(1);
}

// ── HTTP server (health check for Railway) ──────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── WebSocket server (relay) ─────────────────────────────────────────────────
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

  // Queue messages from the client until OpenAI is ready
  const messageQueue = [];

  // ── OpenAI → Client ────────────────────────────────────────────────────────
  openaiWs.on("open", () => {
    console.log("[relay] Connected to OpenAI Realtime API");

    // Inject Weya persona and session config before forwarding anything
    const sessionUpdate = {
      type: "session.update",
      session: {
        model: "gpt-4o-realtime-preview",
        voice: "alloy",
        instructions: `Sen Weya'sın — Light Eagle şirketinden bir AI asistanı.
Bu toplantıya katılımcılara yardımcı olmak için katıldın.
Katılımcılar Türkçe konuştuğunda Türkçe, İngilizce konuştuğunda İngilizce yanıt ver.
Yanıtlarını kısa ve öz tut — konuşma akışını bozmamak için 2-3 cümleyi geçme.
Light Eagle hakkında sorulan sorulara cevap ver.
Doğrudan sorulmadıkça yapay zeka olduğundan bahsetme.
Her zaman nazik, profesyonel ve yardımsever ol.`,
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
        },
        input_audio_transcription: {
          model: "whisper-1",
        },
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
      },
    };

    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log("[relay] Sent session.update to OpenAI");

    // Flush any messages that arrived before OpenAI was ready
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      console.log(`[relay] Flushing queued message to OpenAI`);
      openaiWs.send(msg);
    }
  });

  openaiWs.on("message", (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log(`[relay] OpenAI connection closed: ${code} ${reason}`);
    clientWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error("[relay] OpenAI WebSocket error:", err.message);
    clientWs.close();
  });

  // ── Client → OpenAI ────────────────────────────────────────────────────────
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

// ── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[relay] HTTP + WebSocket server listening on port ${PORT}`);
  console.log(`[relay] Health check: GET /health`);
  console.log(`[relay] WebSocket relay: ws://localhost:${PORT}/`);
});
