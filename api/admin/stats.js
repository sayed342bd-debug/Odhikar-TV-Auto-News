export default async function handler(req, res) {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  if (!redisUrl || !redisToken) {
    return res.status(500).json({
      success: false,
      error: "Redis environment variables are missing."
    });
  }

  try {
    // ==========================================
    // Get all news drafts
    // ==========================================

    const scanResponse = await redisCommand(
      redisUrl,
      redisToken,
      [
        "SCAN",
        "0",
        "MATCH",
        "news:draft:*",
        "COUNT",
        "100"
      ]
    );

    if (scanResponse.error) {
      return res.status(500).json({
        success: false,
        error: "Unable to scan Redis.",
        details: scanResponse.error
      });
    }

    const scanResult = scanResponse.result;

    if (
      !Array.isArray(scanResult) ||
      !Array.isArray(scanResult[1])
    ) {
      return res.status(200).json({
        success: true,
        total: 0,
        published: 0,
        drafts: 0,
        review: 0,
        news: []
      });
    }

    const keys = scanResult[1];

    const news = [];

    // ==========================================
    // Read each draft
    // ==========================================

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

        news.push({
          key,
          title: article.title || "",
          category: article.category || "অন্যান্য",
          source: article.source || "",
          status: article.status || "draft",
          created_at: article.created_at || null,
          published_at: article.published_at || null,
          blogger_url: article.blogger_url || null
        });

      } catch {
        continue;
      }
    }

    // ==========================================
    // Statistics
    // ==========================================

    const total = news.length;

    const published = news.filter(
      item => item.status === "published"
    ).length;

    const drafts = news.filter(
      item => item.status === "draft"
    ).length;

    const review = news.filter(
      item => item.status === "review"
    ).length;

    // ==========================================
    // Newest first
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
    // Final response
    // ==========================================

    return res.status(200).json({
      success: true,
      total,
      published,
      drafts,
      review,
      news: news.slice(0, 50)
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Admin statistics failed.",
      details: error.message
    });
  }
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
        body: JSON.stringify([command])
      }
    );

    const text = await response.text();

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
        error: "Invalid Redis response."
      };
    }

    return {
      result: data[0]?.result ?? null,
      error: data[0]?.error || null
    };

  } catch (error) {
    return {
      result: null,
      error: error.message
    };
  }
}
