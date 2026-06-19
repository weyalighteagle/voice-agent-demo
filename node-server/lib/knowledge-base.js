import supabase from "./supabase.js";
import { createEmbedding } from "./embeddings.js";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function searchKnowledgeBase(query, { date_from = null, date_to = null, meeting_type = null, projectId = null, userEmail = null } = {}) {
  if (!supabase) {
    console.warn("[kb] Supabase client not initialized");
    return [];
  }

  const t0 = Date.now();
  const queryEmbedding = await createEmbedding(query);
  const tEmbed = Date.now();

  console.log(`[kb] Embedding length=${queryEmbedding.length}`);

  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const matchCount = 15;
  // 0.3 threshold — lowered from 0.5; date-filtered queries (e.g. specific meeting days) hit 0.48-0.51 similarity
  const matchThreshold = 0.3;

  const rpcParams = {
    query_embedding: embeddingStr,
    match_threshold: matchThreshold,
    match_count: matchCount,
    filter_date_from: date_from || null,
    filter_date_to: date_to || null,
    filter_meeting_type: meeting_type || null,
    p_org_id: null,
  };

  if (projectId) {
    rpcParams.filter_project_id = projectId;
  }

  const { data, error } = await supabase.rpc("search_knowledge_base", rpcParams);

  const tSearch = Date.now();
  const kbMode = projectId ? "project" : "none";
  console.log(
    `[kb] Search: mode=${kbMode}, embed=${tEmbed - t0}ms, search=${tSearch - tEmbed}ms, total=${tSearch - t0}ms, ` +
    `results=${data?.length ?? 0}, threshold=${matchThreshold}, matchCount=${matchCount}, ` +
    `projectId=${projectId || "none"}, meeting_type=${meeting_type || "none"}, ` +
    `date_from=${date_from || "none"}, date_to=${date_to || "none"}, ` +
    `error=${error ? JSON.stringify(error) : "none"}`
  );

  if (data?.length > 0) {
    data.forEach((r, i) => {
      const dateTag = r.meeting_date ? new Date(r.meeting_date).toLocaleDateString("tr-TR") : "?";
      console.log(`[kb]   [${i + 1}] similarity=${(r.similarity * 100).toFixed(1)}% | ${r.source_type || "?"} | ${r.document_title} (${dateTag})`);
    });
  }

  if (error) {
    console.error("[kb] Search error:", error);
    return [];
  }

  let results = data || [];

  // Attribution filtering for shared project results (Option B)
  if (userEmail && results.length > 0) {
    results = results.map((result) => {
      if (result.contributor_email && result.contributor_email !== userEmail) {
        let filteredContent = result.content;
        filteredContent = filteredContent.replace(new RegExp(escapeRegex(result.contributor_email), 'gi'), 'bir takım üyesi');

        // Also strip contributor name from content if it appears
        // (contributor name might be part of the email prefix)
        const emailPrefix = result.contributor_email.split('@')[0];
        if (emailPrefix.length > 2) {
          filteredContent = filteredContent.replace(new RegExp(escapeRegex(emailPrefix), 'gi'), 'bir takım üyesi');
        }

        return {
          ...result,
          content: filteredContent,
          contributor_email: null, // strip identity
          brokerableConnection: true,
          original_contributor_email: result.contributor_email, // keep for introduction request
          original_document_title: result.document_title,
          original_content_snippet: result.content.substring(0, 300),
        };
      }
      return { ...result, brokerableConnection: false };
    });
  }

  return results;
}

export function formatKBResults(results) {
  if (!results || results.length === 0) {
    return "Bilgi tabanında bu konuyla ilgili hiçbir sonuç bulunamadı. Kullanıcıya 'Bu konuda bilgi tabanımda kayıt bulamadım' de.";
  }

  // De-prioritize test meetings: if real results exist, exclude test-titled docs
  const hasNonTestResults = results.some(r =>
    !r.document_title?.toLowerCase().includes("test")
  );
  const filtered = hasNonTestResults
    ? results.filter(r => !r.document_title?.toLowerCase().includes("test"))
    : results;

  if (filtered.length < results.length) {
    console.log(`[kb] formatKBResults: excluded ${results.length - filtered.length} test meeting(s) from output`);
  }

  const bestSimilarity = Math.max(...filtered.map(r => r.similarity || 0));

  let header;
  if (bestSimilarity >= 0.5) {
    header = `[YÜKSEK EŞLEŞME — ${filtered.length} sonuç bulundu. Bu sonuçlar soruyla yüksek oranda ilgili. Aşağıdaki bilgileri kullanarak DETAYLI ve DOĞRU bir cevap ver.]\n\n`;
  } else if (bestSimilarity >= 0.3) {
    header = `[ORTA EŞLEŞME — ${filtered.length} sonuç bulundu. Sonuçlar kısmen ilgili olabilir. Aşağıdaki sonuçları DİKKATLİCE oku. İlgili bilgi varsa cevabına dahil et. Sadece sonuçlarda HİÇBİR ilgili bilgi yoksa 'bulamadım' de. Kısmi bilgi bile olsa paylaş.]\n\n`;
  } else {
    header = `[DÜŞÜK EŞLEŞME — ${filtered.length} sonuç bulundu, ancak benzerlik düşük. Yine de sonuçları kontrol et, dolaylı bilgi olabilir.]\n\n`;
  }

  const formatted = filtered
    .map((r, i) => {
      const sim = ((r.similarity || 0) * 100).toFixed(0);
      const rawDate = r.meeting_date ? new Date(r.meeting_date) : null;
      const dateStr = rawDate && rawDate.getFullYear() >= 2020
        ? rawDate.toLocaleDateString("tr-TR", { year: "numeric", month: "long", day: "numeric", weekday: "long" })
        : "⚠️ Tarih bilinmiyor";

      if (r.brokerableConnection) {
        // Brokered result — anonymized attribution (Option B)
        return `[Kaynak ${i + 1} | Paylaşılan bilgi — bir takım üyesi | ${dateStr} | Benzerlik: %${sim}]:\n${r.content}\n⚡ brokerableConnection=true`;
      }

      const type = r.source_type === "transcript" ? "📋 Toplantı Kaydı" : "📄 Şirket Dokümanı";
      return `[Kaynak ${i + 1} | ${type} | ${r.document_title} | ${dateStr} | Benzerlik: %${sim}]:\n${r.content}`;
    })
    .join("\n\n---\n\n");

  return header + formatted;
}
