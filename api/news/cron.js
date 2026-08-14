export default async function handler(req, res) {
  // Vercel Cron request verification
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

  try {
    // ==========================================
    // 1. Process latest news with Gemini
    // ==========================================

    const processResponse = await fetch(
      "https://odhikar-tv-auto-news.vercel.app/api/news/process",
      {
        method: "GET"
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
        details: processText
      });
    }

    if (!processResponse.ok) {
      return res.status(500).json({
        success: false,
        error: "News processing failed.",
        process: processData
      });
    }

    // ==========================================
    // 2. Publish generated drafts to Blogger
    // ==========================================

    const publishResponse = await fetch(
      "https://odhikar-tv-auto-news.vercel.app/api/news/publish",
      {
        method: "GET"
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
        details: publishText
      });
    }

    if (!publishResponse.ok) {
      return res.status(500).json({
        success: false,
        error: "Blogger publishing failed.",
        publish: publishData
      });
    }

    // ==========================================
    // 3. Final result
    // ==========================================

    return res.status(200).json({
      success: true,
      message: "Auto news cron completed successfully.",
      processing: {
        success: processData.success,
        processed: processData.processed || 0
      },
      publishing: {
        success: publishData.success,
        published: publishData.published || 0
      },
      results: publishData.results || []
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Cron job failed.",
      details: error.message
    });
  }
}
