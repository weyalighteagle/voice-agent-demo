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
            "Arama yapılacak kategori. ZORUNLUDUR, boş bırakma. Seçim KURALLARI (sırayla kontrol et):\n" +
            "1. Kullanıcı 'toplantı', 'görüşme', 'konuştuk', 'geçen hafta ne dedik', 'daha önce bahsetmiştik' gibi ifadeler kullanıyorsa → 'transcripts'\n" +
            "2. Kullanıcı bir müşteri adı, firma adı soruyor veya 'müşteri', 'firma', 'portföy', 'iletişim bilgisi' diyorsa → 'crm'\n" +
            "3. Kullanıcı 'fiyat', 'ücret', 'nasıl yapılır', 'süreç nedir', 'sık sorulan' diyorsa → 'faq'\n" +
            "4. Yukarıdakilerin hiçbiri uymuyorsa → 'company_docs'",
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
