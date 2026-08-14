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

    for (const news of newsData.news.slice(0, 5)) {
      const duplicateKey =
        "news:processed:" + hashString(news.title);

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

      const prompt = `
তুমি ODHIKAR TV-এর News Editor।

নিচের খবরের তথ্য ব্যবহার করে সম্পূর্ণ নতুন ভাষায় একটি সংক্ষিপ্ত বাংলা নিউজ তৈরি করো।

কোনো তথ্য বানাবে না।
মূল প্রতিবেদনের লেখা কপি করবে না।
অভিযোগকে প্রমাণিত সত্য হিসেবে লিখবে না।
নিশ্চিত নয় এমন তথ্যকে সত্য হিসেবে লিখবে না।

Category অবশ্যই এইগুলোর একটি হবে:
জাতীয়, আন্তর্জাতিক, খেলাধুলা, বিনোদন, প্রযুক্তি, অর্থনীতি, অন্যান্য

শুধু নিচের JSON format-এ উত্তর দাও:

{
  "title": "নতুন বাংলা শিরোনাম",
  "summary": "সংক্ষিপ্ত সংবাদ বিবরণ",
  "category": "জাতীয়"
}

মূল খবর:
Title: ${news.title}
Source: ${news.source}
Published: ${news.pubDate}
Source URL: ${news.link}
`;

      // Gemini AI
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt
                  }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: "application/json"
            }
          })
        }
      );

      const geminiText = await geminiResponse.text();

      if (!geminiResponse.ok) {
        results.push({
          title: news.title,
          status: "ai_error",
          error: geminiText
        });

        continue;
      }

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

      const generatedText =
        geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!generatedText) {
        results.push({
          title: news.title,
          status: "empty_ai_response",
          error: geminiData
        });

        continue;
      }

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

      // Safety check
      if (
        !article.title ||
        !article.summary ||
        !article.category
      ) {
        results.push({
          title: news.title,
          status: "safety_review_required"
        });

        continue;
      }

      // Mark as processed
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

      // Save draft
      const articleKey =
        "news:draft:" + hashString(news.title);

      const draft = {
        title: article.title,
        summary: article.summary,
        category: article.category,
        source: news.source,
        source_url: news.link,
        published_at: news.pubDate,
        status: "draft",
        created_at: new Date().toISOString()
      };

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


// Upstash Redis REST command
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


// Duplicate detection hash
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
