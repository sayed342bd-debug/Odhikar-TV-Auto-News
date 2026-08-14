export default async function handler(req, res) {
  // ==========================================
  // 1. Allow only GET
  // ==========================================

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed."
    });
  }

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
    // 2. Get saved Google OAuth tokens
    // ==========================================

    const tokenResponse = await redisCommand(
      redisUrl,
      redisToken,
      ["GET", "odhikar_tv_google_tokens"]
    );

    if (tokenResponse.error) {
      return res.status(500).json({
        success: false,
        error: "Unable to read Google tokens from Redis.",
        details: tokenResponse.error
      });
    }

    if (!tokenResponse.result) {
      return res.status(401).json({
        success: false,
        error:
          "Google Blogger tokens not found. Please connect Blogger again."
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
    // 3. Find Blogger Blog ID
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
    // 4. Refresh Google access token if expired
    // ==========================================

    if (blogResponse.status === 401) {
      const refreshed = await refreshGoogleToken(
        redisUrl,
        redisToken,
        tokenData
      );

      if (!refreshed.success) {
        return res.status(401).json({
          success: false,
          error: refreshed.error
        });
      }

      accessToken = refreshed.accessToken;
      tokenData = refreshed.tokenData;

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
        details: errorText.slice(0, 2000)
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
    // 5. Get ALL draft keys
    // ==========================================

    const draftKeysResult = await scanAllDraftKeys(
      redisUrl,
      redisToken
    );

    if (draftKeysResult.error) {
      return res.status(500).json({
        success: false,
        error: "Unable to scan news drafts.",
        details: draftKeysResult.error
      });
    }

    const draftKeys = draftKeysResult.keys;

    if (draftKeys.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No news drafts found.",
        published: 0,
        skipped: 0,
        results: []
      });
    }

    // ==========================================
    // 6. Load drafts and find publishable drafts
    // ==========================================

    const publishableDrafts = [];
    const results = [];
    let skipped = 0;

    for (const draftKey of draftKeys) {
      // Stop collecting once we have enough to publish.
      if (publishableDrafts.length >= 2) {
        break;
      }

      const draftResponse = await redisCommand(
        redisUrl,
        redisToken,
        ["GET", draftKey]
      );

      if (draftResponse.error) {
        results.push({
          draft_key: draftKey,
          status: "redis_error",
          error: draftResponse.error
        });

        skipped++;
        continue;
      }

      if (!draftResponse.result) {
        results.push({
          draft_key: draftKey,
          status: "draft_not_found"
        });

        skipped++;
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

        skipped++;
        continue;
      }

      // ------------------------------------------
      // Already published
      // ------------------------------------------

      if (draft.status === "published") {
        results.push({
          draft_key: draftKey,
          title: draft.title || "",
          status: "already_published"
        });

        skipped++;
        continue;
      }

      // ------------------------------------------
      // Only publish actual drafts
      // ------------------------------------------

      if (draft.status && draft.status !== "draft") {
        results.push({
          draft_key: draftKey,
          title: draft.title || "",
          status: "skipped_status",
          draft_status: draft.status
        });

        skipped++;
        continue;
      }

      // ------------------------------------------
      // Validate content
      // ------------------------------------------

      if (
        typeof draft.title !== "string" ||
        typeof draft.summary !== "string" ||
        !draft.title.trim() ||
        !draft.summary.trim()
      ) {
        results.push({
          draft_key: draftKey,
          title: draft.title || "",
          status: "invalid_draft_content"
        });

        skipped++;
        continue;
      }

      publishableDrafts.push({
        key: draftKey,
        draft
      });
    }

    // ==========================================
    // 7. Publish selected drafts
    // ==========================================

    for (const item of publishableDrafts) {
      const { key: draftKey, draft } = item;

      const safeTitle = escapeHtml(draft.title.trim());
      const safeSummary = escapeHtml(draft.summary.trim());

      const safeSource = escapeHtml(
        draft.source || "সংবাদ সূত্র"
      );

      const sourceUrl = sanitizeUrl(
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
    sourceUrl
      ? `
  <p>
    <strong>মূল সংবাদ:</strong>
    <a href="${escapeAttribute(sourceUrl)}"
       target="_blank"
       rel="noopener noreferrer">
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

      let publishResult = await publishWithRetry(
        blogId,
        accessToken,
        {
          title: draft.title.trim(),
          content,
          labels: [draft.category || "অন্যান্য"]
        }
      );

      // ==========================================
      // 9. If Google token expired during publish,
      //    refresh and retry once
      // ==========================================

      if (
        !publishResult.success &&
        publishResult.status === 401
      ) {
        const refreshed = await refreshGoogleToken(
          redisUrl,
          redisToken,
          tokenData
        );

        if (refreshed.success) {
          accessToken = refreshed.accessToken;
          tokenData = refreshed.tokenData;

          publishResult = await publishWithRetry(
            blogId,
            accessToken,
            {
              title: draft.title.trim(),
              content,
              labels: [draft.category || "অন্যান্য"]
            }
          );
        }
      }

      // ==========================================
      // 10. Publishing failed
      // ==========================================

      if (!publishResult.success) {
        results.push({
          draft_key: draftKey,
          title: draft.title,
          status: "publish_error",
          error: publishResult.error
        });

        continue;
      }

      const publishedPost = publishResult.post || {};

      // ==========================================
      // 11. Mark draft as published
      // ==========================================

      const updatedDraft = {
        ...draft,

        status: "published",

        blogger_post_id:
          publishedPost.id || null,

        blogger_url:
          publishedPost.url || null,

        blogger_published_at:
          new Date().toISOString(),

        published_at:
          new Date().toISOString()
      };

      const updateResponse = await redisCommand(
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

      if (updateResponse.error) {
        results.push({
          draft_key: draftKey,
          title: draft.title,
          status: "published_but_redis_update_failed",
          blogger_url: publishedPost.url || null,
          error: updateResponse.error
        });

        continue;
      }

      // ==========================================
      // 12. Success
      // ==========================================

      results.push({
        draft_key: draftKey,
        title: draft.title,
        category: draft.category || "অন্যান্য",
        status: "published",
        blogger_post_id:
          publishedPost.id || null,
        blogger_url:
          publishedPost.url || null
      });

      // Small delay between posts.
      await sleep(5000);
    }

    // ==========================================
    // 13. Final response
    // ==========================================

    return res.status(200).json({
      success: true,
      message: "Blogger auto publishing completed.",

      scanned_drafts: draftKeys.length,

      selected_for_publish:
        publishableDrafts.length,

      published:
        results.filter(
          item => item.status === "published"
        ).length,

      skipped,

      publish_errors:
        results.filter(
          item =>
            item.status === "publish_error"
        ).length,

      results
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Blogger publishing failed.",
      details:
        error?.message || "Unknown error."
    });
  }
}


// ==========================================
// Google OAuth token refresh
// ==========================================

async function refreshGoogleToken(
  redisUrl,
  redisToken,
  tokenData
) {
  try {
    if (!tokenData.refresh_token) {
      return {
        success: false,
        error:
          "Google access token expired and no refresh token is available. Please reconnect Blogger."
      };
    }

    const clientId =
      process.env.GOOGLE_CLIENT_ID;

    const clientSecret =
      process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return {
        success: false,
        error:
          "Google OAuth client credentials are missing."
      };
    }

    const response = await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token:
            tokenData.refresh_token,
          grant_type:
            "refresh_token"
        })
      }
    );

    const data = await response.json();

    if (
      !response.ok ||
      !data.access_token
    ) {
      return {
        success: false,
        error:
          "Unable to refresh Google access token."
      };
    }

    const updatedTokenData = {
      ...tokenData,
      access_token:
        data.access_token
    };

    if (data.expires_in) {
      updatedTokenData.expires_in =
        data.expires_in;
    }

    const saveResponse =
      await redisCommand(
        redisUrl,
        redisToken,
        [
          "SET",
          "odhikar_tv_google_tokens",
          JSON.stringify(
            updatedTokenData
          )
        ]
      );

    if (saveResponse.error) {
      return {
        success: false,
        error:
          "Google token refreshed but could not be saved to Redis."
      };
    }

    return {
      success: true,
      accessToken:
        data.access_token,
      tokenData:
        updatedTokenData
    };

  } catch (error) {
    return {
      success: false,
      error:
        error?.message ||
        "Google token refresh failed."
    };
  }
}


// ==========================================
// Blogger request helper
// ==========================================

async function bloggerRequest(
  url,
  options = {}
) {
  return fetch(url, {
    method:
      options.method || "GET",

    headers: {
      Authorization:
        `Bearer ${options.accessToken}`,

      "Content-Type":
        "application/json"
    },

    body:
      options.body
  });
}


// ==========================================
// Blogger publish with retry
// ==========================================

async function publishWithRetry(
  blogId,
  accessToken,
  postData
) {
  const maxAttempts = 4;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      const response =
        await fetch(
          `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              kind: "blogger#post",

              title:
                postData.title,

              content:
                postData.content,

              labels:
                postData.labels
            })
          }
        );

      const text =
        await response.text();

      // ----------------------------------------
      // Success
      // ----------------------------------------

      if (response.ok) {
        try {
          return {
            success: true,
            post:
              JSON.parse(text)
          };
        } catch {
          return {
            success: false,
            error:
              "Blogger returned an invalid response."
          };
        }
      }

      // ----------------------------------------
      // Unauthorized
      // ----------------------------------------

      if (response.status === 401) {
        return {
          success: false,
          status: 401,
          error:
            "Google access token expired or is unauthorized."
        };
      }

      // ----------------------------------------
      // Rate limit
      // ----------------------------------------

      if (
        response.status === 429 ||
        response.status === 503
      ) {
        if (
          attempt ===
          maxAttempts
        ) {
          return {
            success: false,
            status:
              response.status,
            error:
              "Blogger rate limit/service unavailable after multiple retries."
          };
        }

        const retryAfter =
          response.headers.get(
            "retry-after"
          );

        let delay;

        if (
          retryAfter &&
          !isNaN(
            Number(retryAfter)
          )
        ) {
          delay =
            Number(retryAfter) *
            1000;
        } else {
          delay =
            Math.pow(
              2,
              attempt
            ) * 5000;
        }

        await sleep(
          Math.min(
            delay,
            30000
          )
        );

        continue;
      }

      // ----------------------------------------
      // Other Blogger error
      // ----------------------------------------

      return {
        success: false,
        status:
          response.status,
        error:
          text.slice(
            0,
            2000
          )
      };

    } catch (error) {
      if (
        attempt ===
        maxAttempts
      ) {
        return {
          success: false,
          error:
            error?.message ||
            "Blogger request failed."
        };
      }

      await sleep(
        Math.pow(
          2,
          attempt
        ) * 3000
      );
    }
  }

  return {
    success: false,
    error:
      "Publishing failed."
  };
}


