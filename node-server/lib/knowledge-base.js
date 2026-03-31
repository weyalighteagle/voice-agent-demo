import supabase from "./supabase.js";
import { createEmbedding } from "./embeddings.js";

const KB_MATCH_THRESHOLD = parseFloat(process.env.KB_MATCH_THRESHOLD || "0.3");
const KB_MATCH_COUNT = parseInt(process.env.KB_MATCH_COUNT || "5", 10);

export async function searchKnowledgeBase(query, { category = null, date_from = null, date_to = null, meeting_title = null } = {}) {
  if (!supabase) {
    console.warn("[kb] Supabase client not initialized");
    return [];
  }

  const t0 = Date.now();
  const queryEmbedding = await createEmbedding(query);
  const tEmbed = Date.now();

  console.log(`[kb] Embedding length=${queryEmbedding.length}`);

  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  // Lower threshold when a date or meeting_title filter is present — these
  // filters already narrow the result set so we don't need strict semantic similarity.
  const hasContextFilter = date_from || date_to || meeting_title;
  const effectiveThreshold = hasContextFilter
    ? Math.min(KB_MATCH_THRESHOLD, 0.1)
    : KB_MATCH_THRESHOLD;

  // Always send ALL parameters so Supabase can match the function signature by name.
  const rpcParams = {
    query_embedding: embeddingStr,
    match_threshold: effectiveThreshold,
    match_count: KB_MATCH_COUNT,
    filter_category: (category !== null && category !== undefined && category !== "") ? category : null,
    date_from: date_from || null,
    date_to: date_to || null,
    filter_meeting_title: meeting_title || null,
  };

  const { data, error } = await supabase.rpc(
    "search_knowledge_base",
    rpcParams
  );

  const tSearch = Date.now();
  console.log(
    `[kb] Search: embed=${tEmbed - t0}ms, search=${tSearch - tEmbed}ms, total=${tSearch - t0}ms, ` +
    `results=${data?.length ?? 0}, threshold=${effectiveThreshold}${hasContextFilter ? " (lowered)" : ""}, ` +
    `category=${category || "ALL"}, meeting_title=${meeting_title || "none"}, ` +
    `date_from=${date_from || "none"}, date_to=${date_to || "none"}, ` +
    `error=${error ? JSON.stringify(error) : "none"}`
  );

  if (data?.length > 0) {
    data.forEach((r, i) => {
      const dateTag = r.created_at ? new Date(r.created_at).toLocaleDateString("tr-TR") : "?";
      console.log(`[kb]   [${i + 1}] similarity=${(r.similarity * 100).toFixed(1)}% | ${r.source_type || "?"} | ${r.document_title} (${dateTag})`);
    });
  }

  if (error) {
    console.error("[kb] Search error:", error);
    return [];
  }

  return data || [];
}

export function formatKBResults(results) {
  if (!results || results.length === 0) {
    return "Bilgi tabanında bu konuyla ilgili hiçbir sonuç bulunamadı. Kullanıcıya 'Bu konuda bilgi tabanımda kayıt bulamadım' de.";
  }

  const bestSimilarity = Math.max(...results.map(r => r.similarity || 0));

  let header;
  if (bestSimilarity >= 0.5) {
    header = `[YÜKSEK EŞLEŞME — ${results.length} sonuç bulundu. Bu sonuçlar soruyla yüksek oranda ilgili. Aşağıdaki bilgileri kullanarak DETAYLI ve DOĞRU bir cevap ver.]\n\n`;
  } else if (bestSimilarity >= 0.3) {
    header = `[ORTA EŞLEŞME — ${results.length} sonuç bulundu. Sonuçlar kısmen ilgili olabilir. Aşağıdaki sonuçları DİKKATLİCE oku. İlgili bilgi varsa cevabına dahil et. Sadece sonuçlarda HİÇBİR ilgili bilgi yoksa 'bulamadım' de. Kısmi bilgi bile olsa paylaş.]\n\n`;
  } else {
    header = `[DÜŞÜK EŞLEŞME — ${results.length} sonuç bulundu, ancak benzerlik düşük. Yine de sonuçları kontrol et, dolaylı bilgi olabilir.]\n\n`;
  }

  const formatted = results
    .map((r, i) => {
      const sim = ((r.similarity || 0) * 100).toFixed(0);
      const type = r.source_type === "transcript" ? "📋 Toplantı Kaydı" : "📄 Şirket Dokümanı";
      const rawDate = r.created_at ? new Date(r.created_at) : null;
      const dateStr = rawDate && rawDate.getFullYear() >= 2020
        ? rawDate.toLocaleDateString("tr-TR", { year: "numeric", month: "long", day: "numeric", weekday: "long" })
        : "⚠️ Tarih bilinmiyor";
      return `[Kaynak ${i + 1} | ${type} | ${r.document_title} | ${dateStr} | Benzerlik: %${sim}]:\n${r.content}`;
    })
    .join("\n\n---\n\n");

  return header + formatted;
}
