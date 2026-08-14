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

  const allowedCategories = [
    "জাতীয়",
    "আন্তর্জাতিক",
    "খেলাধুলা",
    "বিনোদন",
    "প্রযুক্তি",
    "অর্থনীতি",
    "অন্যান্য"
  ];

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

    if (!newsData.news || newsData.news.length === 0) {
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
      if (!news.title || !news.title.trim()) {
        results.push({
          title: "Unknown",
          status: "invalid_source_news"
        });

        continue;
      }

      const duplicateKey =
        "news:processed:" + hashString(news.title.trim());

      // ==========================================
      // 3. Duplicate check
      // ==========================================

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

      // ==========================================
      // 4. Gemini prompt
      // ==========================================

      const prompt = `
তুমি ODHIKAR TV-এর একজন দায়িত্বশীল News Editor এবং Safety Reviewer।

নিচের সংবাদ তথ্যের ভিত্তিতে সম্পূর্ণ নতুন ভাষায় একটি সংক্ষিপ্ত বাংলা নিউজ তৈরি করো।

গুরুত্বপূর্ণ নিয়ম:

1. কোনো তথ্য বানাবে না।
2. মূল প্রতিবেদনের বাক্য হুবহু কপি করবে না।
3. শুধুমাত্র দেওয়া তথ্যের ভিত্তিতে লিখবে।
4. অভিযোগকে প্রমাণিত সত্য হিসেবে লিখবে না।
5. নিশ্চিত নয় এমন তথ্যকে নিশ্চিত হিসেবে লিখবে না।
6. অতিরঞ্জিত বা ক্লিকবেইট শিরোনাম লিখবে না।
7. নিরপেক্ষ ও পেশাদার ভাষা ব্যবহার করবে।
8. কোনো গুরুত্বপূর্ণ তথ্য না থাকলে অনুমান করে পূরণ করবে না।
9. রাজনৈতিক, অপরাধ, সহিংসতা, সংঘাত বা বিতর্কিত বিষয়ে বিশেষভাবে সতর্ক থাকবে।
10. কোনো দাবি যদি নিশ্চিতভাবে যাচাই করা সম্ভব না হয়, তাহলে safety_status হবে "review"।
11. সংবাদটি স্বাভাবিক ও প্রকাশযোগ্য হলে safety_status হবে "safe"।
12. সন্দেহ থাকলে "safe" না দিয়ে "review" নির্বাচন করবে।

Category অবশ্যই নিচের একটি হতে হবে:

জাতীয়
আন্তর্জাতিক
খেলাধুলা
বিনোদন
প্রযুক্তি
অর্থনীতি
অন্যান্য

শুধু JSON object ফেরত দাও।

JSON format:

{
  "title": "নতুন বাংলা শিরোনাম",
  "summary": "সংক্ষিপ্ত সংবাদ বিবরণ",
  "category": "জাতীয়",
  "safety_status": "safe",
  "safety_reason": ""
}

যদি সংবাদটি সরাসরি প্রকাশের জন্য নিরাপদ না হয়:

{
  "title": "নতুন বাংলা শিরোনাম",
  "summary": "সংক্ষিপ্ত সংবাদ বিবরণ",
  "category": "জাতীয়",
  "safety_status": "review",
  "safety_reason": "কেন মানব যাচাই প্রয়োজন তার সংক্ষিপ্ত কারণ"
}

safety_status অবশ্যই "safe" অথবা "review" হবে।

মূল খবর:
Title: ${news.title}
Source: ${news.source || "Unknown"}
Published: ${news.pubDate || "Unknown"}
Source URL: ${news.link || ""}
`;

      // ==========================================
      // 5. Gemini Interactions API
      // ==========================================

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
                    enum: allowedCategories
                  },
                  safety_status: {
                    type: "string",
                    enum: [
                      "safe",
                      "review"
                    ]
                  },
                  safety_reason: {
                    type: "string"
                  }
                },
                required: [
                  "title",
                  "summary",
                  "category",
                  "safety_status",
                  "safety_reason"
                ]
              }
            }
          })
        }
      );

      const geminiText = await geminiResponse.text();

      // ==========================================
      // 6. Gemini API error
      // ==========================================

      if (!geminiResponse.ok) {
        results.push({
          title: news.title,
          status: "ai_error",
          error: geminiText
        });

        continue;
      }

      // ==========================================
      // 7. Parse Gemini response
      // ==========================================

      let geminiData;

      try {
        geminiData = JSON.parse(geminiText);
      } catch {
        results.push({
          title: news.title,
          status: "invalid_gemini_response"
        });

        continue;
      }

      // ==========================================
      // 8. Extract generated text
      // ==========================================

      let generatedText = "";

      if (
        typeof geminiData.output_text === "string" &&
        geminiData.output_text.trim()
      ) {
        generatedText = geminiData.output_text.trim();
      }

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

      generatedText = generatedText.trim();

      if (!generatedText) {
        results.push({
          title: news.title,
          status: "empty_ai_response"
        });

        continue;
      }

      // ==========================================
      // 9. Parse generated article JSON
      // ==========================================

      let article;

      try {
        article = JSON.parse(generatedText);
      } catch {
        results.push({
          title: news.title,
          status: "invalid_ai_json"
        });

        continue;
      }

      // ==========================================
      // 10. Basic article validation
      // ==========================================

      if (
        typeof article !== "object" ||
        !article ||
        typeof article.title !== "string" ||
        !article.title.trim() ||
        typeof article.summary !== "string" ||
        !article.summary.trim() ||
        typeof article.category !== "string" ||
        !article.category.trim() ||
        typeof article.safety_status !== "string"
      ) {
        results.push({
          title: news.title,
          status: "safety_review_required"
        });

        continue;
      }

      // ==========================================
      // 11. Validate category
      // ==========================================

      if (!allowedCategories.includes(article.category)) {
        results.push({
          title: news.title,
          status: "invalid_category",
          category: article.category
        });

        continue;
      }

      // ==========================================
      // 12. Validate safety status
      // ==========================================

      if (
        article.safety_status !== "safe" &&
        article.safety_status !== "review"
      ) {
        results.push({
          title: news.title,
          status: "invalid_safety_status"
        });

        continue;
      }

      // ==========================================
      // 13. Extra local safety checks
      // ==========================================

      const localSafety = runLocalSafetyChecks(
        article.title,
        article.summary
      );

      if (!localSafety.safe) {
        article.safety_status = "review";

        if (!article.safety_reason) {
          article.safety_reason = localSafety.reason;
        } else {
          article.safety_reason =
            `${article.safety_reason}; ${localSafety.reason}`;
        }
      }

      // ==========================================
      // 14. Create common article data
      // ==========================================

      const now = new Date().toISOString();

      const baseArticle = {
        title: article.title.trim(),
        summary: article.summary.trim(),
        category: article.category,
        source: news.source || "সংবাদ সূত্র",
        source_url: news.link || "",
        published_at: news.pubDate || "",
        created_at: now,
        safety_reason: article.safety_reason || ""
      };

      // ==========================================
      // 15. REVIEW NEWS
      // ==========================================

      if (article.safety_status === "review") {
        const reviewKey =
          "news:review:" + hashString(news.title.trim());

        const review = {
          ...baseArticle,
          status: "review",
          original_title: news.title
        };

        await redisCommand(
          redisUrl,
          redisToken,
          [
            "SET",
            reviewKey,
            JSON.stringify(review),
            "EX",
            "2592000"
          ]
        );

        // Mark processed so Cron does not repeatedly
        // create the same review item.
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

        results.push({
          title: news.title,
          status: "review",
          reason: review.safety_reason,
          review_key: reviewKey
        });

        continue;
      }

      // ==========================================
      // 16. SAFE NEWS → CREATE DRAFT
      // ==========================================

      const articleKey =
        "news:draft:" + hashString(news.title.trim());

      const draft = {
        ...baseArticle,
        status: "draft"
      };

      // Save draft first.
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

      if (!saveResponse.success) {
        results.push({
          title: news.title,
          status: "draft_save_failed"
        });

        continue;
      }

      // Only mark as processed after the draft
      // was successfully saved.
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

      results.push({
        title: news.title,
        status: "draft_created",
        category: article.category,
        draft_key: articleKey
      });
    }

    // ==========================================
    // 17. Final response
    // ==========================================

    return res.status(200).json({
      success: true,
      message: "Gemini news processing completed with safety filter.",
      processed: results.length,
      safe_drafts: results.filter(
        item => item.status === "draft_created"
      ).length,
      review_required: results.filter(
        item => item.status === "review"
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
// Local safety checks
// ==========================================

function runLocalSafetyChecks(title, summary) {
  const text =
    `${title || ""} ${summary || ""}`.toLowerCase();

  // Extremely short content is not suitable
  // for automatic publishing.
  if (
    String(title || "").trim().length < 10 ||
    String(summary || "").trim().length < 30
  ) {
    return {
      safe: false,
      reason: "সংবাদের তথ্য অসম্পূর্ণ বা খুব সংক্ষিপ্ত।"
    };
  }

  // Clickbait / sensational wording.
  const suspiciousPatterns = [
    "চাঞ্চল্যকর",
    "ভয়াবহ গোপন",
    "অবিশ্বাস্য",
    "হাড়হিম",
    "দেখুন কী হলো",
    "সবাই হতবাক",
    "ভাইরাল সত্য",
    "নিশ্চিতভাবেই"
  ];

  for (const pattern of suspiciousPatterns) {
    if (text.includes(pattern)) {
      return {
        safe: false,
        reason:
          "শিরোনাম বা বিবরণে অতিরঞ্জিত/ক্লিকবেইট ভাষা পাওয়া গেছে।"
      };
    }
  }

  return {
    safe: true,
    reason: ""
  };
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

  if (!response.ok) {
    return {
      success: false,
      result: null
    };
  }

  const data = await response.json();

  return {
    success: true,
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
