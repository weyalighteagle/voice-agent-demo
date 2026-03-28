import asyncio
import json
import logging
import os
from dotenv import load_dotenv
import websockets
from websockets.legacy.server import WebSocketServerProtocol, serve
from websockets.legacy.client import connect

# ─── Optional: KB dependencies ──────────────────────────────────────────────
# pip install supabase openai httpx
try:
    from supabase import create_client as supabase_create_client
    import openai

    HAS_KB_DEPS = True
except ImportError:
    HAS_KB_DEPS = False

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

load_dotenv()
PORT = int(os.getenv("PORT", 3000))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

if not OPENAI_API_KEY:
    raise ValueError("OPENAI_API_KEY must be set in .env file")

# ─── Knowledge Base Config ───────────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
KB_EMBEDDING_MODEL = os.getenv("KB_EMBEDDING_MODEL", "text-embedding-3-small")
KB_MATCH_THRESHOLD = float(os.getenv("KB_MATCH_THRESHOLD", "0.5"))
KB_MATCH_COUNT = int(os.getenv("KB_MATCH_COUNT", "5"))

KB_ENABLED = bool(SUPABASE_URL and SUPABASE_SERVICE_KEY and HAS_KB_DEPS)
logger.info(f"Knowledge base: {'ENABLED' if KB_ENABLED else 'DISABLED'}")

supabase = None
openai_client = None
if KB_ENABLED:
    supabase = supabase_create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    openai_client = openai.OpenAI(api_key=OPENAI_API_KEY)

# ─── Tools Definition ────────────────────────────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "name": "search_knowledge_base",
        "description": (
            "Şirket bilgi tabanında arama yapar. Şirket, ürünler, fiyatlandırma, "
            "politikalar, müşteri bilgileri veya önceki toplantılar hakkında soru "
            "sorulduğunda bu aracı kullan. Genel kültür veya gündelik sohbet soruları "
            "için KULLANMA."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Aranacak sorgu metni. Kullanıcının sorusunun kısa ve net bir özeti.",
                },
                "category": {
                    "type": "string",
                    "enum": ["company_docs", "faq", "crm", "transcripts"],
                    "description": "Opsiyonel kategori filtresi. Emin değilsen boş bırak.",
                },
                "date_from": {
                    "type": "string",
                    "description": (
                        "Başlangıç tarihi (ISO 8601 format, örn: '2026-03-27T00:00:00Z'). "
                        "Kullanıcı 'geçen hafta', 'dün', 'geçen Cuma' gibi ifadeler kullandığında "
                        "bugünün tarihini referans alarak uygun ISO tarihini hesapla. "
                        "Tarih belirtilmemişse bu parametreyi gönderme."
                    ),
                },
                "date_to": {
                    "type": "string",
                    "description": (
                        "Bitiş tarihi (ISO 8601 format, örn: '2026-03-28T23:59:59Z'). "
                        "Kullanıcı 'geçen hafta' derse haftanın son gününü, 'dün' derse dünün sonunu yaz. "
                        "Tarih belirtilmemişse bu parametreyi gönderme."
                    ),
                },
            },
            "required": ["query"],
        },
    },
]

# Events we intercept (don't forward to client during tool calls)
SUPPRESS_EVENTS = {
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
}

INSTRUCTIONS = """Sen Weya'sın — Light Eagle şirketinin AI toplantı asistanı. Türkçe konuş.

KRİTİK KURALLAR:
1. DİL: Varsayılan dilin Türkçe. İlk cümlenden itibaren Türkçe konuş. Sadece karşındaki İngilizce konuşursa İngilizce'ye geç. ASLA İspanyolca veya başka dil kullanma.
2. BİLGİ TABANI: Şirket, kurucu, ekip, ürünler, hizmetler, fiyatlar, yatırımlar, müşteriler veya toplantı geçmişi hakkında bir soru sorulduğunda — ÖNCE search_knowledge_base aracını çağır, SONRA cevap ver. Aracı çağırmadan şirketle ilgili ASLA cevap verme. Bilgi tabanında sonuç yoksa "Bu konuda bilgi tabanımda kayıt bulamadım" de.
3. KISA CEVAP: 2-3 cümle. Toplantı akışını bozma.
4. KİMLİK: Yapay zeka olduğundan bahsetme, sorulmadıkça.
5. TARİH FİLTRESİ: Geçmiş toplantılarla ilgili sorularda MUTLAKA date_from ve date_to parametrelerini kullan. "Geçen hafta" → geçen haftanın Pazartesi 00:00 ile Pazar 23:59 aralığı. "Dün" → dünün 00:00-23:59 aralığı. "Geçen Cuma" → en son Cuma'nın tarihi. Bugünün tarihini referans al. Tarih belirtilmemişse parametreleri boş bırak."""


