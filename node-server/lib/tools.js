export const TOOLS = [
  {
    type: "function",
    name: "search_knowledge_base",
    description:
      "Şirket bilgi tabanında ve toplantı kayıtlarında arama yapar. İKİ TÜR İÇERİK ARAR:\n" +
      "1. Şirket dokümanları (şirket bilgileri, ürünler, fiyatlandırma, politikalar)\n" +
      "2. Toplantı kayıtları (geçmiş toplantılarda konuşulanlar)\n\n" +
      "KRİTİK: Şirket, ekip, ürünler, yatırımlar, müşteriler veya toplantılar hakkında HERHANGİ bir soru sorulduğunda bu aracı MUTLAKA çağır. Aracı çağırmadan bu konularda ASLA cevap verme — kendi bilgine güvenme, her zaman bilgi tabanını ara.\n\n" +
      "KULLANIM REHBERİ:\n" +
      "- Şirket hakkında soru → category='company_docs' veya 'faq'\n" +
      "- Belirli bir toplantı türü hakkında soru → meeting_type parametresini kullan\n" +
      "- Tarihli toplantı hakkında soru → category='transcripts' + date_from/date_to kullan\n" +
      "- Bir konu hakkında hangi toplantılarda konuşulduğu → category kullanMA, sadece query yaz\n" +
      "- Müşteri bilgisi → category='crm'\n" +
      "- Ekip üyeleri, görevler, roller hakkında soru → category KULLANMA (hem dokümanlarda hem toplantılarda olabilir)\n\n" +
      "ÖNEMLİ: Tarih filtresi kullandığında date_from ve date_to'yu birlikte kullan.\n" +
      "Eğer ilk aramada istediğin sonucu bulamazsan, farklı anahtar kelimelerle veya farklı parametrelerle tekrar ara. Tek aramada bulamazsan HEMEN vazgeçme.\n" +
      "Genel kültür veya gündelik sohbet soruları için bu aracı KULLANMA.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Aranacak sorgu metni. Kullanıcının asıl sorusunun KONUSUNU yaz — meta-açıklama değil, spesifik içerik. " +
            "ÖNEMLİ: Sorguya 'dün', 'bugün' gibi zaman ifadeleri KOYMA — bunları date_from/date_to ile filtrele. " +
            "YANLIŞ: 'gündem konuları tartışmalar kararlar' (generik, her toplantıyla eşleşir). " +
            "DOĞRU: 'yapay zeka takım toplantısı konuşulan konular kararlar'. " +
            "DOĞRU: 'Gülfem görev aksiyon atanan işler'. " +
            "Kişi-spesifik sorularda kişinin adını query'ye DAHİL ET.",
        },
        category: {
          type: "string",
          enum: ["company_docs", "faq", "crm", "transcripts"],
          description:
            "Opsiyonel kategori filtresi. Sadece kesin olduğunda kullan. " +
            "Emin değilsen bu parametreyi GÖNDERMEKSİZİN bırak — tüm kategorilerde aranır. " +
            "Seçenekler: 'company_docs' → şirket dökümanları; 'faq' → ürün bilgisi; " +
            "'crm' → müşteri bilgileri; 'transcripts' → toplantı kayıtları.",
        },
        meeting_type: {
          type: "string",
          description:
            "Toplantı türü filtresi (snake_case, Türkçe karaktersiz). Sadece category='transcripts' ile kullan. " +
            "Kullanıcı belirli bir toplantı türünden bahsediyorsa MUTLAKA doldur. " +
            "Eşleştirme tablosu: " +
            "'yapay zeka takım toplantısı' / 'yapay zeka toplantısı' / 'AI toplantısı' / 'haftalık toplantı' → 'light_eagle_yapay_zeka_takim_toplantisi'. " +
            "'coherus toplantısı' → 'coherus_toplanti'. " +
            "Kullanıcı sadece 'geçen toplantı' veya 'toplantı' diyorsa ve tür belirtmiyorsa → bu parametreyi GÖNDERME.",
        },
        date_from: {
          type: "string",
          description:
            "Aramanın başlangıç tarihi (ISO 8601). Belirli bir zaman aralığındaki toplantıları aramak için kullan. " +
            "Kullanıcı 'geçen hafta', 'dün', 'geçen Cuma' gibi ifadeler kullandığında " +
            "bugünün tarihini referans alarak uygun ISO tarihini hesapla. " +
            "Örnek: '2025-01-01T00:00:00Z'. Tarih belirtilmemişse bu parametreyi gönderme.",
        },
        date_to: {
          type: "string",
          description:
            "Aramanın bitiş tarihi (ISO 8601). " +
            "Kullanıcı 'geçen hafta' derse haftanın son gününü, 'dün' derse dünün sonunu yaz. " +
            "Örnek: '2025-01-31T23:59:59Z'. Tarih belirtilmemişse bu parametreyi gönderme.",
        },
      },
      required: ["query", "category"],
    },
  },
];
