export default async function handler(req, res) {
  try {
    // ==========================================
    // Google News RSS
    // ==========================================

    const rssUrl =
      "https://news.google.com/rss/search?q=Bangladesh&hl=bn&gl=BD&ceid=BD:bn";

    const response = await fetch(rssUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
      }
    });

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        error: "News source could not be reached."
      });
    }

    const xml = await response.text();

    // ==========================================
    // Extract RSS items
    // ==========================================

    const matches = [
      ...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)
    ];

    const items = [];

    // Maximum 10 news
    for (const match of matches.slice(0, 10)) {
      const item = match[1];

      const title = decodeHtml(
        getTag(item, "title")
      );

      const link = decodeHtml(
        getTag(item, "link")
      );

      const pubDate =
        getTag(item, "pubDate");

      const sourceMatch = item.match(
        /<source[^>]*>([\s\S]*?)<\/source>/i
      );

      const source = sourceMatch
        ? decodeHtml(sourceMatch[1])
        : "";

      // ==========================================
      // Try image directly from RSS
      // ==========================================

      let imageUrl =
        extractRssImage(item);

      // ==========================================
      // Try Google News article page
      // ==========================================

      let articleUrl = link;

      if (!imageUrl && link) {
        const pageResult =
          await extractArticleData(link);

        if (pageResult) {
          if (pageResult.url) {
            articleUrl = pageResult.url;
          }

          if (pageResult.image) {
            imageUrl = pageResult.image;
          }
        }
      }

      items.push({
        title,
        link,
        article_url: articleUrl,
        pubDate,
        source,
        image_url: imageUrl || ""
      });
    }

    return res.status(200).json({
      success: true,
      category: "জাতীয়",
      count: items.length,
      news: items
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "News collector failed.",
      details: error.message
    });
  }
}


// ==========================================
// Extract RSS image
// ==========================================

function extractRssImage(item) {
  // media:content
  const mediaContent =
    item.match(
      /<media:content[^>]+url=["']([^"']+)["'][^>]*>/i
    );

  if (mediaContent?.[1]) {
    return decodeHtml(mediaContent[1]);
  }

  // media:thumbnail
  const mediaThumbnail =
    item.match(
      /<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*>/i
    );

  if (mediaThumbnail?.[1]) {
    return decodeHtml(mediaThumbnail[1]);
  }

  // enclosure
  const enclosure =
    item.match(
      /<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i
    );

  if (enclosure?.[1]) {
    const url = decodeHtml(enclosure[1]);

    if (isLikelyImage(url)) {
      return url;
    }
  }

  // image tag
  const imageTag =
    item.match(
      /<image[^>]*>[\s\S]*?<url>([\s\S]*?)<\/url>[\s\S]*?<\/image>/i
    );

  if (imageTag?.[1]) {
    return decodeHtml(imageTag[1]);
  }

  return "";
}


// ==========================================
// Extract article URL + image
// ==========================================

async function extractArticleData(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      return {
        url: response.url || url,
        image: ""
      };
    }

    const html =
      await response.text();

    let image = "";

    // ==========================================
    // 1. og:image
    // ==========================================

    const ogImage =
      html.match(
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i
      ) ||
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i
      );

    if (ogImage?.[1]) {
      image = ogImage[1];
    }

    // ==========================================
    // 2. twitter:image
    // ==========================================

    if (!image) {
      const twitterImage =
        html.match(
          /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i
        ) ||
        html.match(
          /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i
        );

      if (twitterImage?.[1]) {
        image = twitterImage[1];
      }
    }

    // ==========================================
    // 3. JSON-LD image
    // ==========================================

    if (!image) {
      image = extractJsonLdImage(html);
    }

    // ==========================================
    // 4. First large article image fallback
    // ==========================================

    if (!image) {
      image = extractArticleImage(html);
    }

    // ==========================================
    // Convert relative image URL to absolute
    // ==========================================

    if (image) {
      image = makeAbsoluteUrl(
        image,
        response.url || url
      );
    }

    return {
      url: response.url || url,
      image: isLikelyImage(image)
        ? image
        : ""
    };

  } catch {
    return {
      url,
      image: ""
    };
  }
}


// ==========================================
// Extract image from JSON-LD
// ==========================================

function extractJsonLdImage(html) {
  const scripts = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  for (const match of scripts) {
    const raw = match[1].trim();

    try {
      const data = JSON.parse(raw);

      const image =
        findImageInJsonLd(data);

      if (image) {
        return image;
      }

    } catch {
      // Ignore invalid JSON-LD
    }
  }

  return "";
}


// ==========================================
// Recursive JSON-LD image search
// ==========================================

function findImageInJsonLd(data) {
  if (!data) {
    return "";
  }

  if (typeof data === "string") {
    if (isLikelyImage(data)) {
      return data;
    }

    return "";
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const result =
        findImageInJsonLd(item);

      if (result) {
        return result;
      }
    }

    return "";
  }

  if (typeof data === "object") {
    // Prefer image property
    if (data.image) {
      const image =
        findImageInJsonLd(data.image);

      if (image) {
        return image;
      }
    }

    // Check @graph
    if (data["@graph"]) {
      const result =
        findImageInJsonLd(data["@graph"]);

      if (result) {
        return result;
      }
    }

    // Generic fallback
    for (const key of Object.keys(data)) {
      const result =
        findImageInJsonLd(data[key]);

      if (result) {
        return result;
      }
    }
  }

  return "";
}


// ==========================================
// Article image fallback
// ==========================================

function extractArticleImage(html) {
  const imageMatches = [
    ...html.matchAll(
      /<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi
    )
  ];

  for (const match of imageMatches) {
    const image = match[1];

    if (!image) {
      continue;
    }

    if (
      image.includes("logo") ||
      image.includes("icon") ||
      image.includes("avatar") ||
      image.includes("favicon")
    ) {
      continue;
    }

    if (isLikelyImage(image)) {
      return image;
    }
  }

  return "";
}


// ==========================================
// Make absolute URL
// ==========================================

function makeAbsoluteUrl(image, baseUrl) {
  try {
    return new URL(
      decodeHtml(image),
      baseUrl
    ).href;
  } catch {
    return "";
  }
}


// ==========================================
// Check likely image URL
// ==========================================

function isLikelyImage(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  if (
    !url.startsWith("http://") &&
    !url.startsWith("https://")
  ) {
    return false;
  }

  const lower =
    url.toLowerCase();

  // Reject obvious non-image URLs
  if (
    lower.includes("favicon") ||
    lower.includes("icon") ||
    lower.includes("logo")
  ) {
    return false;
  }

  // Accept common image extensions
  if (
    /\.(jpg|jpeg|png|webp|gif)(\?|#|$)/i.test(url)
  ) {
    return true;
  }

  // Many news sites use image URLs without extensions.
  // Allow common image/CDN paths.
  if (
    lower.includes("/image/") ||
    lower.includes("/images/") ||
    lower.includes("/uploads/") ||
    lower.includes("/media/") ||
    lower.includes("/photo/") ||
    lower.includes("/photos/") ||
    lower.includes("imageproxy") ||
    lower.includes("cloudinary") ||
    lower.includes("imgix")
  ) {
    return true;
  }

  return false;
}


// ==========================================
// Get XML tag value
// ==========================================

function getTag(text, tag) {
  const match =
    text.match(
      new RegExp(
        `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
        "i"
      )
    );

  return match?.[1] || "";
}


// ==========================================
// Decode HTML entities
// ==========================================

function decodeHtml(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x3D;/gi, "=");
  }
