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
    // 1. Get Google OAuth tokens
    // ==========================================

    const tokenResponse = await redisCommand(
      redisUrl,
      redisToken,
      ["GET", "odhikar_tv_google_tokens"]
    );

    if (!tokenResponse.result) {
      return res.status(401).json({
        success: false,
        error: "Google Blogger tokens not found. Please connect Blogger again."
      });
    }

    let tokenData;

    try {
      tokenData =
        typeof tokenResponse.result === "string"
          ? JSON.parse(tokenResponse.result)
          : tokenResponse.result;
    } catch {
      return res.status(500).json({
        success: false,
        error: "Saved Google token data is invalid."
      });
    }

    let accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: "Google access token not found."
      });
    }

    // ==========================================
    // 2. Find Blogger Blog ID
    // ==========================================

    const blogUrl = "https://odhikartv01.blogspot.com/";

    let blogResponse = await bloggerRequest(
      `https://www.googleapis.com/blogger/v3/blogs/byurl?url=${encodeURIComponent(
        blogUrl
      )}&fetchUserInfo=false`,
      {
        method: "GET",
        accessToken
      }
    );

    // ==========================================
    // 3. Refresh token if expired
    // ==========================================

    if (blogResponse.status === 401) {
      if (!tokenData.refresh_token) {
        return res.status(401).json({
          success: false,
          error:
            "Google access token expired and no refresh token is available. Please reconnect Blogger."
        });
      }

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return res.status(500).json({
          success: false,
          error: "Google OAuth client credentials are missing."
        });
      }

      const refreshResponse = await fetch(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: tokenData.refresh_token,
            grant_type: "refresh_token"
          })
        }
      );

      const refreshData = await refreshResponse.json();

      if (!refreshResponse.ok || !refreshData.access_token) {
        return res.status(401).json({
          success: false,
          error: "Unable to refresh Google access token."
        });
      }

      accessToken = refreshData.access_token;
      tokenData.access_token = accessToken;

      await redisCommand(
        redisUrl,
        redisToken,
        [
          "SET",
          "odhikar_tv_google_tokens",
          JSON.stringify(tokenData)
        ]
      );

      blogResponse = await bloggerRequest(
        `https://www.googleapis.com/blogger/v3/blogs/byurl?url=${encodeURIComponent(
          blogUrl
        )}&fetchUserInfo=false`,
        {
          method: "GET",
          accessToken
        }
      );
    }

    if (!blogResponse.ok) {
      const errorText = await blogResponse.text();

      return res.status(500).json({
        success: false,
        error: "Unable to access Blogger blog.",
        details: errorText
      });
    }

    const blogData = await blogResponse.json();
    const blogId = blogData.id;

    if (!blogId) {
      return res.status(500).json({
        success: false,
        error: "Blogger Blog ID could not be found."
      });
    }

    // ==========================================
    // 4. Find drafts
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
        "20"
      ]
    );

    const scanResult = scanResponse.result;

    if (!Array.isArray(scanResult) || !Array.isArray(scanResult[1])) {
      return res.status(200).json({
        success: true,
        message: "No news drafts found.",
        published: 0
      });
    }

    const draftKeys = scanResult[1];

    if (draftKeys.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No news drafts found.",
        published: 0
      });
    }

    const results = [];

    // ==========================================
    // 5. Publish maximum 2 drafts per run
    // ==========================================

    for (const draftKey of draftKeys.slice(0, 2)) {
      const draftResponse = await redisCommand(
        redisUrl,
        redisToken,
        ["GET", draftKey]
      );

      if (!draftResponse.result) {
        results.push({
          draft_key: draftKey,
          status: "draft_not_found"
        });

        continue;
      }

      let draft;

      try {
        draft =
          typeof draftResponse.result === "string"
            ? JSON.parse(draftResponse.result)
            : draftResponse.result;
      } catch {
        results.push({
          draft_key: draftKey,
          status: "invalid_draft"
        });

        continue;
      }

      if (draft.status === "published") {
        results.push({
          draft_key: draftKey,
          status: "already_published"
        });

        continue;
      }

      if (!draft.title || !draft.summary) {
        results.push({
          draft_key: draftKey,
          status: "invalid_draft_content"
        });

        continue;
      }

      // ==========================================
      // 6. Build Blogger HTML
      // ==========================================

      const safeSummary = escapeHtml(draft.summary);
      const safeSource = escapeHtml(
        draft.source || "সংবাদ সূত্র"
      );

      const safeSourceUrl = escapeAttribute(
        draft.source_url || ""
      );

      const content = `
<div>
  <p>${safeSummary}</p>

  <hr>

  <p>
    <strong>সংবাদ সূত্র:</strong>
    ${safeSource}
  </p>

  ${
    safeSourceUrl
      ? `
  <p>
    <strong>মূল সংবাদ:</strong>
    <a href="${safeSourceUrl}" target="_blank" rel="noopener noreferrer">
      মূল প্রতিবেদন দেখুন
    </a>
  </p>
  `
      : ""
  }

  <p>
    <strong>Odhikar TV</strong>
  </p>
</div>
`;

      // ==========================================
      // 7. Publish with retry
      // ==========================================

      const publishResult = await publishWithRetry(
        blogId,
        accessToken,
        {
          title: draft.title,
          content,
          labels: [draft.category || "অন্যান্য"]
        }
      );

      if (!publishResult.success) {
        results.push({
          draft_key: draftKey,
          title: draft.title,
          status: "publish_error",
          error: publishResult.error
        });

        continue;
      }

      const publishedPost = publishResult.post;

      // ==========================================
      // 8. Mark as published
      // ==========================================

      const updatedDraft = {
        ...draft,
        status: "published",
        published_at: new Date().toISOString(),
        blogger_post_id: publishedPost.id || null,
        blogger_url: publishedPost.url || null
      };

      await redisCommand(
        redisUrl,
        redisToken,
        [
          "SET",
          draftKey,
          JSON.stringify(updatedDraft),
          "EX",
          "2592000"
        ]
      );

      results.push({
        draft_key: draftKey,
        title: draft.title,
        status: "published",
        category: draft.category,
        blogger_url: publishedPost.url || null
      });

      // ==========================================
      // 9. Wait before next post
      // ==========================================

      await sleep(5000);
    }

    return res.status(200).json({
      success: true,
      message: "Blogger auto publishing completed.",
      published: results.filter(
        item => item.status === "published"
      ).length,
      results
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Blogger publishing failed.",
      details: error.message
    });
  }
}


