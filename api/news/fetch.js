export default async function handler(req, res) {
  try {
    const rssUrl =
      "https://news.google.com/rss/search?q=Bangladesh&hl=bn&gl=BD&ceid=BD:bn";

    const response = await fetch(rssUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 Odhikar-TV-News-Bot"
      }
    });

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        error: "News source could not be reached."
      });
    }

    const xml = await response.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .slice(0, 10)
      .map((match) => {
        const item = match[1];

        const title =
          getTag(item, "title");

        const link =
          getTag(item, "link");

        const pubDate =
          getTag(item, "pubDate");

        const sourceMatch =
          item.match(
            /<source[^>]*>([\s\S]*?)<\/source>/i
          );

        const source =
          sourceMatch
            ? decodeHtml(sourceMatch[1])
            : "";

        // Try RSS media:content
        const mediaContentMatch =
          item.match(
            /<media:content[^>]+url=["']([^"']+)["'][^>]*>/i
          );

        // Try RSS media:thumbnail
        const mediaThumbnailMatch =
          item.match(
            /<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*>/i
          );

        // Try enclosure
        const enclosureMatch =
          item.match(
            /<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i
          );

        let imageUrl = "";

        if (mediaContentMatch?.[1]) {
          imageUrl = mediaContentMatch[1];
        } else if (mediaThumbnailMatch?.[1]) {
          imageUrl = mediaThumbnailMatch[1];
        } else if (enclosureMatch?.[1]) {
          imageUrl = enclosureMatch[1];
        }

        return {
          title: decodeHtml(title),
          link: decodeHtml(link),
          pubDate,
          source,
          image_url: imageUrl
            ? decodeHtml(imageUrl)
            : ""
        };
      });

    return res.status(200).json({
      success: true,
      category: "জাতীয়",
      count: items.length,
      news: items
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
// Get XML tag value
// ==========================================

function getTag(text, tag) {
  const match = text.match(
    new RegExp(
      `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    )
  );

  return match?.[1] || "";
}


// ==========================================
// Decode HTML entities
// ==========================================

function decodeHtml(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/");
}
