const BACKEND_API_URL = process.env.BACKEND_API_URL;

export async function fetchVoiceAgentConfig() {
  if (!BACKEND_API_URL) {
    console.warn("[relay] BACKEND_API_URL not set — cannot fetch config from API");
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${BACKEND_API_URL}/api/voice-agent-config`, {
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[relay] Config API returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    return {
      system_prompt: data.system_prompt,
      voice: data.voice,
      language: data.language,
      wake_word: data.wake_word || null,   // ← EKLENDİ
    };
  } catch (err) {
    console.error("[relay] Failed to fetch voice agent config:", err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}