# ─── Knowledge Base Search ────────────────────────────────────────────────────
async def search_knowledge_base(query: str, category: str | None = None, date_from: str | None = None, date_to: str | None = None) -> str:
    """Search the KB via Supabase RPC and return formatted results."""
    if not KB_ENABLED or not supabase or not openai_client:
        return "Bilgi tabanı devre dışı."

    try:
        # Create embedding
        embed_response = openai_client.embeddings.create(
            model=KB_EMBEDDING_MODEL,
            input=query,
        )
        query_embedding = embed_response.data[0].embedding

        # Search via Supabase RPC
        rpc_params = {
            "query_embedding": json.dumps(query_embedding),
            "match_threshold": KB_MATCH_THRESHOLD,
            "match_count": KB_MATCH_COUNT,
            "filter_category": category,
            "filter_date_from": date_from,
            "filter_date_to": date_to,
        }
        result = supabase.rpc("search_knowledge_base", rpc_params).execute()

        data = result.data or []
        logger.info(f'[kb] Search: query="{query}", results={len(data)}')

        if not data:
            return (
                "Bilgi tabanında bu konuyla ilgili bir kayıt bulunamadı. "
                "Kendi bilginle kısa ve dürüst bir cevap ver."
            )

        parts = []
        for i, r in enumerate(data):
            similarity_pct = round(r.get("similarity", 0) * 100)
            title = r.get("document_title", "?")
            cat_name = r.get("category_name", "?")
            content = r.get("content", "")
            parts.append(
                f"[Kaynak {i + 1}: {title} ({cat_name}, benzerlik: {similarity_pct}%)]:\n{content}"
            )
        return "\n\n---\n\n".join(parts)

    except Exception as e:
        logger.error(f"[kb] Search error: {e}")
        return "Bilgi tabanı aramasında bir hata oluştu. Kendi bilginle cevap ver."


# ─── Handle tool calls from OpenAI ───────────────────────────────────────────
async def handle_tool_call(openai_ws, msg: dict):
    """Process a completed function call and send the result back to OpenAI."""
    call_id = msg.get("call_id")
    name = msg.get("name")
    raw_args = msg.get("arguments", "{}")

    logger.info(f"[relay] Tool call: {name} — {raw_args}")

    tool_result = f"Bilinmeyen araç: {name}"

    if name == "search_knowledge_base":
        try:
            args = json.loads(raw_args)
            tool_result = await search_knowledge_base(
                args.get("query", ""),
                args.get("category"),
                args.get("date_from"),
                args.get("date_to"),
            )
        except Exception as e:
            logger.error(f"[relay] KB search error: {e}")
            tool_result = "Bilgi tabanı aramasında bir hata oluştu. Kendi bilginle cevap ver."

    # Send function_call_output back to OpenAI
    await openai_ws.send(
        json.dumps(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": tool_result,
                },
            }
        )
    )

    # Trigger a new response
    await openai_ws.send(json.dumps({"type": "response.create"}))
    logger.info(f"[relay] Tool response sent for call_id={call_id}")


# ─── OpenAI Connection ───────────────────────────────────────────────────────
async def connect_to_openai():
    """Connect to OpenAI's Realtime WebSocket endpoint."""
    uri = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"

    ws = await connect(
        uri,
        extra_headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
            "OpenAI-Beta": "realtime=v1",
        },
        subprotocols=["realtime"],
    )
    logger.info("Successfully connected to OpenAI")

    response = await ws.recv()
    event = json.loads(response)
    if event.get("type") != "session.created":
        raise Exception(f"Expected session.created, got {event.get('type')}")
    logger.info("Received session.created response")

    # ── Session update — THIS IS THE CRITICAL PART ──
    session_config = {
        "type": "session.update",
        "session": {
            "model": "gpt-4o-realtime-preview",
            "modalities": ["text", "audio"],  # ← ZORUNLU — bu olmadan ses üretilmez
            "voice": "shimmer",
            "instructions": INSTRUCTIONS,
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 600,
            },
            "input_audio_transcription": {
                "model": "whisper-1",
            },
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
        },
    }

    # Add tools if KB is enabled
    if KB_ENABLED:
        session_config["session"]["tools"] = TOOLS

    await ws.send(json.dumps(session_config))
    logger.info(
        f"Sent session.update {'(with KB tools)' if KB_ENABLED else '(no KB)'}"
    )

    return ws, event


