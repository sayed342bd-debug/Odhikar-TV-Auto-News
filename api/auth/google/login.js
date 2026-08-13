export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      error: "Google OAuth environment variables are missing."
    });
  }

  const scope = encodeURIComponent(
    "https://www.googleapis.com/auth/blogger"
  );

  const googleAuthUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    "&response_type=code" +
    `&scope=${scope}` +
    "&access_type=offline" +
    "&prompt=consent";

  res.redirect(302, googleAuthUrl);
}
