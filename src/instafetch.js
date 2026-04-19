// ── Instagram Post Fetcher ─────────────────────────────────────────────────────
// Extracts image + caption from an Instagram post URL.
//
// Uses two strategies (no API key needed for either):
//   1. Instagram oEmbed API  — public, no auth required, gives thumbnail + title
//   2. Regex scrape fallback — parses og:image from the post page HTML
//
// In production you can upgrade to Graph API for full-resolution images.
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");
const http  = require("http");

// ── Detect if a string is an Instagram post URL ───────────────────────────────
function isInstaUrl(text) {
  return /instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]+/i.test(text);
}

// ── Extract shortcode from URL ────────────────────────────────────────────────
// https://www.instagram.com/p/AbCdEf123/ → AbCdEf123
function extractShortcode(url) {
  const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// ── Main: fetch post data from Instagram URL ──────────────────────────────────
// Returns: { imageUrl, caption, shortcode, postUrl, authorName }
// Throws on failure.
async function fetchPostData(postUrl) {
  // Normalize URL
  const cleanUrl = postUrl.split("?")[0].replace(/\/$/, "") + "/";

  // Try oEmbed first (fastest, no auth)
  try {
    const data = await fetchOEmbed(cleanUrl);
    return {
      imageUrl  : data.thumbnail_url  || "",
      caption   : data.title          || "",
      shortcode : extractShortcode(cleanUrl),
      postUrl   : cleanUrl,
      authorName: data.author_name    || "",
    };
  } catch (oembedErr) {
    console.warn("[instafetch] oEmbed failed:", oembedErr.message, "— trying scrape");
  }

  // Fallback: scrape og:image from the post page
  try {
    const html     = await fetchHtml(cleanUrl);
    const imageUrl = extractOgImage(html);
    const caption  = extractOgDescription(html);
    return {
      imageUrl,
      caption,
      shortcode : extractShortcode(cleanUrl),
      postUrl   : cleanUrl,
      authorName: "",
    };
  } catch (scrapeErr) {
    console.warn("[instafetch] Scrape failed:", scrapeErr.message);
    // Return partial data — at minimum we have the post URL
    return {
      imageUrl  : "",
      caption   : "",
      shortcode : extractShortcode(cleanUrl),
      postUrl   : cleanUrl,
      authorName: "",
    };
  }
}

// ── oEmbed API ────────────────────────────────────────────────────────────────
// GET https://graph.facebook.com/v18.0/instagram_oembed?url=...&maxwidth=640
function fetchOEmbed(postUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    function done(err, val) { if (settled) return; settled = true; if (err) reject(err); else resolve(val); }

    const apiUrl = `https://graph.facebook.com/v18.0/instagram_oembed` +
                   `?url=${encodeURIComponent(postUrl)}&maxwidth=640&omitscript=true`;

    const req = https.get(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("error", e => done(e));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error)         return done(new Error(parsed.error.message));
          if (!parsed.thumbnail_url) return done(new Error("No thumbnail in oEmbed"));
          done(null, parsed);
        } catch (e) {
          done(new Error("oEmbed parse error: " + e.message));
        }
      });
    });
    req.on("error", e => done(e));
    req.setTimeout(8000, () => { req.destroy(); done(new Error("oEmbed timeout")); });
  });
}

// ── Scrape og:image from post HTML ───────────────────────────────────────────
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    function done(err, val) {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
    }

    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent" : "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept"     : "text/html",
      }
    }, (res) => {
      // Follow one redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location).then(v => done(null, v)).catch(e => done(e));
      }
      let data = "";
      res.on("data", c => { data += c; if (data.length > 80000) { req.destroy(); done(null, data); } });
      res.on("end",  () => done(null, data));
      res.on("error", e  => done(e));
    });
    // Single error handler with settled guard — prevents double-reject on destroy
    req.on("error", e => done(e));
    req.setTimeout(8000, () => { req.destroy(); done(new Error("HTML fetch timeout")); });
  });
}

function extractOgImage(html) {
  const m = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  return m ? m[1] : "";
}

function extractOgDescription(html) {
  const m = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  return m ? decodeHtmlEntities(m[1]) : "";
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, " ");
}

// ── Guess product name from caption ──────────────────────────────────────────
// Extracts the first meaningful line of a caption as the product name
function guessName(caption) {
  if (!caption) return "";
  // Take first non-hashtag line
  const lines = caption.split(/[\n|]+/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const clean = line.replace(/#\w+/g, "").replace(/[^\w\s₹%,.-]/g, "").trim();
    if (clean.length >= 3 && clean.length <= 60) return clean;
  }
  return lines[0]?.slice(0, 60) || "";
}

// ── Guess category from caption ───────────────────────────────────────────────
function guessCategory(caption = "") {
  const text = caption.toLowerCase();
  const map  = [
    ["candle",  ["candle","wax","aroma","scent","fragrance"]],
    ["jeans",   ["jeans","denim"]],
    ["kurti",   ["kurti","kurta"]],
    ["saree",   ["saree","sari"]],
    ["shirt",   ["shirt","formal"]],
    ["tshirt",  ["tshirt","t-shirt","tee"]],
    ["dress",   ["dress","gown","frock"]],
    ["bag",     ["bag","purse","handbag","tote"]],
    ["shoes",   ["shoes","sandal","heels","footwear"]],
    ["jewellery",["jewellery","jewelry","necklace","earring","ring","bracelet"]],
    ["decor",   ["decor","home","gift","handmade","craft"]],
  ];
  for (const [cat, kws] of map) {
    if (kws.some(kw => text.includes(kw))) return cat;
  }
  return "general";
}

// ── Guess colors from caption ─────────────────────────────────────────────────
function guessColors(caption = "") {
  const text   = caption.toLowerCase();
  const colors = ["red","blue","black","white","green","yellow","pink","purple",
                  "orange","grey","gray","brown","maroon","navy","cream","beige",
                  "lavender","rose","gold","silver","nude","ivory","coral"];
  return colors.filter(c => text.includes(c)).map(c => c[0].toUpperCase() + c.slice(1));
}

module.exports = { isInstaUrl, fetchPostData, guessName, guessCategory, guessColors, extractShortcode };
