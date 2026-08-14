export default async function handler(req, res) {
  try {
    // ==========================================
    // Google News RSS
    // ==========================================

    const rssUrl =
      "https://news.google.com/rss/search?q=Bangladesh&hl=bn&gl=BD&ceid=BD:bn";

    const response = await fetch(rssUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        error: "News source could not be reached."
      });
    }

    const xml = await response.text();

    // ==========================================
    // Extract RSS items
    // ==========================================

    const matches = [
      ...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)
    ];

    const items = matches
      .slice(0, 10)
      .map((match) => {
        const item = match[1];

        const title =
          extractTag(item, "title");

        const link =
          extractTag(item, "link");

        const pubDate =
          extractTag(item, "pubDate");

        const source =
          extractTag(item, "source");

        return {
          title: decodeHtml(title).trim(),
          link: decodeHtml(link).trim(),
          pubDate: pubDate.trim(),
          source: decodeHtml(source).trim()
        };
      })
      .filter((item) => item.title && item.link);

    // ==========================================
    // Remove duplicate titles inside this response
    // ==========================================

    const uniqueItems = [];
    const seenTitles = new Set();

    for (const item of items) {
      const normalizedTitle = normalizeTitle(item.title);

      if (seenTitles.has(normalizedTitle)) {
        continue;
      }

      seenTitles.add(normalizedTitle);
      uniqueItems.push(item);
    }

    // ==========================================
    // Final response
    // ==========================================

    return res.status(200).json({
      success: true,
      category: "জাতীয়",
      count: uniqueItems.length,
      news: uniqueItems
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "News collector failed.",
      details: error.message
    });
  }
}


// ==========================================
// Extract XML tag
// ==========================================

function extractTag(xml, tagName) {
  const regex = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );

  return xml.match(regex)?.[1] || "";
}


// ==========================================
// Normalize title
// ==========================================

function normalizeTitle(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}


// ==========================================
// Decode HTML entities
// ==========================================

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/");
}
