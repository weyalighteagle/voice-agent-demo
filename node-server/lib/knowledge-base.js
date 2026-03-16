import supabase from "./supabase.js";
import { createEmbedding } from "./embeddings.js";

export async function searchKnowledgeBase(query, category = null) {
  const t0 = Date.now();
  const queryEmbedding = await createEmbedding(query);
  const tEmbed = Date.now();

  const { data, error } = await supabase.rpc("search_knowledge_base", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_threshold: parseFloat(process.env.KB_MATCH_THRESHOLD || "0.7"),
    match_count: parseInt(process.env.KB_MATCH_COUNT || "5"),
    filter_category: category,
  });
  const tSearch = Date.now();

  console.log(
    `[kb] Search completed: embed=${tEmbed - t0}ms, search=${tSearch - tEmbed}ms, total=${tSearch - t0}ms, results=${data?.length ?? 0}`
  );

  if (error) {
    console.error("[kb] Search error:", error);
    return [];
  }
  return data || [];
}

export function formatKBResults(results) {
  if (!results || results.length === 0) {
    return "Bilgi tabanında bu konuyla ilgili bir kayıt bulunamadı. Kendi bilginle kısa ve dürüst bir cevap ver.";
  }

  return results
    .map(
      (r, i) =>
        `[Kaynak ${i + 1}: ${r.document_title} (${r.category_name}, benzerlik: ${(r.similarity * 100).toFixed(0)}%)]:\n${r.content}`
    )
    .join("\n\n---\n\n");
}
