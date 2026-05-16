import { useEffect, useRef, useCallback, useState } from "react";
import "./App.css";

type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

const BACKOFF = [1000, 2000, 4000, 8000, 30000];

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(true);
  // Queue of PCM16 chunks to play sequentially
  const playbackQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const isRespondingRef = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const params = new URLSearchParams(window.location.search);
  const relayUrl = params.get("wss");
  const meetingToken = params.get("meetingToken");

  // ── Audio playback ────────────────────────────────────────────────────────
  const playNextChunk = useCallback(async () => {
    if (isPlayingRef.current || playbackQueueRef.current.length === 0) return;
    if (!audioCtxRef.current) return;

    isPlayingRef.current = true;
    const chunk = playbackQueueRef.current.shift()!;

    // PCM16 little-endian → Float32
    const pcm16 = new Int16Array(chunk);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }

    const audioBuffer = audioCtxRef.current.createBuffer(
      1,
      float32.length,
      24000 // OpenAI outputs 24kHz PCM16
    );
    audioBuffer.getChannelData(0).set(float32);

    const source = audioCtxRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtxRef.current.destination);
    source.onended = () => {
      currentSourceRef.current = null;
      // Kuyruk bittiyse isPlaying'i false yap, bir sonraki chunk varsa devam et
      if (playbackQueueRef.current.length === 0) {
        isPlayingRef.current = false;
      } else {
        isPlayingRef.current = false;
        playNextChunk();
      }
    };
    source.start();
    currentSourceRef.current = source;
  }, []);

  const clearPlaybackQueue = useCallback(() => {
    playbackQueueRef.current = [];
    isPlayingRef.current = false;
    try {
      currentSourceRef.current?.stop();
    } catch (_) {}
    currentSourceRef.current = null;
  }, []);

  // ── WebSocket + microphone ────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!relayUrl) {
      setStatus("error");
      setStatusDetail("Missing ?wss= parameter");
      return;
    }

    setStatus("connecting");
    setStatusDetail(relayUrl);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      setStatus("error");
      setStatusDetail("Microphone access denied");
      return;
    }

    audioCtxRef.current = new AudioContext({ sampleRate: 24000 });

    const wsUrl = meetingToken ? `${relayUrl}?meetingToken=${meetingToken}` : relayUrl!;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      setStatus("connected");
      setStatusDetail(relayUrl);
      reconnectAttemptRef.current = 0;

      // ── Mic → relay pipeline ─────────────────────────────────────────────
      const source = audioCtxRef.current!.createMediaStreamSource(stream);
      const processor = audioCtxRef.current!.createScriptProcessor(2048, 1, 1);

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        // ── BOT KONUŞURKEN MİKROFON GÖNDERİMİNİ DURDUR ──────────────────
        // Bot'un kendi sesini input olarak algılamasını (echo) önler.
        // isPlayingRef: ses çıkışı aktif mi
        // isRespondingRef: OpenAI'dan response akışı devam ediyor mu
        if (isPlayingRef.current || isRespondingRef.current) {
          return;
        }

        const float32 = e.inputBuffer.getChannelData(0);
        // Convert Float32 → PCM16 little-endian
        const pcm16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
        }

        // Base64-encode for the Realtime API input_audio_buffer.append event
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64Audio = btoa(binary);

        ws.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: base64Audio,
          })
        );
      };

      source.connect(processor);
      processor.connect(audioCtxRef.current!.destination);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        // ── Handle agent config from relay server ──────────────────
        if (msg.type === "agent.config") {
          if (msg.photo_url) {
            setPhotoUrl(msg.photo_url);
            console.log("[voice-agent] Received agent photo:", msg.photo_url);
          }
          return;  // Don't process further — this is not an OpenAI event
        }

        switch (msg.type) {
          case "response.created": {
            isRespondingRef.current = true;
            break;
          }
          case "response.done": {
            isRespondingRef.current = false;
            // Kuyrukta ses kalmadıysa isPlaying'i de sıfırla
            if (playbackQueueRef.current.length === 0 && !currentSourceRef.current) {
              isPlayingRef.current = false;
            }
            break;
          }
          case "response.output_audio.delta":
          case "response.audio.delta": {
            // Decode base64 PCM16 and queue for playback
            const binary = atob(msg.delta);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            playbackQueueRef.current.push(bytes.buffer);
            playNextChunk();
            break;
          }
          case "input_audio_buffer.speech_started": {
            // User started speaking — cancel bot's current response
            clearPlaybackQueue();
            if (isRespondingRef.current) {
              isRespondingRef.current = false;
              ws.send(JSON.stringify({ type: "response.cancel" }));
            }
            break;
          }
          case "error": {
            console.error("[voice-agent] OpenAI error:", msg.error);
            break;
          }
        }
      } catch (err) {
        console.error("[voice-agent] Failed to parse message:", err);
      }
    };

    ws.onclose = (_event) => {
      stream.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
      clearPlaybackQueue();

      if (!shouldReconnectRef.current) return;

      setStatus("disconnected");
      const delay = BACKOFF[Math.min(reconnectAttemptRef.current, BACKOFF.length - 1)];
      setStatusDetail(`Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttemptRef.current + 1})`);
      reconnectAttemptRef.current++;

      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    ws.onerror = () => {
      setStatus("error");
      setStatusDetail(`Failed to connect to: ${relayUrl}`);
    };
  }, [relayUrl, playNextChunk, clearPlaybackQueue]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (photoUrl) {
    // Full screen photo mode — no text, no status indicators
    return (
      <div className="fullscreen-photo-container">
        <img
          src={photoUrl}
          alt="Voice Agent"
          className="fullscreen-photo"
        />
      </div>
    );
  }

  // Fallback: no photo uploaded — show original status indicator
  const dotClass = `status-dot ${status}`;
  const labels: Record<ConnectionStatus, string> = {
    idle: "Initializing...",
    connecting: "Connecting to:",
    connected: "Connected to:",
    disconnected: "Reconnecting...",
    error: "Error:",
  };

  return (
    <div className="app-container">
      <div className="status-indicator">
        <div className={dotClass} />
        <div className="status-text">
          <div className="status-label">{labels[status]}</div>
          <div className="status-url">{statusDetail}</div>
        </div>
      </div>
    </div>
  );
}
