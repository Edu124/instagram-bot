// ── ManyChat API Client ────────────────────────────────────────────────────────
// Sends messages back to customers via ManyChat's Send API
// ManyChat API docs: https://api.manychat.com
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");

const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY || "";
const BASE_URL         = "https://api.manychat.com/fb/sending";

// ── Send a plain text message ─────────────────────────────────────────────────
async function send(subscriberId, text) {
  // Test mode — capture replies instead of sending
  if (module.exports._testMode && module.exports._testReplies) {
    module.exports._testReplies.push(text);
    return;
  }

  if (!MANYCHAT_API_KEY) {
    console.log(`[ManyChat MOCK] → ${subscriberId}: ${text.slice(0, 80)}...`);
    return;
  }

  return apiPost("/sendContent", {
    subscriber_id: subscriberId,
    data: {
      version  : "v2",
      content  : {
        type    : "instagram",
        messages: [{ type: "text", text: sanitize(text) }],
      },
    },
  });
}

// ── Send product cards (image + title + price + button) ───────────────────────
async function sendProductCards(subscriberId, products) {
  if (module.exports._testMode && module.exports._testReplies) {
    const cardText = products.slice(0, 5).map((p, i) => {
      const priceStr = p.price > 0 ? `₹${p.price}` : "Contact";
      const postBadge = p.instaPostUrl ? " 📸" : "";
      return `${i + 1}. [${p.name}${postBadge} — ${priceStr}]`;
    }).join("\n");
    module.exports._testReplies.push(`📦 Product Cards:\n${cardText}`);
    return;
  }

  if (!MANYCHAT_API_KEY) {
    console.log(`[ManyChat MOCK] Sending ${products.length} product cards to ${subscriberId}`);
    return;
  }

  // ManyChat gallery element — shows scrollable product cards
  const elements = products.slice(0, 10).map((p, i) => {
    const priceStr = p.price > 0 ? `₹${p.price}` : "Contact for price";
    const sizeStr  = p.sizes?.length ? p.sizes.slice(0, 4).join(", ") : "";
    const colorStr = (p.colors || []).slice(0, 3).join(", ");

    const buttons = [
      { type: "postback", caption: `${i + 1}️⃣ Select`, target: `SELECT_${p.id}` },
    ];

    // Add "View Post" button if the product came from an Instagram post
    if (p.instaPostUrl || p._viewPostUrl) {
      buttons.push({
        type   : "url",
        caption: "🔗 View Post",
        url    : p.instaPostUrl || p._viewPostUrl,
      });
    } else {
      buttons.push({ type: "postback", caption: "🔍 Details", target: `DETAILS_${p.id}` });
    }

    return {
      title    : `${p.name} — ${priceStr}`,
      subtitle : `⭐ ${p.rating || "New"}${colorStr ? " | " + colorStr : ""}${sizeStr ? " | " + sizeStr : ""}`,
      image_url: p.imageUrl || "",
      buttons,
    };
  });

  return apiPost("/sendContent", {
    subscriber_id: subscriberId,
    data: {
      version : "v2",
      content : {
        type    : "instagram",
        messages: [{
          type    : "cards",
          elements,
          image_aspect_ratio: "square",
        }],
      },
    },
  });
}

// ── Send quick reply buttons ──────────────────────────────────────────────────
async function sendQuickReplies(subscriberId, text, replies) {
  if (!MANYCHAT_API_KEY) {
    console.log(`[ManyChat MOCK] Quick replies to ${subscriberId}: ${replies.join(", ")}`);
    return;
  }

  return apiPost("/sendContent", {
    subscriber_id: subscriberId,
    data: {
      version : "v2",
      content : {
        type    : "instagram",
        messages: [{
          type         : "text",
          text         : sanitize(text),
          quick_replies: replies.map(r => ({ type: "text", title: r })),
        }],
      },
    },
  });
}

// ── Send PDF invoice ──────────────────────────────────────────────────────────
async function sendInvoice(subscriberId, pdfBuffer, filename) {
  // ManyChat doesn't directly support PDF in Instagram DM
  // We upload to our server and send a link
  const url = await uploadToStorage(pdfBuffer, filename);
  return send(subscriberId, `📄 *Your Invoice:* ${url}`);
}

// ── Tag subscriber (for segmentation) ────────────────────────────────────────
async function addTag(subscriberId, tag) {
  if (!MANYCHAT_API_KEY) return;
  return apiPost("/addTag", { subscriber_id: subscriberId, tag_name: tag });
}

// ── Get subscriber info ───────────────────────────────────────────────────────
async function getSubscriber(subscriberId) {
  if (!MANYCHAT_API_KEY) return { id: subscriberId, first_name: "Test" };

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.manychat.com",
      path    : `/fb/subscriber/getInfo?subscriber_id=${subscriberId}`,
      method  : "GET",
      headers : {
        "Authorization": `Bearer ${MANYCHAT_API_KEY}`,
        "Content-Type" : "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({}); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Internal: POST to ManyChat API ────────────────────────────────────────────
function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: "api.manychat.com",
      path    : `/fb/sending${path}`,
      method  : "POST",
      headers : {
        "Authorization": `Bearer ${MANYCHAT_API_KEY}`,
        "Content-Type" : "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === "success") resolve(parsed);
          else {
            console.error("[ManyChat API Error]", parsed);
            resolve(parsed);
          }
        } catch { resolve({}); }
      });
    });

    req.on("error", (err) => {
      console.error("[ManyChat Request Error]", err.message);
      reject(err);
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── Sanitize text for Instagram DM ───────────────────────────────────────────
function sanitize(text) {
  return text.slice(0, 1000); // Instagram DM limit
}

// ── Mock file upload (replace with S3/Cloudinary in production) ──────────────
async function uploadToStorage(buffer, filename) {
  // TODO: implement actual file upload
  return `https://your-server.com/invoices/${filename}`;
}

module.exports = { send, sendProductCards, sendQuickReplies, sendInvoice, addTag, getSubscriber };
