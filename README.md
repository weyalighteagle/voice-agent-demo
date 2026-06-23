# Weya — Real-Time Meeting Voice Agent

Weya is **Light Eagle's digital team member**: a real-time, voice-driven AI assistant that joins meetings, listens, and answers questions from the company knowledge base. It is built on top of Recall.ai's [Output Media](https://docs.recall.ai/docs/stream-media) feature and OpenAI's [Realtime API](https://platform.openai.com/docs/guides/realtime).

A Recall.ai bot joins a meeting and streams a webpage as its camera. That webpage opens a microphone and pipes audio through a relay server to OpenAI's Realtime API. The relay adds wake-word gating, barge-in handling, and Retrieval-Augmented Generation (RAG) against a Supabase-backed knowledge base of meeting transcripts and company documents.

### [Watch the original demo here](https://www.loom.com/share/2a02fac2643441c1990da861e829892c)

> The Loom above shows the upstream Recall.ai sample this project started from. The current app has diverged significantly — see the feature list below.

---

## Architecture

```
┌──────────────┐      audio (PCM16)      ┌──────────────┐    Realtime API    ┌────────────┐
│  Recall.ai   │  ───────────────────▶   │              │  ───────────────▶  │            │
│  bot (joins  │                         │    Relay     │                    │   OpenAI   │
│  meeting,    │   webpage as camera     │    server    │   tool calls /     │  Realtime  │
│  streams the │  ◀───────────────────   │ (node/python)│   responses        │            │
│  client)     │                         │              │  ◀───────────────  │            │
└──────────────┘                         └──────┬───────┘                    └────────────┘
       ▲                                        │
       │ webpage URL                            │ search_knowledge_base
┌──────┴───────┐                         ┌──────▼───────┐        ┌──────────────────┐
│   client     │                         │   Supabase   │        │   Backend API    │
│ (Vite/React) │                         │  (pgvector   │        │ (system prompt,  │
│              │                         │   KB + RPC)  │        │  voice, wake     │
└──────────────┘                         └──────────────┘        │  word, photo)    │
                                                                 └──────────────────┘
```

Three pieces live in this repo:

| Directory       | What it is                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `client/`       | Vite + React webpage shown by the bot. Captures the mic, plays back the agent's audio, optionally renders a full-screen agent photo. |
| `node-server/`  | **Primary** relay server (Node.js). Full feature set: wake word, barge-in, KB search, backend config, reconnect. |
| `python-server/`| Lightweight alternative relay (Python). Basic relay + KB search only — see [Node vs Python](#nodejs-vs-python-relay). |

The knowledge base (Supabase Postgres with `pgvector`) and the backend config API are **external services** this repo talks to; they are not included here.

---

## Features

- **Real-time voice** via OpenAI Realtime API (`gpt-realtime-2025-08-28` on the Node relay).
- **Knowledge base RAG** — `search_knowledge_base` tool runs a vector search over meeting transcripts and company docs (Supabase RPC `search_knowledge_base`), with optional date-range, meeting-type, and project-scoped filtering.
- **Wake-word gating** — the bot stays silent until it hears its wake word (e.g. "Weya"). Fuzzy matched with Levenshtein distance to tolerate transcription errors, with a prompt-echo guard to suppress hallucinated transcripts.
- **Barge-in** — if a person starts speaking while the bot is talking, the in-flight response is cancelled.
- **Attribution-controlled sharing** — KB results contributed by other team members are anonymized and surfaced as "brokered introductions" rather than exposing the contributor (`lib/sharingFilter.js`).
- **Backend-driven config** — system prompt, voice, language, wake word, and agent photo are fetched from a backend API at connect time, with a hardcoded Turkish fallback prompt.
- **Resilience** — keepalive pings, automatic reconnect to OpenAI on the ~30-min session limit, and client-side reconnect with exponential backoff.
- **Transcription tuning** — `gpt-4o-transcribe`, far-field noise reduction, and a proper-noun prompt to improve recognition of team member names.

---

## Prerequisites

1. [Node.js](https://nodejs.org/en/) (for the Node relay and the client)
2. [Python 3.10+](https://www.python.org/downloads/) (only if you use the Python relay)
3. A tunnel to expose your local relay — [Ngrok](https://ngrok.com/docs/getting-started/) or a deployed URL
4. [Recall.ai API Key](https://www.recall.ai/)
5. [OpenAI API Key](https://platform.openai.com/docs/overview) — **with credits**; without credits the bot connects but never speaks
6. *(Optional, for the knowledge base)* A [Supabase](https://supabase.com/) project with `pgvector` and a `search_knowledge_base` RPC

---

## Installation

```bash
git clone https://github.com/weyalighteagle/voice-agent-demo.git
cd voice-agent-demo
```

### Client

```bash
cd client
npm install
```

### Relay server (pick one)

**Node.js (recommended)**

```bash
cd node-server
npm install
```

**Python**

```bash
cd python-server
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
# KB support also needs: pip install supabase openai
```

---

## Configuration

### Node relay (`node-server/.env`)

Copy `node-server/.env.example` to `node-server/.env` and fill it in:

| Variable               | Required | Description                                                                 |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `OPENAI_API_KEY`       | ✅       | OpenAI key (must have credits).                                             |
| `PORT`                 |          | Relay port. Defaults to `3000`.                                             |
| `SUPABASE_URL`         |          | Supabase project URL. Knowledge base is **enabled** only when this + the service key are set. |
| `SUPABASE_SERVICE_KEY` |          | Supabase service role key.                                                  |
| `BACKEND_API_URL`      |          | Base URL of the backend that serves `/api/voice-agent-config`. If unset, the hardcoded fallback prompt is used. |
| `BACKEND_API_KEY`      |          | Auth key for the backend API.                                               |
| `KB_EMBEDDING_MODEL`   |          | Embedding model for KB search/ingest. Defaults to `text-embedding-3-small`. |
| `KB_MATCH_THRESHOLD`   |          | Present in `.env.example` for tuning ingest/search defaults.                |
| `KB_MATCH_COUNT`       |          | Present in `.env.example` for tuning ingest/search defaults.                |

> When `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` are missing, the relay logs `Knowledge base: DISABLED` and the agent answers from the model's own knowledge only.

### Python relay (`python-server/.env`)

```
OPENAI_API_KEY=your_api_key_here
PORT=3000
# Optional KB support:
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
BACKEND_API_URL=
BACKEND_API_KEY=
KB_EMBEDDING_MODEL=text-embedding-3-small
KB_MATCH_THRESHOLD=0.5
KB_MATCH_COUNT=10
```

---

## Knowledge base setup (optional)

The KB lives in Supabase: documents (`kb_documents`) are chunked, embedded, and stored in `kb_chunks`; search is done through the `search_knowledge_base` Postgres RPC. To load content, use the Node ingest script:

```bash
cd node-server

# From a text file
npm run ingest -- --title "Company Handbook" --category company_docs --file ./handbook.txt

# From inline text
npm run ingest -- --title "Pricing" --category company_docs --text "..."

# From a meeting transcript already stored in Supabase (utterances table)
npm run ingest -- --title "AI Team Meeting — 2026-06-15" --bot-id <recall_bot_id>
```

The script skips documents whose content hash already exists, so re-running is safe.

---

## Running locally

1. **Start a relay server** and expose it with ngrok.

   Node:

   ```bash
   cd node-server
   npm run dev          # nodemon, or: npm start
   ```

   Python:

   ```bash
   cd python-server
   python server.py
   ```

   Then in a separate terminal:

   ```bash
   ngrok http 3000
   ```

   Health check (Node): `GET http://localhost:3000/health` returns model + KB status.

2. **Create a bot** by sending the following request, replacing the placeholders. The bot joins the meeting and streams the client webpage as its camera. Pass your relay URL via the `?wss=` query param:

   ```bash
   curl --request POST \
     --url https://us-east-1.recall.ai/api/v1/bot/ \
     --header 'Authorization: YOUR_RECALL_TOKEN' \
     --header 'accept: application/json' \
     --header 'content-type: application/json' \
     --data '{
       "meeting_url": "YOUR_MEETING_URL",
       "bot_name": "Weya",
       "output_media": {
         "camera": {
           "kind": "webpage",
           "config": {
             "url": "https://YOUR_CLIENT_URL?wss=wss://YOUR_NGROK_URL"
           }
         }
       },
       "variant": {
         "zoom": "web_4_core",
         "google_meet": "web_4_core",
         "microsoft_teams": "web_4_core"
       }
     }'
   ```

### Client query parameters

The client reads these from its own URL:

| Param          | Description                                                              |
| -------------- | ------------------------------------------------------------------------ |
| `wss`          | **Required.** WebSocket URL of the relay server.                         |
| `project`      | Optional project ID — forwarded to the relay to scope KB search.         |
| `meetingToken` | Optional token — forwarded to the relay (used by the Python relay to resolve allowed KB tags). |

---

## Customizing the agent

- **System prompt, voice, language, wake word, and photo** are normally served by the backend at `GET {BACKEND_API_URL}/api/voice-agent-config` (see `node-server/lib/fetch-config.js`).
- If no backend is configured, the Node relay falls back to the hardcoded Turkish "Weya" persona and query rules defined in `node-server/index.js` (`HARDCODED_INSTRUCTIONS`).
- The KB tool schema and search behavior live in `node-server/lib/tools.js` and `node-server/lib/knowledge-base.js`.

---

## Node.js vs Python relay

Both relays bridge the client to OpenAI's Realtime API, but they are **not** at feature parity. The Node server is the actively developed one.

| Capability                         | Node relay                        | Python relay                  |
| ---------------------------------- | --------------------------------- | ----------------------------- |
| OpenAI model                       | `gpt-realtime-2025-08-28`         | `gpt-4o-realtime-preview`     |
| Knowledge base search              | ✅ (date / meeting-type / project filters) | ✅ (query + project only)     |
| Wake-word gating                   | ✅                                | ❌                            |
| Barge-in / response cancel         | ✅ (relay + client)               | client only                   |
| Backend config fetch               | ✅                                | ❌ (hardcoded prompt)         |
| Attribution-controlled sharing     | ✅                                | ❌                            |
| Auto-reconnect to OpenAI           | ✅                                | ❌                            |
| `/health` endpoint                 | ✅                                | ❌                            |

---

## Deployment

Both `client/` and `node-server/` ship with `railway.json` for [Railway](https://railway.app/):

- **client** — builds with `npm install && npm run build`, serves the static `dist/` with `serve`.
- **node-server** — starts with `node index.js`, health check at `/health`.

To build the client manually:

```bash
cd client
npm run build      # output in client/dist/
```

Once the client is hosted, point the bot's `output_media.camera.config.url` at your deployed client URL with the `?wss=` param set to your deployed relay.

---

## Acknowledgements

This project incorporates code from [OpenAI's Realtime API demo](https://github.com/openai/openai-realtime-console) (MIT License) and started from Recall.ai's Output Media voice agent sample.

---

## FAQ

**The webpage shows "Connected" but the bot won't reply.**
Most often your OpenAI account has no credits — the relay connects fine but the model produces no audio. Add credits and retry.

**The bot stays silent even when I talk to it.**
Wake-word gating may be enabled. The bot only responds after it hears its wake word (e.g. "Weya") followed by an actual request. Wake word alone (just "Hey Weya.") is intentionally ignored.

**The bot says it can't find anything in the knowledge base.**
Confirm `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set (the relay logs `Knowledge base: ENABLED` on startup), that you've ingested content, and that the `search_knowledge_base` RPC exists in your Supabase project.
