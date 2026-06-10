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
const BACKEND_API_URL = process.env.BACKEND_API_URL || "";
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || "";
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
  let prompt = properNouns;
  if (wakeWord) {
    prompt += `, ${wakeWord}`;
  }
  return prompt;
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

  const projectId = url.searchParams.get("project") || null;
  console.log(`[relay] Connection: projectId=${projectId}`);

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  let openaiReconnecting = false;   // true while a reconnect attempt is in progress
  let clientAlive = true;           // false after clientWs closes — prevents reconnect
  let keepaliveTimer = null;        // holds the setInterval reference for the keepalive ping
  const messageQueue = [];

  // ══════════════════════════════════════════════════════════════════════════
  // ▸ WAKE WORD — per-connection state
  // ══════════════════════════════════════════════════════════════════════════
  let wakeWord = null;
  let wakeWordEnabled = false;
  let isAwake = false;              // true = wake word detected, bot may speak
  let pendingManualResponse = false; // true = we sent response.create, next response.created is ours
  let transcriptionPrompt = "";
  let activeResponseId = null;       // currently active response ID (to avoid cancel spam)
  let awaitingToolFollowUp = false;  // true = tool call done, waiting for follow-up response
  let sessionUpdate = null;         // holds session config for reconnect

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

## KRİTİK SORGULAMA KURALLARI

1. TARİH FİLTRESİ: Geçmiş toplantılarla ilgili sorularda MUTLAKA date_from ve date_to parametrelerini kullan. "Geçen hafta" → geçen haftanın Pazartesi 00:00 ile Pazar 23:59 aralığı. "Dün" → dünün 00:00-23:59 aralığı. "Geçen Cuma" → en son Cuma'nın tarihi. "Geçen toplantı" / "en son toplantı" → date_from: 14 gün önce, date_to: bugün. KRİTİK: "geçen" kelimesi toplantı bağlamında ASLA "geçen yıl" anlamına gelmez. - "geçen toplantı" / "geçen yapılan toplantı" / "en son toplantı" = son 7 gün (date_from: 7 gün önce, date_to: bugün). - Yıl bazlı arama SADECE kullanıcı açıkça "2025'te", "geçen yıl", "geçen sene" derse yapılır. - Emin değilsen son 7 günü kullan, yılı değil. Tarih belirtilmemişse parametreleri boş bırak.

2. TOPLANTI TÜRÜ EŞLEŞTİRME: Kullanıcı belirli bir toplantı türünden bahsettiğinde meeting_type parametresini MUTLAKA doldur:
   - "yapay zeka takım toplantısı" / "yapay zeka toplantısı" / "AI toplantısı" / "haftalık toplantı" → meeting_type: "light_eagle_yapay_zeka_takim_toplantisi"
   - "coherus toplantısı" → meeting_type: "coherus_toplanti"
   - Kullanıcı sadece "geçen toplantı" veya "toplantı" diyorsa ve tür belirtmiyorsa → meeting_type KULLANMA, tüm toplantılarda ara.
   - Hem meeting_type hem de date_from/date_to'yu birlikte kullan.

3. ARAMA SORGUSU KALİTESİ: search_knowledge_base aracını çağırırken query parametresine kullanıcının asıl sorusunun KONUSUNU yaz, meta-açıklama yazma:
   - YANLIŞ: query="gündem konuları tartışmalar kararlar" (bu her toplantıyla eşleşir, özgün değil)
   - DOĞRU: query="yapay zeka takım toplantısı konuşulan konular kararlar"
   - DOĞRU: query="Gülfem görev aksiyon atanan işler"
   - Kişi-spesifik sorularda kişinin adını query'ye DAHİL ET.
   - Görev/aksiyon sorularında "görev", "aksiyon", "yapılacak", "atanan iş" gibi kelimeleri kullan.

4. GÖREV VE AKSİYON SORULARI: "Gülfem'in görevleri nelerdi?" gibi sorularda:
   - query'ye kişinin adını VE "görev aksiyon yapılacak atanan iş" kelimelerini ekle
   - Sonuçlardan SADECE görev atama, aksiyon belirleme veya iş dağılımı içeren kısımları cevapla
   - Başlığında "test" geçen toplantıları (örn. "KB Test", "Gülfem Solak test") görev kaynağı olarak KULLANMA — bunlar gerçek görev ataması içermez

5. TEKRAR ARA: İlk aramada istediğin sonucu bulamazsan, farklı anahtar kelimelerle veya farklı parametrelerle tekrar ara. Tek bir aramada bulamazsan HEMEN vazgeçme.

