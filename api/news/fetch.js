export default async function handler(req, res) {
  try {
    // First RSS source for testing
    const rssUrl =
      "https://news.google.com/rss/search?q=Bangladesh&hl=bn&gl=BD&ceid=BD:bn";

    const response = await fetch(rssUrl);

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        error: "News source could not be reached."
      });
    }

    const xml = await response.text();

    // Extract RSS items
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .slice(0, 10)
      .map((match) => {
        const item = match[1];

        const title =
          item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "";

        const link =
          item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "";

        const pubDate =
          item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "";

        const source =
          item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "";

        return {
          title: decodeHtml(title),
          link: decodeHtml(link),
          pubDate,
          source: decodeHtml(source)
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
      error: "News collector failed."
    });
  }
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
