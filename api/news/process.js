export default async function handler(req, res) {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!redisUrl || !redisToken) {
    return res.status(500).json({
      success: false,
      error: "Redis environment variables are missing."
    });
  }

  if (!geminiKey) {
    return res.status(500).json({
      success: false,
      error: "GEMINI_API_KEY is missing."
    });
  }

  try {
    // 1. Fetch latest news
    const newsResponse = await fetch(
      "https://odhikar-tv-auto-news.vercel.app/api/news/fetch"
    );

    if (!newsResponse.ok) {
      return res.status(500).json({
        success: false,
        error: "News Collector failed."
      });
    }

    const newsData = await newsResponse.json();

    if (!newsData.news || newsData.news.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No news found.",
        processed: 0
      });
    }

    const results = [];

    // Process latest 5 news
    for (const news of newsData.news.slice(0, 5)) {
      const duplicateKey =
        "news:processed:" + hashString(news.title);

      // 2. Duplicate check
      const checkResponse = await redisCommand(
        redisUrl,
        redisToken,
        ["GET", duplicateKey]
      );

      if (checkResponse.result) {
        results.push({
          title: news.title,
          status: "duplicate"
        });

        continue;
      }

      // 3. AI prompt
      const prompt = `
তুমি ODHIKAR TV-এর News Editor।

নিচের সংবাদ তথ্যের ভিত্তিতে সম্পূর্ণ নতুন ভাষায় একটি সংক্ষিপ্ত বাংলা নিউজ তৈরি করো।

নিয়ম:
- কোনো তথ্য বানাবে না।
- মূল প্রতিবেদনের বাক্য হুবহু কপি করবে না।
- শুধুমাত্র দেওয়া তথ্যের ভিত্তিতে লিখবে।
- অভিযোগকে প্রমাণিত সত্য হিসেবে লিখবে না।
- নিশ্চিত নয় এমন তথ্যকে নিশ্চিত হিসেবে লিখবে না।
- সংবাদের ভাষা নিরপেক্ষ ও পেশাদার হবে।
- অতিরঞ্জিত বা ক্লিকবেইট শিরোনাম লিখবে না।

Category অবশ্যই নিচের একটি হতে হবে:
জাতীয়
আন্তর্জাতিক
খেলাধুলা
বিনোদন
প্রযুক্তি
অর্থনীতি
অন্যান্য

শুধু JSON format-এ উত্তর দাও।

মূল খবর:
Title: ${news.title}
Source: ${news.source}
Published: ${news.pubDate}
Source URL: ${news.link}
`;

      // 4. Gemini Interactions API
      const geminiResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": geminiKey
          },
          body: JSON.stringify({
            model: "gemini-flash-lite-latest",

            input: prompt,

            response_format: {
              type: "text",
              mime_type: "application/json",
              schema: {
                type: "object",
                properties: {
                  title: {
                    type: "string"
                  },
                  summary: {
                    type: "string"
                  },
                  category: {
                    type: "string",
                    enum: [
                      "জাতীয়",
                      "আন্তর্জাতিক",
                      "খেলাধুলা",
                      "বিনোদন",
                      "প্রযুক্তি",
                      "অর্থনীতি",
                      "অন্যান্য"
                    ]
                  }
                },
                required: [
                  "title",
                  "summary",
                  "category"
                ]
              }
            }
          })
        }
      );

      const geminiText = await geminiResponse.text();

      // 5. Gemini API error
      if (!geminiResponse.ok) {
        results.push({
          title: news.title,
          status: "ai_error",
          error: geminiText
        });

        continue;
      }

      // 6. Parse Gemini response
      let geminiData;

      try {
        geminiData = JSON.parse(geminiText);
      } catch {
        results.push({
          title: news.title,
          status: "invalid_gemini_response",
          response: geminiText
        });

        continue;
      }

      // 7. Get generated text
      let generatedText = "";

      // Normal Interactions API output
      if (
        typeof geminiData.output_text === "string" &&
        geminiData.output_text.trim()
      ) {
        generatedText = geminiData.output_text.trim();
      }

      // Fallback: outputs
      if (!generatedText && Array.isArray(geminiData.outputs)) {
        for (const output of geminiData.outputs) {
          if (
            output?.type === "text" &&
            typeof output?.text === "string"
          ) {
            generatedText += output.text;
          }
        }
      }

      // Fallback: steps
      if (!generatedText && Array.isArray(geminiData.steps)) {
        for (const step of geminiData.steps) {
          if (step?.type !== "model_output") {
            continue;
          }

          if (!Array.isArray(step.content)) {
            continue;
          }

          for (const content of step.content) {
            if (
              content?.type === "text" &&
              typeof content?.text === "string"
            ) {
              generatedText += content.text;
            }
          }
        }
      }

      if (!generatedText) {
        results.push({
          title: news.title,
          status: "empty_ai_response"
        });

        continue;
      }

      // 8. Parse generated JSON
      let article;

      try {
        article = JSON.parse(generatedText);
      } catch {
        results.push({
          title: news.title,
          status: "invalid_ai_json",
          response: generatedText
        });

        continue;
      }

      // 9. Validate article
      if (
        typeof article !== "object" ||
        !article ||
        typeof article.title !== "string" ||
        !article.title.trim() ||
        typeof article.summary !== "string" ||
        !article.summary.trim() ||
        typeof article.category !== "string" ||
        !article.category.trim()
      ) {
        results.push({
          title: news.title,
          status: "safety_review_required",
          article: article
        });

        continue;
      }

      // 10. Validate category
      const allowedCategories = [
        "জাতীয়",
        "আন্তর্জাতিক",
        "খেলাধুলা",
        "বিনোদন",
        "প্রযুক্তি",
        "অর্থনীতি",
        "অন্যান্য"
      ];

      if (!allowedCategories.includes(article.category)) {
        results.push({
          title: news.title,
          status: "invalid_category",
          category: article.category
        });

        continue;
      }

      // 11. Mark as processed
      await redisCommand(
        redisUrl,
        redisToken,
        [
          "SET",
          duplicateKey,
          "1",
          "EX",
          "2592000"
        ]
      );

      // 12. Create draft key
      const articleKey =
        "news:draft:" + hashString(news.title);

      // 13. Create draft
      const draft = {
        title: article.title.trim(),
        summary: article.summary.trim(),
        category: article.category,
        source: news.source,
        source_url: news.link,
        published_at: news.pubDate,
        status: "draft",
        created_at: new Date().toISOString()
      };

      // 14. Save draft to Redis
      await redisCommand(
        redisUrl,
        redisToken,
        [
          "SET",
          articleKey,
          JSON.stringify(draft),
          "EX",
          "2592000"
        ]
      );

      // 15. Success
      results.push({
        title: news.title,
        status: "draft_created",
        category: article.category,
        draft_key: articleKey
      });
    }

    return res.status(200).json({
      success: true,
      message: "Gemini news processing completed.",
      processed: results.length,
      results
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "News processing failed.",
      details: error.message
    });
  }
}


// ==========================================
// Upstash Redis REST command helper
// ==========================================

async function redisCommand(url, token, command) {
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

  const data = await response.json();

  return {
    result: data[0]?.result
  };
}


// ==========================================
// Stable hash for duplicate detection
// ==========================================

function hashString(text) {
  let hash = 0;

  for (let i = 0; i < text.length; i++) {
    hash =
      (hash << 5) -
      hash +
      text.charCodeAt(i);

    hash |= 0;
  }

  return Math.abs(hash).toString();
        }
