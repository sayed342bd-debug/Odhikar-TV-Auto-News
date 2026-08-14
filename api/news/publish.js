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
    // 1. Get Google OAuth tokens from Redis
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

    // ==========================================
    // 2. Get access token
    // ==========================================

    let accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: "Google access token not found."
      });
    }

    // ==========================================
    // 3. Get Blogger Blog ID
    // ==========================================

    const blogUrl = "https://odhikartv01.blogspot.com/";

    let blogResponse = await fetch(
      `https://www.googleapis.com/blogger/v3/blogs/byurl?url=${encodeURIComponent(
        blogUrl
      )}&fetchUserInfo=false`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    // ==========================================
    // 4. Refresh token if access token expired
    // ==========================================

    if (blogResponse.status === 401) {
      if (!tokenData.refresh_token) {
        return res.status(401).json({
          success: false,
          error: "Google access token expired and no refresh token is available. Please reconnect Blogger."
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
          error: "Unable to refresh Google access token.",
          details: refreshData
        });
      }

      accessToken = refreshData.access_token;

      // Save refreshed access token
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

      // Retry Blogger request
      blogResponse = await fetch(
        `https://www.googleapis.com/blogger/v3/blogs/byurl?url=${encodeURIComponent(
          blogUrl
        )}&fetchUserInfo=false`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );
    }

    if (!blogResponse.ok) {
      const blogError = await blogResponse.text();

      return res.status(500).json({
        success: false,
        error: "Unable to access Blogger blog.",
        details: blogError
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
    // 5. Find draft keys
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
    // 6. Publish drafts
    // ==========================================

    for (const draftKey of draftKeys.slice(0, 5)) {
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

      // Skip already published drafts
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
      // 7. Create Blogger HTML content
      // ==========================================

      const safeTitle = escapeHtml(draft.title);
      const safeSummary = escapeHtml(draft.summary);
      const safeSource = escapeHtml(draft.source || "সংবাদ সূত্র");
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
      // 8. Publish to Blogger
      // ==========================================

      const publishResponse = await fetch(
        `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            kind: "blogger#post",
            title: draft.title,
            content: content,
            labels: [draft.category || "অন্যান্য"]
          })
        }
      );

      const publishText = await publishResponse.text();

      if (!publishResponse.ok) {
        results.push({
          draft_key: draftKey,
          title: draft.title,
          status: "publish_error",
          error: publishText
        });

        continue;
      }

      let publishedPost;

      try {
        publishedPost = JSON.parse(publishText);
      } catch {
        publishedPost = {};
      }

      // ==========================================
      // 9. Mark draft as published
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
// Redis REST command
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
// HTML attribute escaping
// ==========================================

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
          }
