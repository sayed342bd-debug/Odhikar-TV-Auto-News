export default async function handler(req, res) {
  const blogId = "3875123745263845071";

  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  if (!redisUrl || !redisToken) {
    return res.status(500).json({
      success: false,
      error: "Redis environment variables are missing."
    });
  }

  try {
    // Get saved Google OAuth token from Redis
    const redisResponse = await fetch(
      `${redisUrl}/get/odhikar_tv_google_tokens`,
      {
        headers: {
          Authorization: `Bearer ${redisToken}`
        }
      }
    );

    const redisData = await redisResponse.json();
    const tokenData = redisData.result;

    if (!tokenData || !tokenData.access_token) {
      return res.status(401).json({
        success: false,
        error: "Google access token not found."
      });
    }

    // Create test post
    const postResponse = await fetch(
      `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          kind: "blogger#post",
          title: "Odhikar TV Auto News — Test Post",
          content: `
            <h2>Odhikar TV Auto News</h2>
            <p>এটি আমাদের Auto News System-এর প্রথম পরীক্ষামূলক পোস্ট।</p>
            <p>Google Blogger API সফলভাবে কাজ করছে।</p>
          `
        })
      }
    );

    const postData = await postResponse.json();

    if (!postResponse.ok) {
      return res.status(postResponse.status).json({
        success: false,
        error: "Blogger post failed.",
        details: postData
      });
    }

    return res.status(200).json({
      success: true,
      message: "Test post published successfully!",
      post_url: postData.url,
      post_id: postData.id
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Server error."
    });
  }
}
