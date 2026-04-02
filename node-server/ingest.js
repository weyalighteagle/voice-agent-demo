import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function chunkText(text, maxChars = 2000, overlapChars = 400) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let currentChunk = "";
  for (const para of paragraphs) {
    if (currentChunk.length + para.length + 2 > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      const overlapStart = Math.max(0, currentChunk.length - overlapChars);
      currentChunk = currentChunk.slice(overlapStart) + "\n\n" + para;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
}

async function createEmbeddings(texts) {
  const batchSize = 100;
  const allEmbeddings = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await openai.embeddings.create({
      model: process.env.KB_EMBEDDING_MODEL || "text-embedding-3-small",
      input: batch,
    });
    allEmbeddings.push(...response.data.map((d) => d.embedding));
  }
  return allEmbeddings;
}

async function ingest({ title, category, text, filePath, botId }) {
  let content;
  if (botId) {
    const { data } = await supabase
      .from("utterances")
      .select("speaker, words")
      .eq("bot_id", botId)
      .order("timestamp", { ascending: true });
    if (!data?.length) throw new Error(`No transcript for bot ${botId}`);
    content = data.map((row) => {
      const t = Array.isArray(row.words) ? row.words.map((w) => w.text).join(" ") : "";
      return `${row.speaker}: ${t}`;
    }).join("\n");
  } else if (filePath) {
    content = readFileSync(filePath, "utf-8");
  } else if (text) {
    content = text;
  } else {
    throw new Error("--text, --file, veya --bot-id gerekli");
  }

  const contentHash = createHash("sha256").update(content).digest("hex");
  const { data: existing } = await supabase
    .from("kb_documents").select("id").eq("content_hash", contentHash).maybeSingle();
  if (existing) {
    console.log(`Doküman zaten mevcut (id: ${existing.id}). Atlanıyor.`);
    return;
  }

  const { data: cat } = await supabase
    .from("kb_categories").select("id").eq("name", category).single();
  if (!cat) throw new Error(`Kategori bulunamadı: ${category}`);

  const { data: doc, error: docErr } = await supabase
    .from("kb_documents")
    .insert({ title, category_id: cat.id, source_type: botId ? "transcript" : filePath ? "file" : "manual", content_hash: contentHash, metadata: { botId, filePath } })
    .select("id").single();
  if (docErr) throw docErr;
  console.log(`Doküman oluşturuldu: ${doc.id}`);

  const chunks = chunkText(content);
  console.log(`${chunks.length} chunk oluşturuldu`);

  // Prepend document title to each chunk for better semantic search
  // This ensures title keywords (meeting names, company names, dates) are in the vector space
  const chunksWithTitle = chunks.map(chunk => `[${title}]\n\n${chunk}`);

  console.log("Embedding'ler oluşturuluyor...");
  const embeddings = await createEmbeddings(chunksWithTitle);

  // When creating the rows to insert, use chunksWithTitle instead of chunks:
  const rows = chunks.map((chunk, i) => ({
    document_id: doc.id,
    chunk_index: i,
    content: `[${title}]\n\n${chunk}`,  // Store with title prefix
    token_count: Math.ceil(chunk.length / 4),
    embedding: JSON.stringify(embeddings[i]),
  }));

  const { error: chunkErr } = await supabase.from("kb_chunks").insert(rows);
  if (chunkErr) throw chunkErr;
  console.log(`✅ "${title}" başarıyla yüklendi (${chunks.length} chunk, ${content.length} karakter)`);
}

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

ingest({
  title: getArg("title") || "Untitled",
  category: getArg("category") || "company_docs",
  text: getArg("text"),
  filePath: getArg("file"),
  botId: getArg("bot-id"),
}).catch((err) => { console.error("❌ Ingest hatası:", err.message); process.exit(1); });
