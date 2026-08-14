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
    // ==========================================
    // 1. Fetch latest news
    // ==========================================

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

    if (!Array.isArray(newsData.news) || newsData.news.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No news found.",
        processed: 0,
        results: []
      });
    }

    const results = [];

    // ==========================================
    // 2. Process latest 5 news
    // ==========================================

    for (const news of newsData.news.slice(0, 5)) {
      if (!news || !news.title || !news.link) {
        results.push({
          status: "invalid_source_news"
        });

        continue;
      }

      const title = String(news.title).trim();

      const duplicateKey =
        "news:processed:" + hashString(title);

      const articleKey =
        "news:draft:" + hashString(title);

      // ==========================================
      // 3. Duplicate check
      // ==========================================

      const checkResponse = await redisCommand(
        redisUrl,
        redisToken,
        ["GET", duplicateKey]
      );

      if (checkResponse.error) {
        results.push({
          title,
          status: "redis_error",
          error: checkResponse.error
        });

        continue;
      }

      if (checkResponse.result) {
        results.push({
          title,
          status: "duplicate"
        });

        continue;
      }

      // ==========================================
      // 4. Check whether draft already exists
      // ==========================================

      const existingDraft = await redisCommand(
        redisUrl,
        redisToken,
        ["GET", articleKey]
      );

      if (existingDraft.result) {
        results.push({
          title,
          status: "draft_already_exists",
          draft_key: articleKey
        });

        continue;
      }

      // ==========================================
      // 5. Gemini prompt
      // ==========================================

      const prompt = `
তুমি ODHIKAR TV-এর News Editor।

নিচের সংবাদ তথ্যের ভিত্তিতে সম্পূর্ণ নতুন ভাষায় একটি সংক্ষিপ্ত ও নিরপেক্ষ বাংলা নিউজ তৈরি করো।

গুরুত্বপূর্ণ নিয়ম:
- কোনো তথ্য বানাবে না।
- মূল প্রতিবেদনের বাক্য হুবহু কপি করবে না।
- শুধুমাত্র দেওয়া তথ্যের ভিত্তিতে লিখবে।
- অভিযোগকে প্রমাণিত সত্য হিসেবে লিখবে না।
- নিশ্চিত নয় এমন তথ্যকে নিশ্চিত হিসেবে লিখবে না।
- রাজনৈতিক বা বিতর্কিত বিষয়ে নিরপেক্ষ ভাষা ব্যবহার করবে।
- অতিরঞ্জিত, উত্তেজক বা ক্লিকবেইট শিরোনাম লিখবে না।
- কোনো ব্যক্তি বা প্রতিষ্ঠানের বিরুদ্ধে নতুন অভিযোগ তৈরি করবে না।
- উৎসে যা বলা হয়নি তা যোগ করবে না।
- সংক্ষিপ্ত কিন্তু তথ্যপূর্ণ সংবাদ লিখবে।

Category অবশ্যই নিচের একটি হতে হবে:

জাতীয়
আন্তর্জাতিক
খেলাধুলা
বিনোদন
প্রযুক্তি
অর্থনীতি
অন্যান্য

শুধু JSON format-এ উত্তর দাও।

JSON structure:
{
  "title": "নতুন বাংলা শিরোনাম",
  "summary": "সংক্ষিপ্ত বাংলা সংবাদ",
  "category": "জাতীয়"
}

মূল খবর:

Title: ${title}
Source: ${String(news.source || "অজানা").trim()}
Published: ${String(news.pubDate || "").trim()}
Source URL: ${String(news.link).trim()}
`;

      // ==========================================
      // 6. Gemini API request
      // ==========================================

      let geminiResponse;

      try {
        geminiResponse = await fetch(
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
      } catch (error) {
        results.push({
          title,
          status: "ai_connection_error",
          error: error.message
        });

        continue;
      }

      const geminiText = await geminiResponse.text();

      // ==========================================
      // 7. Gemini API error
      // ==========================================

      if (!geminiResponse.ok) {
        results.push({
          title,
          status: "ai_error",
          error: geminiText.slice(0, 1000)
        });

        continue;
      }

      // ==========================================
      // 8. Parse Gemini response
      // ==========================================

      let geminiData;

      try {
        geminiData = JSON.parse(geminiText);
      } catch {
        results.push({
          title,
          status: "invalid_gemini_response",
          response: geminiText.slice(0, 1000)
        });

        continue;
      }

      // ==========================================
      // 9. Extract generated text
      // ==========================================

      let generatedText = "";

      // output_text
      if (
        typeof geminiData.output_text === "string" &&
        geminiData.output_text.trim()
      ) {
        generatedText = geminiData.output_text.trim();
      }

      // outputs
      if (!generatedText && Array.isArray(geminiData.outputs)) {
        for (const output of geminiData.outputs) {
          if (
            output &&
            typeof output.text === "string" &&
            output.text.trim()
          ) {
            generatedText += output.text;
          }
        }
      }

      // steps
      if (!generatedText && Array.isArray(geminiData.steps)) {
        for (const step of geminiData.steps) {
          if (!Array.isArray(step?.content)) {
            continue;
          }

          for (const content of step.content) {
            if (
              typeof content?.text === "string" &&
              content.text.trim()
            ) {
              generatedText += content.text;
            }
          }
        }
      }

      if (!generatedText.trim()) {
        results.push({
          title,
          status: "empty_ai_response"
        });

        continue;
      }

      generatedText = cleanJsonText(generatedText);

      // ==========================================
      // 10. Parse generated JSON
      // ==========================================

      let article;

      try {
        article = JSON.parse(generatedText);
      } catch {
        results.push({
          title,
          status: "invalid_ai_json",
          response: generatedText.slice(0, 1500)
        });

        continue;
      }

      // ==========================================
      // 11. Validate article structure
      // ==========================================

      if (
        !article ||
        typeof article !== "object" ||
        typeof article.title !== "string" ||
        typeof article.summary !== "string" ||
        typeof article.category !== "string"
      ) {
        results.push({
          title,
          status: "safety_review_required",
          reason: "AI output structure is invalid."
        });

        continue;
      }

      const generatedTitle = article.title.trim();
      const generatedSummary = article.summary.trim();
      const generatedCategory = article.category.trim();

      if (
        !generatedTitle ||
        !generatedSummary ||
        !generatedCategory
      ) {
        results.push({
          title,
          status: "safety_review_required",
          reason: "Required AI fields are empty."
        });

        continue;
      }

      // ==========================================
      // 12. Validate category
      // ==========================================

      const allowedCategories = [
        "জাতীয়",
        "আন্তর্জাতিক",
        "খেলাধুলা",
        "বিনোদন",
        "প্রযুক্তি",
        "অর্থনীতি",
        "অন্যান্য"
      ];

      if (!allowedCategories.includes(generatedCategory)) {
        results.push({
          title,
          status: "invalid_category",
          category: generatedCategory
        });

        continue;
      }

      // ==========================================
      // 13. Basic safety review
      // ==========================================

      const suspiciousPatterns = [
        "নিশ্চিতভাবেই",
        "অবশ্যই সত্য",
        "প্রমাণিত যে",
        "শতভাগ নিশ্চিত",
        "চাঞ্চল্যকর!",
        "অবাক করা!",
        "ভয়াবহ!",
        "ভাইরাল!"
      ];

      const combinedText =
        `${generatedTitle} ${generatedSummary}`;

      const suspicious = suspiciousPatterns.some((pattern) =>
        combinedText.includes(pattern)
      );

      if (suspicious) {
        results.push({
          title,
          status: "safety_review_required",
          reason: "Potentially sensational or unverified wording detected."
        });

        continue;
      }

      // ==========================================
      // 14. Create draft
      // ==========================================

      const draft = {
        title: generatedTitle,
        summary: generatedSummary,
        category: generatedCategory,

        source: String(news.source || "সংবাদ সূত্র").trim(),

        source_url: String(news.link).trim(),

        published_at:
          String(news.pubDate || "").trim(),

        status: "draft",

        created_at:
          new Date().toISOString()
      };

      // ==========================================
      // 15. Save draft to Redis
      // ==========================================

      const saveResponse = await redisCommand(
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

      if (saveResponse.error) {
        results.push({
          title,
          status: "draft_save_error",
          error: saveResponse.error
        });

        continue;
      }

      // ==========================================
      // 16. Mark as processed
      // ==========================================

      const markResponse = await redisCommand(
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

      if (markResponse.error) {
        results.push({
          title,
          status: "draft_created_but_duplicate_mark_failed",
          draft_key: articleKey,
          error: markResponse.error
        });

        continue;
      }

      // ==========================================
      // 17. Success
      // ==========================================

      results.push({
        title,
        status: "draft_created",
        category: generatedCategory,
        draft_key: articleKey
      });
    }

    return res.status(200).json({
      success: true,
      message: "Gemini news processing completed.",
      processed: results.length,
      draft_created: results.filter(
        item => item.status === "draft_created"
      ).length,
      duplicates: results.filter(
        item => item.status === "duplicate"
      ).length,
      safety_reviews: results.filter(
        item => item.status === "safety_review_required"
      ).length,
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


// ==========================================
// Clean JSON returned by AI
// ==========================================

function cleanJsonText(text) {
  let cleaned = String(text).trim();

  // Remove Markdown code fences
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Find first JSON object
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.slice(
      firstBrace,
      lastBrace + 1
    );
  }

  return cleaned.trim();
}


// ==========================================
// Stable hash for duplicate detection
// ==========================================

function hashString(text) {
  let hash = 0;

  const value = String(text || "").trim();

  for (let i = 0; i < value.length; i++) {
    hash =
      (hash << 5) -
      hash +
      value.charCodeAt(i);

    hash |= 0;
  }

  return Math.abs(hash).toString();
}