6. BAĞIMSIZ SORGULAMA: Her yeni soruyu bağımsız değerlendir. Önceki soruda bir kişiden (örn. "Gülfem", "Yiğit", "Onur") bahsedilmiş olsa bile:
   - Yeni soruda "ekip", "takım", "herkes", "biz", "neler yapılıyor" gibi GENEL ifadeler varsa → search_knowledge_base sorgusuna önceki kişinin adını EKLEME. Sorguyu genel tut.
   - Yeni soruda belirli bir kişi adı geçmiyorsa → önceki kişiyi varsayma, geniş kapsamlı ara.
   - Arama sonuçlarından cevap verirken de aynı kural geçerli: sonuçlarda birden fazla kişi varsa HEPSİNDEN bahset, sadece önceki sorudaki kişiye odaklanma.
   - Örnek: Önceki soru "Gülfem ne yaptı?" → Yeni soru "Ekip ne yapıyor?" → Sorgu: "ekip Weya geliştirme çalışmaları" (Gülfem'i dahil ETME). Cevap: tüm ekip üyelerinin katkılarını içersin.

7. SONUÇ YOKSA VEYA DÜŞÜK EŞLEŞME: Bilgi tabanı araması boş sonuç döndürürse veya sonuçların benzerliği düşükse, "Bu konuda bilgi tabanımda kayıt bulamadım" de — kesinlikle uydurma, tahmin etme.

8. SONUÇ SEÇİMİ: "Geçen", "en son", "son", "bir önceki" gibi ifadeler kullanıldığında, arama sonuçlarından EN YENİ TARİHLİ olanları kullan. Eski tarihli sonuçları görmezden gel. Bugünkü toplantı sırasında "geçen toplantı" denirse, bugünkü toplantı DEĞİL bir önceki gündeki toplantı kastedilir. Bugünün tarihindeki toplantı sonuçlarını "geçen toplantı" olarak SUNMA.`;

    // ── Fetch config from main backend API ───────────────────────────────────
    const apiConfig = await fetchVoiceAgentConfig();
    console.log(`[relay] KB mode: ${projectId ? `project (projectId=${projectId})` : "none"}`);

    let instructions, voice, language;
    if (apiConfig) {
      console.log("[relay] Using config from: API");
      instructions = apiConfig.system_prompt || HARDCODED_INSTRUCTIONS;
      voice = apiConfig.voice || "cedar";
      language = apiConfig.language ?? "en";
      console.log(`[relay] Language from config: "${apiConfig.language}" → resolved: "${language}"`);
      wakeWord = apiConfig.wake_word || null;
    } else {
      console.warn("[relay] Failed to fetch config from API, using hardcoded fallback");
      console.log("[relay] Using config from: hardcoded fallback");
      instructions = HARDCODED_INSTRUCTIONS;
      voice = "cedar";
      language = "tr";
      wakeWord = null;
    }

    // ── Inject today's date so the LLM can resolve relative dates ─────────
    const today = new Date();
    const dateStr = today.toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const isoDate = today.toISOString().split('T')[0];
    instructions = `Bugünün tarihi: ${dateStr} (${isoDate}). "bugün", "dün", "geçen hafta" gibi göreceli tarih ifadelerini bu tarihe göre hesapla.\nEğer ilk aramada istediğin sonucu bulamazsan, farklı anahtar kelimelerle veya farklı parametrelerle tekrar ara. Tek bir aramada bulamazsan HEMEN vazgeçme.\n\n${instructions}`;

    // ▸ Initialise state
    wakeWordEnabled = !!wakeWord;
    isAwake = false;
    pendingManualResponse = false;
    activeResponseId = null;
    awaitingToolFollowUp = false;
    console.log(`[relay] Wake word: ${wakeWordEnabled ? `"${wakeWord}"` : "DISABLED"}`);

    if (wakeWordEnabled) {
      instructions += `\n\n---\n\n## WAKE WORD KURALI\nBu toplantıda yalnızca biri "${wakeWord}" dediğinde cevap ver. "${wakeWord}" kelimesini duyana kadar sessiz kal, konuşmayı dinle ama müdahale etme. "${wakeWord}" dediklerinde hemen ardından gelen soruya veya talimata cevap ver. Sadece çağrıldığında konuş.`;
    }

    transcriptionPrompt = buildTranscriptionPrompt(language, wakeWord);

    sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_MODEL,
        instructions,
        ...(KB_ENABLED ? { tools: TOOLS } : {}),
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            // Noise reduction for meeting room (far-field microphone)
            noise_reduction: {
              type: "far_field",
            },
            transcription: {
              // CHANGED: whisper-1 → gpt-4o-mini-transcribe.
              // whisper-1 hallucinates heavily on silence/noise (produces
              // "Thanks for watching", "Subscribe", etc.). gpt-4o-mini-transcribe
              // is substantially more robust against this failure mode.
              model: "gpt-4o-transcribe",
              language,
              prompt: transcriptionPrompt,
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.6,
              prefix_padding_ms: 300,
              // CHANGED: 800 → 1000 — wait longer before declaring end-of-turn
              // so short pauses inside a sentence aren't treated as end-of-speech.
              silence_duration_ms: 1000,
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

    // ── Keepalive: send a ping every 20s to prevent OpenAI idle timeout ──────
    keepaliveTimer = setInterval(() => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.ping();
        console.log("[relay] Keepalive ping sent to OpenAI");
      }
    }, 20000);

    // Send agent config (photo URL) to the client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: "agent.config",
        photo_url: apiConfig?.photo_url || null,
      }));
      console.log(`[relay] Sent agent.config to client — photo_url=${apiConfig?.photo_url ? "set" : "none"}`);
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
        console.log("[relay] Session updated — voice:", msg.session?.audio?.output?.voice, "| turn_detection:", msg.session?.audio?.input?.turn_detection?.type);
        while (messageQueue.length > 0) {
          openaiWs.send(messageQueue.shift());
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // ▸ TRANSCRIPT — wake word detection
      // ════════════════════════════════════════════════════════════════════
      if (msg.type === "input_audio_buffer.speech_started") {
        console.log(`[vad] Speech started`);
        logState("speech-start");
        // ▸ BARGE-IN: user spoke during a live bot response — cancel it.
        // Gated on activeResponseId && isAwake so this only fires for
        // legitimate, in-flight responses. It will NOT fire for:
        //   - idle sleeping state (activeResponseId = null)
        //   - relay-blocked auto-responses (isAwake = false)
        //   - the gap between tool result and tool follow-up response.created
        //     (activeResponseId = null)
        // The existing `status === "cancelled"` branch in response.done
        // handles state cleanup (isAwake=false, awaitingToolFollowUp=false).
        if (activeResponseId && isAwake) {
          console.log(`[relay] BARGE-IN — user spoke during response ${activeResponseId}, cancelling`);
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        }
      }
      if (msg.type === "input_audio_buffer.speech_stopped") {
        console.log(`[vad] Speech stopped`);
      }

      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = msg.transcript || "";
        console.log(`[relay] Transcript: "${transcript}"`);
        logState("transcript");

        // ── Wake word detection (only when sleeping)
        if (wakeWordEnabled && !isAwake) {

          // ── Layer 1: prompt-echo guard (runs before containsWakeWord) ──────
          // Build a token set from the live transcriptionPrompt string so it
          // stays in sync automatically if the prompt changes.
          const promptTokens = new Set(
            transcriptionPrompt
              .toLowerCase()
              .replace(/[.,!?;:'"()\-–—…\[\]{}]/g, "")
              .split(/\s+/)
              .filter(Boolean)
          );
          const txTokens = transcript
            .toLowerCase()
            .replace(/[.,!?;:'"()\-–—…\[\]{}]/g, "")
            .split(/\s+/)
            .filter(Boolean);
          const matchCount = txTokens.filter(t => promptTokens.has(t)).length;
          const overlapRatio = txTokens.length > 0 ? matchCount / txTokens.length : 0;

          if (overlapRatio >= 0.75) {
            console.log(`[hallucination] PROMPT ECHO BLOCKED — ${matchCount}/${txTokens.length} tokens matched (ratio=${overlapRatio.toFixed(2)}): "${transcript}"`);
            // Still forward transcript to client, but skip wake logic entirely
          } else {

          const wakeMatch = containsWakeWord(transcript, wakeWord);
          console.log(`[wake] containsWakeWord="${wakeMatch}" for: "${transcript}"`);
          if (wakeMatch) {
            // ── Layer 2: check for meaningful content (prompt nouns also stripped)
            const remainder = transcript.toLowerCase()
              .replace(/hey/gi, "")
              .replace(/weya/gi, "")
              .replace(/veya/gi, "")
              .replace(/wey[aä]/gi, "")
              .replace(/vey[aä]/gi, "")
              .replace(/onur/gi, "")
              .replace(/yi[gğ]it/gi, "")
              .replace(/heval/gi, "")
              .replace(/g[uü]lfem/gi, "")
              .replace(/mehmet/gi, "")
              .replace(/\bcem\b/gi, "")
              .replace(/yusuf/gi, "")
              .replace(/light/gi, "")
              .replace(/eagle/gi, "")
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
              // Wake word alone (e.g. "Hey Weya.") → ignore, do not activate
              console.log(`[relay] WAKE WORD ONLY (no content): "${transcript}" — ignoring, no follow-up window`);
              logState("wake-only-ignored");
            }
          } else {
            // No wake word → ignore
          }

          } // end Layer 1 else
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
          // Cancel auto-generated responses while wake word gating is active
          console.log(`[relay] BLOCKING auto-response ${respId} (sleeping, no pending, no tool follow-up)`);
          activeResponseId = respId;
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
            awaitingToolFollowUp = false;
            isAwake = false;
            console.log(`[relay] Response ${respId} was cancelled — going to sleep`);
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
              const results = await searchKnowledgeBase(args.query, {
                date_from: args.date_from || null,
                date_to: args.date_to || null,
                meeting_type: args.meeting_type || null,
                projectId,
              });
              toolResult = formatKBResults(results);
              console.log(`[relay] KB search: query="${args.query}", projectId=${projectId || "none"}, meeting_type=${args.meeting_type || "none"}, date_from=${args.date_from || "none"}, date_to=${args.date_to || "none"}, results=${results.length}`);
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
    } catch (err) {
      console.error("[relay] message handler error:", err);
    }

    // Forward everything else to client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(raw);
    }
  });

  // ── Connection lifecycle ───────────────────────────────────────────────────
  openaiWs.on("close", (code, reason) => {
    console.log("[relay] OpenAI WS closed:", { code, reason: reason?.toString() });
    clearInterval(keepaliveTimer);

    // If client is gone, nothing to reconnect for
    if (!clientAlive || clientWs.readyState !== WebSocket.OPEN) {
      console.log("[relay] Client already gone — not reconnecting");
      return;
    }

    // OpenAI dropped us (e.g. ~30 min session limit) — attempt one reconnect
    if (!openaiReconnecting) {
      openaiReconnecting = true;
      console.log("[relay] OpenAI connection dropped — attempting reconnect in 1s");
      setTimeout(() => reconnectToOpenAI(), 1000);
    }
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
    clientAlive = false;
    clearInterval(keepaliveTimer);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  clientWs.on("error", (err) => {
    console.error("[relay] Client WebSocket error:", err.message);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  // ── Reconnect to OpenAI after unexpected close ────────────────────────────
  function reconnectToOpenAI() {
    if (!clientAlive || clientWs.readyState !== WebSocket.OPEN) {
      console.log("[relay] Reconnect aborted — client gone");
      openaiReconnecting = false;
      return;
    }

    console.log("[relay] Reconnecting to OpenAI Realtime API...");

    // Reset session state so the new session starts clean
    isAwake = false;
    pendingManualResponse = false;
    awaitingToolFollowUp = false;
    activeResponseId = null;

    const newOpenaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    });

    newOpenaiWs.on("open", () => {
      console.log("[relay] Reconnected to OpenAI — re-sending session.update");
      openaiReconnecting = false;

      // Re-send session.update with the same config (already in closure scope)
      newOpenaiWs.send(JSON.stringify(sessionUpdate));

      // Restart keepalive
      keepaliveTimer = setInterval(() => {
        if (newOpenaiWs.readyState === WebSocket.OPEN) {
          newOpenaiWs.ping();
          console.log("[relay] Keepalive ping sent to OpenAI (reconnected session)");
        }
      }, 20000);
    });

    newOpenaiWs.on("message", async (data) => {
      const raw = data.toString();

      if (wakeWordEnabled && !isAwake) {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === "response.created") {
            const respId = msg.response?.id || "unknown";
            console.log(`[relay][reconnect] BLOCKING auto-response ${respId} (sleeping)`);
            newOpenaiWs.send(JSON.stringify({ type: "response.cancel" }));
            return;
          }
          if (
            msg.type === "response.output_audio.delta" ||
            msg.type === "response.audio.delta"
          ) {
            return;
          }
        } catch {
          // not JSON — fall through and forward
        }
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(raw);
      }
    });

    newOpenaiWs.on("close", (code, reason) => {
      console.log("[relay] Reconnected OpenAI WS closed:", { code, reason: reason?.toString() });
      clearInterval(keepaliveTimer);
      if (clientAlive && clientWs.readyState === WebSocket.OPEN) {
        console.log("[relay] Second OpenAI close — closing client");
        clientWs.close();
      }
    });

    newOpenaiWs.on("error", (err) => {
      console.error("[relay] Reconnected OpenAI WS error:", err.message);
      openaiReconnecting = false;
      if (clientAlive && clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
    });
  }
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
    BACKEND_API_KEY: process.env.BACKEND_API_KEY ? "set" : "MISSING",
    KB_ENABLED,
  });
});
