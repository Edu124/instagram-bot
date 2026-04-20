// ── Instagram / ManyChat Message Sender ───────────────────────────────────────
// Sends messages via Instagram Graph API (preferred) or ManyChat (fallback)
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");

const INSTAGRAM_TOKEN  = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const INSTAGRAM_PAGE_ID = process.env.INSTAGRAM_PAGE_ID    || "";
const MANYCHAT_API_KEY  = process.env.MANYCHAT_API_KEY      || "";

// ── Send a plain text message ─────────────────────────────────────────────────
async function send(subscriberId, text) {
  // Test mode
  if (module.exports._testMode && module.exports._testReplies) {
    module.exports._testReplies.push(text);
    return;
  }

  // Use Instagram Graph API if token is available
  if (INSTAGRAM_TOKEN && INSTAGRAM_PAGE_ID) {
    return sendViaInstagram(subscriberId, text);
  }

  // Fallback to ManyChat
  if (MANYCHAT_API_KEY) {
    return sendViaManyChat(subscriberId, text);
  }

  console.log(`[Bot MOCK] → ${subscriberId}: ${text.slice(0, 80)}`);
}

// ── Instagram Graph API sender ────────────────────────────────────────────────
function sendViaInstagram(recipientId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message  : { text: sanitize(text) },
    });

    const options = {
      hostname: "graph.instagram.com",
      path    : `/v21.0/${INSTAGRAM_PAGE_ID}/messages`,
      method  : "POST",
      headers : {
        "Authorization" : `Bearer ${INSTAGRAM_TOKEN}`,
        "Content-Type"  : "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) console.error("[Instagram API Error]", parsed.error.message);
          resolve(parsed);
        } catch { resolve({}); }
      });
    });

    req.on("error", (err) => {
      console.error("[Instagram Request Error]", err.message);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ── ManyChat fallback sender ──────────────────────────────────────────────────
function sendViaManyChat(subscriberId, text) {
  return apiPost("/sendContent", {
    subscriber_id: subscriberId,
    data: {
      version : "v2",
      content : {
        type    : "instagram",
        messages: [{ type: "text", text: sanitize(text) }],
      },
    },
  });
}

// ── Send product cards ────────────────────────────────────────────────────────
async function sendProductCards(subscriberId, products) {
  if (module.exports._testMode && module.exports._testReplies) {
    const cardText = products.slice(0, 5).map((p, i) => {
      const priceStr = p.price > 0 ? `₹${p.price}` : "Contact";
      return `${i + 1}. [${p.name} — ${priceStr}]`;
    }).join("\n");
    module.exports._testReplies.push(`📦 Products:\n${cardText}`);
    return;
  }

  // Instagram API only supports text — send as formatted text
  if (INSTAGRAM_TOKEN && INSTAGRAM_PAGE_ID) {
    const text = products.slice(0, 10).map((p, i) => {
      const priceStr = p.price > 0 ? `₹${p.price}` : "Contact";
      const sizeStr  = p.sizes?.length ? ` | Sizes: ${p.sizes.slice(0, 4).join(", ")}` : "";
      return `${i + 1}. ${p.name} — ${priceStr}${sizeStr}`;
    }).join("\n");
    return send(subscriberId, `📦 Our Products:\n\n${text}\n\nReply with the number to order.`);
  }

  // ManyChat gallery cards
  if (!MANYCHAT_API_KEY) {
    console.log(`[Bot MOCK] Sending ${products.length} product cards`);
    return;
  }

  const elements = products.slice(0, 10).map((p, i) => ({
    title    : `${p.name} — ${p.price > 0 ? `₹${p.price}` : "Contact"}`,
    subtitle : p.sizes?.length ? `Sizes: ${p.sizes.slice(0, 4).join(", ")}` : "",
    image_url: p.imageUrl || "",
    buttons  : [{ type: "postback", caption: `${i + 1}️⃣ Select`, target: `SELECT_${p.id}` }],
  }));

  return apiPost("/sendContent", {
    subscriber_id: subscriberId,
    data: { version: "v2", content: { type: "instagram", messages: [{ type: "cards", elements, image_aspect_ratio: "square" }] } },
  });
}

// ── Send quick replies ────────────────────────────────────────────────────────
async function sendQuickReplies(subscriberId, text, replies) {
  // Instagram API doesn't support quick reply buttons — send as text
  const replyText = `${text}\n\n${replies.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
  return send(subscriberId, replyText);
}

// ── Send invoice ──────────────────────────────────────────────────────────────
async function sendInvoice(subscriberId, pdfBuffer, filename) {
  return send(subscriberId, `📄 Your invoice has been generated. Invoice No: ${filename}`);
}

// ── Tag subscriber ────────────────────────────────────────────────────────────
async function addTag(subscriberId, tag) {
  if (!MANYCHAT_API_KEY) return;
  return apiPost("/addTag", { subscriber_id: subscriberId, tag_name: tag });
}

// ── Get subscriber info ───────────────────────────────────────────────────────
async function getSubscriber(subscriberId) {
  if (!MANYCHAT_API_KEY) return { id: subscriberId, first_name: "Customer" };
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.manychat.com",
      path    : `/fb/subscriber/getInfo?subscriber_id=${subscriberId}`,
      method  : "GET",
      headers : { "Authorization": `Bearer ${MANYCHAT_API_KEY}`, "Content-Type": "application/json" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── ManyChat API POST ─────────────────────────────────────────────────────────
function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: "api.manychat.com",
      path    : `/fb/sending${path}`,
      method  : "POST",
      headers : {
        "Authorization" : `Bearer ${MANYCHAT_API_KEY}`,
        "Content-Type"  : "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on("error", (err) => { console.error("[ManyChat Error]", err.message); reject(err); });
    req.write(bodyStr);
    req.end();
  });
}

function sanitize(text) { return text.slice(0, 1000); }

module.exports = { send, sendProductCards, sendQuickReplies, sendInvoice, addTag, getSubscriber };