# ─── WebSocket Relay ──────────────────────────────────────────────────────────
class WebSocketRelay:
    def __init__(self):
        self.connections: dict = {}
        self.message_queues: dict = {}

    async def handle_browser_connection(
        self, websocket: WebSocketServerProtocol, path: str
    ):
        base_path = path.split("?")[0]
        if base_path != "/":
            logger.error(f"Invalid path: {path}")
            await websocket.close(1008, "Invalid path")
            return

        logger.info(f"Browser connected from {websocket.remote_address}")
        self.message_queues[websocket] = []
        openai_ws = None

        try:
            openai_ws, session_created = await connect_to_openai()
            self.connections[websocket] = openai_ws

            # Forward session.created to browser
            await websocket.send(json.dumps(session_created))
            logger.info("Forwarded session.created to browser")

            # Drain queued messages
            while self.message_queues[websocket]:
                message = self.message_queues[websocket].pop(0)
                try:
                    event = json.loads(message)
                    logger.info(f'Relaying "{event.get("type")}" to OpenAI')
                    await openai_ws.send(message)
                except json.JSONDecodeError:
                    logger.error(f"Invalid JSON from browser: {message}")

            async def handle_browser_messages():
                try:
                    while True:
                        message = await websocket.recv()
                        try:
                            event = json.loads(message)
                            logger.info(f'Relaying "{event.get("type")}" to OpenAI')
                            await openai_ws.send(message)
                        except json.JSONDecodeError:
                            logger.error(f"Invalid JSON from browser: {message}")
                except websockets.exceptions.ConnectionClosed as e:
                    logger.info(
                        f"Browser connection closed: code={e.code}, reason={e.reason}"
                    )
                    raise

            async def handle_openai_messages():
                try:
                    while True:
                        raw = await openai_ws.recv()
                        try:
                            msg = json.loads(raw)
                            msg_type = msg.get("type", "")

                            # ── Intercept completed tool calls ──
                            if msg_type == "response.function_call_arguments.done":
                                await handle_tool_call(openai_ws, msg)
                                continue  # Don't forward to client

                            # ── Suppress noisy tool-call events ──
                            if msg_type in SUPPRESS_EVENTS:
                                continue

                            # ── Forward everything else to browser ──
                            if websocket.open:
                                await websocket.send(raw)

                        except json.JSONDecodeError:
                            logger.error(f"Invalid JSON from OpenAI: {raw[:200]}")
                except websockets.exceptions.ConnectionClosed as e:
                    logger.info(
                        f"OpenAI connection closed: code={e.code}, reason={e.reason}"
                    )
                    raise

            try:
                await asyncio.gather(
                    handle_browser_messages(), handle_openai_messages()
                )
            except websockets.exceptions.ConnectionClosed:
                logger.info("One of the connections closed, cleaning up")

        except Exception as e:
            logger.error(f"Error handling connection: {str(e)}")
            if not websocket.closed:
                await websocket.close(1011, str(e))
        finally:
            if websocket in self.connections:
                if openai_ws and not openai_ws.closed:
                    await openai_ws.close(1000, "Normal closure")
                del self.connections[websocket]
            if websocket in self.message_queues:
                del self.message_queues[websocket]
            if not websocket.closed:
                await websocket.close(1000, "Normal closure")

    async def serve(self):
        async with serve(
            self.handle_browser_connection,
            "0.0.0.0",
            PORT,
            ping_interval=20,
            ping_timeout=20,
            subprotocols=["realtime"],
        ):
            logger.info(f"WebSocket relay server started on ws://0.0.0.0:{PORT}")
            logger.info(f"Knowledge base: {'ENABLED' if KB_ENABLED else 'DISABLED'}")
            await asyncio.Future()


def main():
    relay = WebSocketRelay()
    try:
        asyncio.run(relay.serve())
    except KeyboardInterrupt:
        logger.info("Server shutdown requested")
    finally:
        logger.info("Server shutdown complete")


if __name__ == "__main__":
    main()