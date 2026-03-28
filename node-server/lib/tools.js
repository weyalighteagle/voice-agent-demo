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
            "Arama yapılacak kategori. ZORUNLUDUR, boş bırakma. Seçim rehberi: 'company_docs' → şirket dökümanları, politikalar, süreçler, genel şirket bilgisi; 'faq' → sık sorulan sorular, fiyatlandırma, ürün/hizmet detayları; 'crm' → müşteri bilgileri, müşteri geçmişi, ilişki yönetimi; 'transcripts' → geçmiş toplantılar, önceki görüşmeler, konuşma kayıtları. Emin değilsen 'company_docs' seç.",
        },
        date_from: {
          type: "string",
          description:
            "Başlangıç tarihi (ISO 8601 format, örn: '2026-03-27T00:00:00Z'). " +
            "Kullanıcı 'geçen hafta', 'dün', 'geçen Cuma' gibi ifadeler kullandığında " +
            "bugünün tarihini referans alarak uygun ISO tarihini hesapla. " +
            "Tarih belirtilmemişse bu parametreyi gönderme.",
        },
        date_to: {
          type: "string",
          description:
            "Bitiş tarihi (ISO 8601 format, örn: '2026-03-28T23:59:59Z'). " +
            "Kullanıcı 'geçen hafta' derse haftanın son gününü, 'dün' derse dünün sonunu yaz. " +
            "Tarih belirtilmemişse bu parametreyi gönderme.",
        },
      },
      required: ["query", "category"],
    },
  },
];
