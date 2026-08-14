export default async function handler(req, res) {
  const code = req.query.code;

  if (!code) {
    return res.status(400).json({
      error: "Authorization code is missing."
    });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !redisUrl ||
    !redisToken
  ) {
    return res.status(500).json({
      error: "Required environment variables are missing."
    });
  }

  try {
    // Exchange authorization code for Google tokens
    const tokenResponse = await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code"
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      return res.status(400).json({
        error: "Google OAuth token exchange failed."
      });
    }

    // Save the token data in Upstash Redis
    const redisResponse = await fetch(
      `${redisUrl}/set/odhikar_tv_google_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${redisToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(tokenData)
      }
    );

    if (!redisResponse.ok) {
      const redisError = await redisResponse.text();

      return res.status(500).json({
        error: "Failed to save Google tokens."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Google Blogger connected and token saved successfully.",
      token_saved: true
    });

  } catch (error) {
    return res.status(500).json({
      error: "OAuth callback failed."
    });
  }
}
