export default async function handler(req, res) {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!redisUrl || !redisToken) {
    return res.status(500).json({
      success: false,
      error: "Redis environment variables are missing."
    });
  }

  if (!openaiKey) {
    return res.status(500).json({
      success: false,
      error: "OPENAI_API_KEY is missing."
    });
  }

  try {
    // 1. Get latest news
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

    // Process latest 5 news first
    for (const news of newsData.news.slice(0, 5)) {
      const duplicateKey =
        "news:processed:" + hashString(news.title);

      // 2. Check duplicate
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

      // 3. AI processing
      const aiResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0.2,
            response_format: {
              type: "json_object"
            },
            messages: [
              {
                role: "system",
                content: `
তুমি ODHIKAR TV-এর News Editor।

প্রদত্ত খবরের তথ্য ব্যবহার করে সম্পূর্ণ নতুন ভাষায় একটি সংক্ষিপ্ত বাংলা নিউজ তৈরি করবে।

কোনো তথ্য বানাবে না।
মূল প্রতিবেদনের লেখা কপি করবে না।
নিশ্চিত নয় এমন তথ্যকে সত্য হিসেবে লিখবে না।
অভিযোগকে প্রমাণিত সত্য হিসেবে লিখবে না।
সহিংসতা, উগ্রবাদ, গুজব বা সন্দেহজনক দাবির ক্ষেত্রে সতর্ক থাকবে।

Category অবশ্যই এইগুলোর একটি হবে:
জাতীয়, আন্তর্জাতিক, খেলাধুলা, বিনোদন, প্রযুক্তি, অর্থনীতি, অন্যান্য

JSON format:

{
  "title": "সংবাদ শিরোনাম",
  "summary": "সংক্ষিপ্ত সংবাদ বিবরণ",
  "category": "জাতীয়"
}

শুধু JSON ফেরত দাও।
`
              },
              {
                role: "user",
                content: JSON.stringify({
                  title: news.title,
                  source: news.source,
                  published_at: news.pubDate,
                  source_url: news.link
                })
              }
            ]
          })
        }
      );

      // Read OpenAI response safely
      const aiText = await aiResponse.text();

      if (!aiResponse.ok) {
        results.push({
          title: news.title,
          status: "ai_error",
          error: aiText
        });

        continue;
      }

      let aiData;

      try {
        aiData = JSON.parse(aiText);
      } catch {
        results.push({
          title: news.title,
          status: "invalid_openai_response",
          error: aiText
        });

        continue;
      }

      // Check OpenAI response structure
      if (
        !aiData.choices ||
        !aiData.choices[0] ||
        !aiData.choices[0].message
      ) {
        results.push({
          title: news.title,
          status: "invalid_openai_response",
          error: aiData
        });

        continue;
      }

      let article;

      try {
        article = JSON.parse(
          aiData.choices[0].message.content
        );
      } catch {
        results.push({
          title: news.title,
          status: "invalid_ai_json"
        });

        continue;
      }

      // 4. Safety gate
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

      // 5. Save as processed
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

      // 6. Save generated article as draft
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
      message: "News processing completed.",
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


// Upstash Redis REST command helper
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


// Simple stable hash for duplicate detection
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
