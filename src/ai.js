// ── AI Module ──────────────────────────────────────────────────────────────────
// Connects to CodeForge local LLM (port 7471 WebSocket) for:
//   1. Search intent extraction from natural language
//   2. Product content generation from images
// ─────────────────────────────────────────────────────────────────────────────

const WebSocket = require("ws");
const HUB_URL   = process.env.HUB_URL || "ws://127.0.0.1:7471";

// ── Extract search intent from natural language ───────────────────────────────
// Input:  "blue cotton jeans under 800 rupees size 32"
// Output: { product:"jeans", color:"blue", material:"cotton", maxPrice:800, size:"32", rawQuery:"..." }
async function extractSearchIntent(message) {
  const prompt = buildIntentPrompt(message);

  try {
    const response = await queryLLM(prompt, 200);
    const json     = extractJSON(response);
    return { ...json, rawQuery: message };
  } catch {
    // Fallback: regex-based parser (works without LLM)
    return regexFallback(message);
  }
}

// ── Generate product content from image URL ───────────────────────────────────
// Returns: { caption, hashtags, music:[], suggestedPrice }
async function generateProductContent(imageUrl) {
  // Note: local LLM may not support vision — fallback to text-only generation
  const prompt = buildContentPrompt(imageUrl);

  try {
    const response = await queryLLM(prompt, 400);
    const json     = extractJSON(response);
    return {
      caption       : json.caption        || "Beautiful product available now! DM to order 💫",
      hashtags      : json.hashtags        || "#fashion #shopping #instashopping #ootd",
      music         : json.music           || ["Trending audio", "Lo-fi beats", "Upbeat pop"],
      suggestedPrice: json.suggestedPrice  || "Contact for price",
    };
  } catch {
    return {
      caption       : "✨ New arrival! DM us to order.\n\n#fashion #shopping #instashopping",
      hashtags      : "#fashion #shopping #handmade #instashopping #ootd",
      music         : ["Trending audio 🎵", "Calm lo-fi beats", "Upbeat pop"],
      suggestedPrice: "Contact for price",
    };
  }
}

// ── Build intent extraction prompt ───────────────────────────────────────────
function buildIntentPrompt(message) {
  return `<|im_start|>system
You extract shopping search intent from customer messages.
Return ONLY a JSON object — no explanation.

JSON fields (all optional, omit if not mentioned):
- product: main product type (e.g. "jeans", "shirt", "saree")
- color: color preference
- size: size (S/M/L/XL or 28/30/32 etc.)
- material: fabric/material
- maxPrice: maximum price as number (extract from "under 800", "less than 500")
- minPrice: minimum price as number
- category: broader category
- gender: "men" | "women" | "unisex"
<|im_end|>
<|im_start|>user
Customer message: "${message}"
<|im_end|>
<|im_start|>assistant
`;
}

// ── Build content generation prompt ──────────────────────────────────────────
function buildContentPrompt(imageUrl) {
  return `<|im_start|>system
You generate Instagram content for product posts.
Return ONLY a JSON object with these fields:
- caption: engaging Instagram caption (2-4 lines, with emojis, ends with CTA to DM)
- hashtags: 15-20 relevant hashtags as a string
- music: array of 3 music/audio suggestions for Reels
- suggestedPrice: suggested price range based on typical market rates
<|im_end|>
<|im_start|>user
Generate Instagram content for this product image: ${imageUrl}
<|im_end|>
<|im_start|>assistant
`;
}

// ── Query local LLM via WebSocket ─────────────────────────────────────────────
function queryLLM(prompt, maxTokens = 300) {
  return new Promise((resolve, reject) => {
    let ws;

    try {
      ws = new WebSocket(HUB_URL);
    } catch {
      reject(new Error("Cannot connect to CodeForge AI server"));
      return;
    }

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("LLM timeout"));
    }, 15000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type           : "browser_query",
        question       : prompt,
        pageTitle      : "Instagram Bot",
        pageUrl        : "",
        pageContent    : "",
        suggestedTokens: maxTokens,
      }));
    });

    let accumulated = "";

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "token") {
          accumulated += msg.content || "";
        } else if (msg.type === "done") {
          clearTimeout(timeout);
          ws.close();
          resolve(accumulated);
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.message));
        }
      } catch {}
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Regex-based intent parser (no LLM needed) ─────────────────────────────────
// Handles: "blue jeans under 500", "cotton kurti size M", "red saree below 800"
function regexFallback(message) {
  let text = message.toLowerCase().trim();

  const intent = { rawQuery: message };

  // ── Price extraction ──────────────────────────────────────────────────────
  // "under 500", "below 800", "less than 1000", "upto 600", "max 700", "within 400"
  const maxPriceMatch = text.match(
    /(?:under|below|less\s*than|upto|up\s*to|max(?:imum)?|within|kam\s*se|se\s*kam|₹?)\s*₹?\s*(\d+)/i
  );
  if (maxPriceMatch) {
    intent.maxPrice = parseInt(maxPriceMatch[1]);
    text = text.replace(maxPriceMatch[0], "").trim();
  }

  // "above 500", "more than 300", "minimum 400"
  const minPriceMatch = text.match(
    /(?:above|more\s*than|minimum|min|over)\s*₹?\s*(\d+)/i
  );
  if (minPriceMatch) {
    intent.minPrice = parseInt(minPriceMatch[1]);
    text = text.replace(minPriceMatch[0], "").trim();
  }

  // "between 300 and 700"
  const rangeMatch = text.match(/between\s*₹?\s*(\d+)\s*(?:and|to|-)\s*₹?\s*(\d+)/i);
  if (rangeMatch) {
    intent.minPrice = parseInt(rangeMatch[1]);
    intent.maxPrice = parseInt(rangeMatch[2]);
    text = text.replace(rangeMatch[0], "").trim();
  }

  // ── Size extraction ────────────────────────────────────────────────────────
  const sizeMatch = text.match(
    /\b(xs|small|medium|large|xl|xxl|xxxl|size\s*[smlx]+|\b[smlx]{1,3}\b|\b[23][0-9]\b)\b/i
  );
  if (sizeMatch) {
    intent.size = sizeMatch[1].replace(/size\s*/i,"").trim().toUpperCase();
    text = text.replace(sizeMatch[0], "").trim();
  }

  // ── Color extraction ──────────────────────────────────────────────────────
  const colors = ["red","blue","black","white","green","yellow","pink","purple",
    "orange","grey","gray","brown","maroon","navy","cream","beige","dark","light"];
  const colorMatch = colors.find(c => text.includes(c));
  if (colorMatch) {
    intent.color = colorMatch;
    text = text.replace(colorMatch, "").trim();
  }

  // ── Material extraction ────────────────────────────────────────────────────
  const materials = ["cotton","silk","denim","linen","polyester","wool","rayon","chiffon"];
  const matMatch  = materials.find(m => text.includes(m));
  if (matMatch) {
    intent.material = matMatch;
    text = text.replace(matMatch, "").trim();
  }

  // ── Product keyword — what's left after removing all filters ─────────────
  // Clean up filler words
  const fillers = ["show","me","want","need","looking","for","a","an","the",
    "some","any","good","nice","please","chahiye","mujhe","dikhao"];
  let product = text;
  fillers.forEach(f => { product = product.replace(new RegExp(`\\b${f}\\b`,"gi"),""); });
  product = product.replace(/\s+/g," ").trim();

  if (product) intent.product = product;

  return intent;
}

// ── Extract JSON from LLM response ───────────────────────────────────────────
function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response");
  return JSON.parse(match[0]);
}

module.exports = { extractSearchIntent, generateProductContent };