// ==========================================
// Blogger request helper
// ==========================================

async function bloggerRequest(url, options = {}) {
  return fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json"
    },
    body: options.body
  });
}


// ==========================================
// Publish with 429 retry
// ==========================================

async function publishWithRetry(
  blogId,
  accessToken,
  postData
) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(
      `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          kind: "blogger#post",
          title: postData.title,
          content: postData.content,
          labels: postData.labels
        })
      }
    );

    const text = await response.text();

    if (response.ok) {
      try {
        return {
          success: true,
          post: JSON.parse(text)
        };
      } catch {
        return {
          success: false,
          error: "Blogger returned an invalid response."
        };
      }
    }

    // Rate limit
    if (response.status === 429) {
      if (attempt === maxAttempts) {
        return {
          success: false,
          error:
            "Blogger API rate limit reached after multiple retries."
        };
      }

      // Increasing delay:
      // 8s → 16s → 32s
      const delay =
        Math.pow(2, attempt) * 8000;

      await sleep(delay);

      continue;
    }

    return {
      success: false,
      error: text
    };
  }

  return {
    success: false,
    error: "Publishing failed."
  };
}


// ==========================================
// Sleep helper
// ==========================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ==========================================
// Redis REST command
// ==========================================

async function redisCommand(
  url,
  token,
  command
) {
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
// HTML escaping
// ==========================================

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


// ==========================================
// Attribute escaping
// ==========================================

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  }
