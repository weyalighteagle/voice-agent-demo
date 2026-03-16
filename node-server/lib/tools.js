export const TOOLS = [
  {
    type: "function",
    name: "search_knowledge_base",
    description:
      "Şirket bilgi tabanında arama yapar. Şirket, ürünler, fiyatlandırma, politikalar, müşteri bilgileri veya önceki toplantılar hakkında soru sorulduğunda bu aracı kullan. Genel kültür veya gündelik sohbet soruları için KULLANMA.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Aranacak sorgu metni. Kullanıcının sorusunun kısa ve net bir özeti.",
        },
        category: {
          type: "string",
          enum: ["company_docs", "faq", "crm", "transcripts"],
          description:
            "Opsiyonel kategori filtresi. Emin değilsen boş bırak.",
        },
      },
      required: ["query"],
    },
  },
];