// ==========================================
// Scan ALL news:draft:* keys
// ==========================================

async function scanAllDraftKeys(
  redisUrl,
  redisToken
) {
  const keys = [];

  let cursor = "0";

  try {
    do {
      const response =
        await redisCommand(
          redisUrl,
          redisToken,
          [
            "SCAN",
            cursor,
            "MATCH",
            "news:draft:*",
            "COUNT",
            "100"
          ]
        );

      if (response.error) {
        return {
          keys,
          error:
            response.error
        };
      }

      const result =
        response.result;

      if (
        !Array.isArray(
          result
        ) ||
        !Array.isArray(
          result[1]
        )
      ) {
        break;
      }

      cursor =
        String(
          result[0]
        );

      keys.push(
        ...result[1]
      );

    } while (
      cursor !== "0"
    );

    // Remove duplicate keys.
    return {
      keys:
        [...new Set(keys)]
    };

  } catch (error) {
    return {
      keys,
      error:
        error?.message ||
        "Redis SCAN failed."
    };
  }
}


// ==========================================
// Safe URL validation
// ==========================================

function sanitizeUrl(value) {
  const url =
    String(value || "").trim();

  if (!url) {
    return "";
  }

  try {
    const parsed =
      new URL(url);

    if (
      parsed.protocol !==
        "https:" &&
      parsed.protocol !==
        "http:"
    ) {
      return "";
    }

    return parsed.toString();

  } catch {
    return "";
  }
}


// ==========================================
// HTML escaping
// ==========================================

function escapeHtml(value) {
  return String(value)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}


// ==========================================
// HTML attribute escaping
// ==========================================

function escapeAttribute(value) {
  return String(value)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    );
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
    const response =
      await fetch(
        `${url}/pipeline`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify([
              command
            ])
        }
      );

    const text =
      await response.text();

    if (!response.ok) {
      return {
        result: null,
        error:
          text.slice(
            0,
            2000
          )
      };
    }

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      return {
        result: null,
        error:
          "Invalid Redis response."
      };
    }

    return {
      result:
        data[0]?.result ??
        null,

      error:
        data[0]?.error ||
        null
    };

  } catch (error) {
    return {
      result: null,
      error:
        error?.message ||
        "Redis request failed."
    };
  }
}


// ==========================================
// Sleep helper
// ==========================================

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
    }
