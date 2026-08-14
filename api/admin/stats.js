export default async function handler(req, res) {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  // ==========================================
  // 1. Check Redis environment variables
  // ==========================================

  if (!redisUrl || !redisToken) {
    return res.status(500).json({
      success: false,
      error: "Redis environment variables are missing."
    });
  }

  // ==========================================
  // 2. Allow GET only
  // ==========================================

  if (req.method && req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed."
    });
  }

  try {
    // ==========================================
    // 3. Get all news draft keys
    // ==========================================

    const keys = await scanAllKeys(
      redisUrl,
      redisToken,
      "news:draft:*"
    );

    if (!keys.length) {
      return res.status(200).json({
        success: true,
        total: 0,
        published: 0,
        drafts: 0,
        review: 0,
        news: []
      });
    }

    // ==========================================
    // 4. Get all news records
    // ==========================================

    const news = [];

    for (const key of keys) {
      const response = await redisCommand(
        redisUrl,
        redisToken,
        ["GET", key]
      );

      if (response.error || !response.result) {
        continue;
      }

      try {
        const article =
          typeof response.result === "string"
            ? JSON.parse(response.result)
            : response.result;

        if (!article || typeof article !== "object") {
          continue;
        }

        news.push({
          key,

          title:
            typeof article.title === "string"
              ? article.title
              : "",

          summary:
            typeof article.summary === "string"
              ? article.summary
              : "",

          category:
            typeof article.category === "string" &&
            article.category.trim()
              ? article.category
              : "অন্যান্য",

          source:
            typeof article.source === "string"
              ? article.source
              : "",

          source_url:
            typeof article.source_url === "string"
              ? article.source_url
              : "",

          status:
            typeof article.status === "string"
              ? article.status
              : "draft",

          created_at:
            article.created_at || null,

          published_at:
            article.published_at || null,

          blogger_post_id:
            article.blogger_post_id || null,

          blogger_url:
            article.blogger_url || null
        });

      } catch {
        // Ignore invalid Redis records
        continue;
      }
    }

    // ==========================================
    // 5. Statistics
    // ==========================================

    const total = news.length;

    const published = news.filter(
      item => item.status === "published"
    ).length;

    const drafts = news.filter(
      item => item.status === "draft"
    ).length;

    const review = news.filter(
      item =>
        item.status === "review" ||
        item.status === "safety_review_required"
    ).length;

    // ==========================================
    // 6. Category statistics
    // ==========================================

    const categories = {};

    for (const item of news) {
      const category = item.category || "অন্যান্য";

      categories[category] =
        (categories[category] || 0) + 1;
    }

    // ==========================================
    // 7. Newest news first
    // ==========================================

    news.sort((a, b) => {
      const dateA = new Date(
        a.created_at || 0
      ).getTime();

      const dateB = new Date(
        b.created_at || 0
      ).getTime();

      return dateB - dateA;
    });

    // ==========================================
    // 8. Return dashboard statistics
    // ==========================================

    return res.status(200).json({
      success: true,

      total,
      published,
      drafts,
      review,

      categories,

      news: news.slice(0, 50)
    });

  } catch (error) {
    console.error(
      "Admin statistics error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Admin statistics failed.",
      details: error.message
    });
  }
}


// ==========================================
// Scan ALL matching Redis keys
// ==========================================

async function scanAllKeys(
  url,
  token,
  pattern
) {
  const keys = [];

  let cursor = "0";

  do {
    const response = await redisCommand(
      url,
      token,
      [
        "SCAN",
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "100"
      ]
    );

    if (response.error) {
      throw new Error(
        `Redis SCAN failed: ${response.error}`
      );
    }

    const result = response.result;

    if (
      !Array.isArray(result) ||
      result.length < 2
    ) {
      break;
    }

    cursor = String(result[0]);

    if (Array.isArray(result[1])) {
      keys.push(...result[1]);
    }

  } while (cursor !== "0");

  return [...new Set(keys)];
}


// ==========================================
// Redis REST command
// ==========================================

async function redisCommand(
  url,
  token,
  command
) {
  try {
    const response = await fetch(
      `${url}/pipeline`,
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },

        body: JSON.stringify([
          command
        ])
      }
    );

    const text =
      await response.text();

    if (!response.ok) {
      return {
        result: null,
        error: text.slice(0, 1000)
      };
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return {
        result: null,
        error:
          "Invalid Redis response."
      };
    }

    return {
      result:
        data?.[0]?.result ?? null,

      error:
        data?.[0]?.error || null
    };

  } catch (error) {
    return {
      result: null,
      error: error.message
    };
  }
      }
