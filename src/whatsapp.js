// ── WhatsApp Cloud API Sender ──────────────────────────────────────────────────
// All functions accept optional phoneId + token to support multi-tenant routing.
// Falls back to env vars (single-tenant / dev mode) if not provided.
// ─────────────────────────────────────────────────────────────────────────────
const https = require("https");

const WA_TOKEN   = process.env.WHATSAPP_TOKEN    || "";
const PHONE_ID   = process.env.WHATSAPP_PHONE_ID || "";

// ── Send a text message ───────────────────────────────────────────────────────
async function send(to, text, phoneId = PHONE_ID, token = WA_TOKEN) {
  // Test mode — capture replies instead of actually sending
  if (module.exports._testMode && module.exports._testReplies) {
    module.exports._testReplies.push(text);
    return;
  }

  if (!token || !phoneId) {
    console.log(`[WhatsApp MOCK] → ${to}: ${text.slice(0, 80)}`);
    return;
  }

  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: sanitize(text) },
  });

  return apiPost(`/${phoneId}/messages`, body, token);
}

// ── Send product list as text ─────────────────────────────────────────────────
async function sendProductCards(to, products, phoneId = PHONE_ID, token = WA_TOKEN) {
  const text = products.slice(0, 10).map((p, i) => {
    const priceStr = p.price > 0 ? `₹${p.price}` : "Contact";
    const sizeStr  = p.sizes?.length ? `\n   Sizes: ${p.sizes.slice(0, 4).join(", ")}` : "";
    const colorStr = p.colors?.length ? `\n   Colors: ${p.colors.slice(0, 3).join(", ")}` : "";
    return `${i + 1}. *${p.name}* — ${priceStr}${sizeStr}${colorStr}`;
  }).join("\n\n");

  return send(to, `📦 *Our Products:*\n\n${text}\n\nReply with the number to order.`, phoneId, token);
}

// ── Send quick replies as numbered list ───────────────────────────────────────
async function sendQuickReplies(to, text, replies, phoneId = PHONE_ID, token = WA_TOKEN) {
  const replyText = `${text}\n\n${replies.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
  return send(to, replyText, phoneId, token);
}

// ── Send invoice notification ─────────────────────────────────────────────────
async function sendInvoice(to, pdfBuffer, filename, phoneId = PHONE_ID, token = WA_TOKEN) {
  return send(to, `🧾 *Invoice Generated*\nInvoice No: ${filename}\nThank you for your order!`, phoneId, token);
}

// ── Mark message as read + show typing indicator ──────────────────────────────
async function markReadAndType(to, messageId, phoneId = PHONE_ID, token = WA_TOKEN) {
  if (!token || !phoneId) return;

  // Mark as read (shows blue ticks)
  await apiPost(`/${phoneId}/messages`, JSON.stringify({
    messaging_product: "whatsapp",
    status           : "read",
    message_id       : messageId,
  }), token).catch(() => {});

  // Show typing dots
  await apiPost(`/${phoneId}/messages`, JSON.stringify({
    messaging_product: "whatsapp",
    recipient_type   : "individual",
    to,
    type             : "text",
    "typing"         : { status: "on" },
  }), token).catch(() => {});

  // Hold typing for 1.5 seconds
  await new Promise(r => setTimeout(r, 1500));
}

// ── Internal API call ─────────────────────────────────────────────────────────
function apiPost(path, bodyStr, token = WA_TOKEN) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "graph.facebook.com",
      path    : `/v21.0${path}`,
      method  : "POST",
      headers : {
        "Authorization" : `Bearer ${token}`,
        "Content-Type"  : "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) console.error("[WhatsApp API Error]", parsed.error.message);
          else console.log("[WhatsApp] Message sent ✓");
          resolve(parsed);
        } catch { resolve({}); }
      });
    });

    req.on("error", (err) => {
      console.error("[WhatsApp Request Error]", err.message);
      reject(err);
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── Send a video message ──────────────────────────────────────────────────────
async function sendVideo(to, videoUrl, caption = "", phoneId = PHONE_ID, token = WA_TOKEN) {
  if (!token || !phoneId) {
    console.log(`[WhatsApp MOCK] → ${to}: [VIDEO] ${videoUrl} — "${caption.slice(0, 60)}"`);
    return;
  }
  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to,
    type: "video",
    video: { link: videoUrl, caption: sanitize(caption) },
  });
  return apiPost(`/${phoneId}/messages`, body, token);
}

function sanitize(text) { return text.slice(0, 4096); }

module.exports = { send, sendProductCards, sendQuickReplies, sendInvoice, markReadAndType, sendVideo };
