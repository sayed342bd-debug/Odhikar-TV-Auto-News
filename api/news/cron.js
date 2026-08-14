export default async function handler(req, res) {
  // ==========================================
  // 1. Verify Vercel Cron request
  // ==========================================

  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const authHeader = req.headers.authorization;

    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized."
      });
    }
  }

  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed."
    });
  }

  // ==========================================
  // 2. Application URL
  // ==========================================

  const baseUrl =
    process.env.NEWS_APP_URL ||
    "https://odhikar-tv-auto-news.vercel.app";

  try {
    // ==========================================
    // 3. Process latest news with Gemini
    // ==========================================

    const processResponse = await fetch(
      `${baseUrl}/api/news/process`,
      {
        method: "GET",
        headers: cronSecret
          ? {
              Authorization: `Bearer ${cronSecret}`
            }
          : {}
      }
    );

    const processText = await processResponse.text();

    let processData;

    try {
      processData = JSON.parse(processText);
    } catch {
      return res.status(500).json({
        success: false,
        error: "News processing returned invalid response.",
        details: processText.slice(0, 2000)
      });
    }

    if (!processResponse.ok) {
      return res.status(500).json({
        success: false,
        error: "News processing failed.",
        processing: processData
      });
    }

    // ==========================================
    // 4. Publish generated drafts to Blogger
    // ==========================================

    const publishResponse = await fetch(
      `${baseUrl}/api/news/publish`,
      {
        method: "GET",
        headers: cronSecret
          ? {
              Authorization: `Bearer ${cronSecret}`
            }
          : {}
      }
    );

    const publishText = await publishResponse.text();

    let publishData;

    try {
      publishData = JSON.parse(publishText);
    } catch {
      return res.status(500).json({
        success: false,
        error: "Blogger publishing returned invalid response.",
        details: publishText.slice(0, 2000)
      });
    }

    if (!publishResponse.ok) {
      return res.status(500).json({
        success: false,
        error: "Blogger publishing failed.",
        publishing: publishData
      });
    }

    // ==========================================
    // 5. Final result
    // ==========================================

    return res.status(200).json({
      success: true,
      message: "Auto news cron completed successfully.",

      processing: {
        success: processData.success === true,
        processed: Number(processData.processed || 0),
        draft_created: Number(
          processData.draft_created || 0
        ),
        duplicates: Number(
          processData.duplicates || 0
        ),
        safety_reviews: Number(
          processData.safety_reviews || 0
        )
      },

      publishing: {
        success: publishData.success === true,
        published: Number(
          publishData.published || 0
        )
      },

      results: Array.isArray(publishData.results)
        ? publishData.results
        : []
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Cron job failed.",
      details: error?.message || "Unknown error."
    });
  }
}
