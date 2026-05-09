// ── Selly WhatsApp Bot — Main Server ──────────────────────────────────────────
// WhatsApp Cloud API · Multi-language · Status Reply · COD+Razorpay
// Smart Bargaining · Festival Campaigns · Loyalty Points
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();

const express    = require("express");
const bodyParser = require("body-parser");
const path       = require("path");
const fs         = require("fs");

// ── DB setup ──────────────────────────────────────────────────────────────────
const { setup } = require("./setup");

// ── Core modules ───────────────────────────────────────────────────────────────
const session    = require("./session");
const wa         = require("./whatsapp");   // Primary sender — WhatsApp only
const catalog    = require("./catalog");
const shop       = require("./shop");       // Customer-facing catalog web page
const orders     = require("./orders");
const customers  = require("./customers");
const ai         = require("./ai");
const billing    = require("./billing");
const payment    = require("./payment");
const instafetch      = require("./instafetch");
const subscriptions   = require("./subscriptions");
const commissionEngine = require("./commission");

// ── New feature modules ────────────────────────────────────────────────────────
const language     = require("./language");
const loyalty      = require("./loyalty");
const festivals    = require("./festivals");
const bargain      = require("./bargain");
const status       = require("./status");
const wishlistMod  = require("./wishlist");
const otpMod       = require("./otp");
const photoInquiry = require("./photo_inquiry");
const trackingMod  = require("./tracking");
const waNumbers    = require("./wa_numbers");  // multi-tenant phone routing

// ── Unified send helper ───────────────────────────────────────────────────────
// Reads per-client phoneId + token from session (set during webhook routing).
// Falls back to env vars for dev/single-tenant mode.
const DEFAULT_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const DEFAULT_WA_TOKEN = process.env.WHATSAPP_TOKEN    || "";
function _waCtx(to) {
  const s = session.get(to);
  return {
    phoneId: s?.phoneId || DEFAULT_PHONE_ID,
    token  : s?.waToken || DEFAULT_WA_TOKEN,
  };
}
async function send(to, text)                 { const c = _waCtx(to); return wa.send(to, text, c.phoneId, c.token); }
async function sendCards(to, products)        { const c = _waCtx(to); return wa.sendProductCards(to, products, c.phoneId, c.token); }
async function sendReplies(to, text, replies) { const c = _waCtx(to); return wa.sendQuickReplies(to, text, replies, c.phoneId, c.token); }

const DEFAULT_BUSINESS_ID = process.env.BUSINESS_ID || "default";

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ───────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (!origin || origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1") ||
      origin.includes("railway.app") || origin.includes("vercel.app")) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Business-ID,x-admin-token");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(bodyParser.json({ limit: "20mb" }));     // increased for base64 media uploads
app.use(bodyParser.text({ type: "text/plain", limit: "20mb" }));

// ── Request logger — logs every incoming API call ─────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/webhook/")) {
    const bid = req.headers["x-business-id"] || req.query.bid || "-";
    console.log(`[REQ] ${req.method} ${req.path} bid=${bid} ip=${req.ip}`);
  }
  next();
});
app.use(express.static(path.join(__dirname, "../public")));

// ── Customer-facing shop page ─────────────────────────────────────────────────
// /shop/:businessId?q=jeans&max=800&min=200&color=blue
shop.register(app, catalog);

// ── Health check ───────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status  : "Selly WhatsApp Bot running",
  features: ["multi-language", "status-reply", "loyalty-points", "bargaining", "festival-campaigns", "COD+Razorpay"],
}));

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOKS
// ─────────────────────────────────────────────────────────────────────────────

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "selly123";

// ── WhatsApp Webhook Verification (GET) ───────────────────────────────────────
app.get("/webhook/whatsapp", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[WhatsApp Webhook] Verified ✓");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── WhatsApp Messages (POST) ───────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200); // always respond to Meta immediately

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value    = change.value;
        const messages = value?.messages || [];

        // ── Resolve which client (business) owns this phone number ────────
        const incomingPhoneId = value.metadata?.phone_number_id || "";
        let   routedBusinessId = DEFAULT_BUSINESS_ID;
        let   routedToken      = "";
        if (incomingPhoneId) {
          const numInfo = await waNumbers.getByPhoneNumberId(incomingPhoneId).catch(() => null);
          if (numInfo) {
            routedBusinessId = numInfo.business_id;
            routedToken      = numInfo.token || "";
            console.log(`[Routing] phone_number_id=${incomingPhoneId} → business=${routedBusinessId}`);
          }
        }

        for (const msg of messages) {
          const senderId = msg.from;
          if (!senderId) continue;

          const name       = value.contacts?.[0]?.profile?.name || "Customer";
          const first_name = name.split(" ")[0];
          const last_name  = name.split(" ").slice(1).join(" ");
          const msgType    = msg.type;

          // Load or create session (preserves language + loyalty across messages)
          let sess = session.get(senderId) || session.create(senderId, { name, first_name, last_name });

          // ── Stamp routing info onto session so send() uses the right number
          session.update(senderId, {
            businessId  : routedBusinessId,
            phoneId     : incomingPhoneId,
            waToken     : routedToken,
          });
          sess = session.get(senderId);

          // ── Typing indicator (mark read + show dots for 1.5s) ─────────────
          await wa.markReadAndType(senderId, msg.id, incomingPhoneId, routedToken);

          // ── Voice message → transcription ─────────────────────────────────
          if (msgType === "audio") {
            console.log(`[WhatsApp] Voice note from ${senderId}`);
            await send(senderId,
              "🎙️ Voice messages noted! For now please type your request.\n" +
              "(Voice ordering coming soon!)"
            );
            continue;
          }

          // ── Image message — photo search (products) or forward to teacher (education)
          if (msgType === "image") {
            const imageUrl = msg.image?.url || msg.image?.id || "";
            if (imageUrl) {
              const imgSettings = await getSettings(routedBusinessId);
              const imgIndustry = (imgSettings.industry || "").toLowerCase();
              if (imgIndustry.includes("education") || imgIndustry.includes("tourism")) {
                // Forward image query to business owner
                const imgLang = sess.lang || "english";
                const fwdMsg = {
                  hindi   : `📸 आपकी image हमारी team को forward कर दी गई है। जल्द ही reply मिलेगा! 😊`,
                  hinglish: `📸 Aapki image team ko forward ho gayi. Jald reply milega! 😊`,
                  english : `📸 Your image has been forwarded to our team. We'll get back to you shortly! 😊`,
                };
                await send(senderId, fwdMsg[imgLang] || fwdMsg.english);
                await notifyOwner(routedBusinessId, senderId, name, "[Image shared by student]", "query");
              } else {
                await handlePhotoSearch(senderId, sess, imageUrl, name);
              }
              continue;
            }
          }

          // ── Location sharing ──────────────────────────────────────────────
          if (msgType === "location") {
            const loc = msg.location;
            if (loc && sess.state === "collecting_address") {
              const locationStr = `📍 GPS: ${loc.latitude}, ${loc.longitude}` +
                (loc.address ? `\n${loc.address}` : "") +
                (loc.name    ? `\n${loc.name}`    : "");
              await handleAddressCollection(senderId, sess, locationStr);
              continue;
            }
          }

          // ── Text message ──────────────────────────────────────────────────
          const text = msg.text?.body || "";
          if (!text) continue;

          console.log(`[WhatsApp] Message from ${senderId} (${name}): ${text.slice(0, 80)}`);

          // ── Detect & persist customer language ────────────────────────────
          const requestedLang = language.getRequestedLanguage(text);
          if (requestedLang) {
            session.update(senderId, { lang: requestedLang });
            sess = session.get(senderId);
            await send(senderId,
              `✅ Language changed to ${language.LANGUAGES[requestedLang]?.name || requestedLang}! 🌐`
            );
          } else if (!sess.lang) {
            const detected = language.detectLanguage(text);
            session.update(senderId, { lang: detected });
            sess = session.get(senderId);
          }

          // ── Status reply detection ────────────────────────────────────────
          if (status.isStatusReply(msg)) {
            console.log(`[WhatsApp] Status reply from ${senderId}`);
            await handleStatusReply(senderId, sess, text);
            continue;
          }

          await routeMessage(senderId, sess, text, name);
        }
      }
    }
  } catch (err) {
    console.error("[WhatsApp Webhook Error]", err.message);
  }
});

// ── Instagram Webhook (kept for future use) ───────────────────────────────────
app.get("/webhook/instagram", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});
app.post("/webhook/instagram", (req, res) => res.sendStatus(200)); // no-op for now

// ── ManyChat webhook (legacy — no-op) ─────────────────────────────────────────
app.get("/webhook/manychat",  (req, res) => res.sendStatus(200));
app.post("/webhook/manychat", (req, res) => res.sendStatus(200));

// ── Razorpay payment callback ─────────────────────────────────────────────────
app.get("/webhook/payment", async (req, res) => {
  const { razorpay_payment_link_id, razorpay_payment_link_status } = req.query;
  if (razorpay_payment_link_status === "paid" && razorpay_payment_link_id) {
    await handlePaymentSuccess(razorpay_payment_link_id);
  }
  res.redirect(process.env.SUCCESS_URL || "/");
});

app.post("/webhook/payment", async (req, res) => {
  // Razorpay webhook (POST) for auto order confirmation
  res.sendStatus(200);
  const { payload } = req.body;
  if (payload?.payment_link?.entity?.status === "paid") {
    const linkId = payload.payment_link.entity.id;
    await handlePaymentSuccess(linkId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE ROUTER
// ─────────────────────────────────────────────────────────────────────────────

async function routeMessage(customerId, sess, message, name) {
  const state = sess.state;
  const lang  = sess.lang || "english";

  // ── Shop page cart: customer sent SELLY_CART: from the shop link ──────────
  if (message.includes("SELLY_CART:")) return handleSellyCart(customerId, sess, message, name);

  // ── Global commands (any state) ───────────────────────────────────────────
  if (isLoyaltyRequest(message))    return handleLoyaltyCheck(customerId, sess);
  if (isTrackingRequest(message))   return handleTracking(customerId, sess, message);
  if (isReturnRequest(message))     return handleReturn(customerId, sess, message);
  if (isOrderHistoryRequest(message)) return handleOrderHistory(customerId, sess);
  if (isReferralRequest(message))   return handleReferralCode(customerId);
  if (isWishlistRequest(message))   return handleWishlistCommand(customerId, sess, message);

  if (message.toLowerCase() === "cancel" || message.toLowerCase() === "start over" ||
      /^(रद्द|रद्द करो|cancel karo)$/i.test(message)) {
    session.reset(customerId);
    const msgs = {
      hindi   : "ठीक है, नए सिरे से शुरू करते हैं! 😊\nआप क्या ढूंढ रहे हैं?",
      hinglish: "Okay, fresh start! 😊\nKya dhundh rahe ho?",
      english : "Okay, starting fresh! 😊\nWhat are you looking for today?",
    };
    return send(customerId, msgs[lang] || msgs.english);
  }

  // ── COD confirmation ──────────────────────────────────────────────────────
  if (state === "choosing_payment") return handlePaymentChoice(customerId, sess, message);

  // ── State machine ─────────────────────────────────────────────────────────
  switch (state) {
    case "idle":
    case "searching":
      return handleSearch(customerId, sess, message, name);

    case "status_inquiry":
      return handleStatusProductResponse(customerId, sess, message);

    case "selecting":
      return handleProductSelection(customerId, sess, message);

    case "sizing":
      return handleSizeSelection(customerId, sess, message);

    case "collecting_address":
      return handleAddressCollection(customerId, sess, message);

    case "collecting_mobile":
      return handleMobileCollection(customerId, sess, message);

    case "verifying_mobile_otp":
      return handleMobileOtpVerification(customerId, sess, message);

    case "choosing_payment":
      return handlePaymentChoice(customerId, sess, message);

    case "awaiting_payment":
      return handlePaymentCheck(customerId, sess, message);

    default:
      session.reset(customerId);
      return handleSearch(customerId, sess, message, name);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE: WhatsApp Status Reply
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatusReply(customerId, sess, text) {
  const lang           = sess.lang || "english";
  const recentStatus   = await status.getMostRecentStatus();

  // If customer replies with a number, handle product selection
  if (sess.state === "status_inquiry") {
    return handleStatusProductResponse(customerId, sess, text);
  }

  session.update(customerId, { state: "status_inquiry", statusProduct: recentStatus });
  const reply = status.buildStatusReply(recentStatus, lang);
  await send(customerId, reply);
}

async function handleStatusProductResponse(customerId, sess, message) {
  const lang    = sess.lang || "english";
  const msg     = message.trim();
  const num     = parseInt(msg);
  const product = sess.statusProduct;

  if (num === 1 && product?.productId) {
    // Show product details
    const p = await catalog.get(product.productId);
    if (p) {
      session.update(customerId, { state: "selecting", searchResults: [p] });
      const priceStr = p.price > 0 ? `₹${p.price}` : "Contact for price";
      const sizeStr  = p.sizes?.length ? `\n📏 Sizes: ${p.sizes.join(", ")}` : "";
      const colorStr = p.colors?.length ? `\n🎨 Colors: ${p.colors.join(", ")}` : "";
      await send(customerId,
        `📦 *${p.name}*\n💰 ${priceStr}${sizeStr}${colorStr}\n\nReply *1* to order or *back* to browse more`
      );
      return;
    }
  }

  if (num === 2 || msg.toLowerCase().includes("more") || msg.toLowerCase().includes("catalog")) {
    session.update(customerId, { state: "idle" });
    const msgs = {
      hindi   : "ज़रूर! बताइए आप क्या ढूंढ रहे हैं? 😊",
      hinglish: "Sure! Batao kya dhundh rahe ho? 😊",
      english : "Sure! What are you looking for? 😊",
    };
    return send(customerId, msgs[lang] || msgs.english);
  }

  // Treat as a search
  session.update(customerId, { state: "idle" });
  return handleSearch(customerId, sess, message, sess.name);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Notify business owner when customer sends an unknown request
// type: "query" (general question) | "product_request" (not found in catalog)
// ─────────────────────────────────────────────────────────────────────────────
async function notifyOwner(bizId, customerId, customerName, message, type = "query") {
  try {
    const bizSettings = await getSettings(bizId);
    const rawNum      = (bizSettings.whatsapp_number || "").replace(/[^0-9]/g, "");
    if (!rawNum) return; // owner hasn't set their number — skip silently

    const custNum  = customerId.replace(/[^0-9]/g, "");
    const replyUrl = `https://wa.me/${custNum}`;

    const emoji = type === "product_request" ? "📦" : "💬";
    const label = type === "product_request" ? "Product Request (not in catalog)" : "Customer Query";

    const text =
      `🔔 *New ${label}*\n\n` +
      `👤 *Customer:* ${customerName}\n` +
      `${emoji} *Message:* ${message}\n\n` +
      `📱 Reply directly:\n${replyUrl}`;

    // Use the business's own WhatsApp credentials to send the notification
    const s       = session.get(customerId);
    const phoneId = s?.phoneId || DEFAULT_PHONE_ID;
    const token   = s?.waToken || DEFAULT_WA_TOKEN;

    await wa.send(rawNum, text, phoneId, token);
    console.log(`[OwnerNotify] Sent ${type} alert to ${rawNum} for biz=${bizId}`);
  } catch (e) {
    console.error("[OwnerNotify] Error:", e.message); // non-fatal
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE: Product Search (with Bargaining hook)
// ─────────────────────────────────────────────────────────────────────────────
const GREETINGS = /^(hi+|hello+|hey+|helo|namaste|namaskar|hii+|sup|yo|ola|hola|good\s*(morning|afternoon|evening|night)|start|menu|shop|catalog)$/i;

async function handleSearch(customerId, sess, message, name) {
  const lang = sess.lang || "english";

  // Bargain check in search state — skip for education/tourism (no bargaining on courses)
  if (bargain.isBargaining(message) && sess.cart?.length) {
    const bargainSettings = await getSettings(sess.businessId || DEFAULT_BUSINESS_ID);
    const bargainIndustry = (bargainSettings.industry || "").toLowerCase();
    if (!bargainIndustry.includes("education") && !bargainIndustry.includes("tourism")) {
      const item = sess.cart[sess.cart.length - 1];
      return handleBargain(customerId, sess, item, message);
    }
  }

  // Greeting → always show welcome, skip AI search
  if (GREETINGS.test(message.trim())) {
    const bizSettings = await getSettings(sess.businessId || DEFAULT_BUSINESS_ID);
    const bizName     = bizSettings.business_name || "our store";
    const industry    = (bizSettings.industry || "").toLowerCase();

    // Industry-aware greeting examples
    let exampleHindi    = `"नीली जींस ₹800 में" या "कुर्ती size M"`;
    let exampleHinglish = `"blue jeans under 800" ya "kurti size M"`;
    let exampleEnglish  = `"silk saree" or "floral kurti size M"`;

    if (industry.includes("education")) {
      exampleHindi    = `"Mathematics course" या "Standard 9th batch"`;
      exampleHinglish = `"science class" ya "10th standard batch"`;
      exampleEnglish  = `"Mathematics course" or "Standard 9th batch"`;
    } else if (industry.includes("tourism") || industry.includes("travel")) {
      exampleHindi    = `"Goa tour" या "Manali 3 nights package"`;
      exampleHinglish = `"Goa tour package" ya "Manali trip 3 nights"`;
      exampleEnglish  = `"Goa tour" or "Manali 3 nights package"`;
    } else if (industry.includes("food") || industry.includes("restaurant")) {
      exampleHindi    = `"paneer pizza" या "veg thali"`;
      exampleHinglish = `"paneer pizza" ya "veg thali"`;
      exampleEnglish  = `"paneer pizza" or "veg thali"`;
    }

    const greets = {
      hindi   : `नमस्ते ${name}! 👋\n\n*${bizName}* में आपका स्वागत है!\n\nआप क्या ढूंढ रहे हैं? बताइए!\nउदाहरण: ${exampleHindi}`,
      hinglish: `Hey ${name}! 👋 Welcome to *${bizName}*!\n\nKya dhundh rahe ho? Bolo!\nExample: ${exampleHinglish}`,
      english : `Hi ${name}! 👋 Welcome to *${bizName}*!\n\nWhat are you looking for today?\nExample: ${exampleEnglish}`,
    };
    return send(customerId, greets[lang] || greets.english);
  }

  const intent = await ai.extractSearchIntent(message);
  const bizId  = sess.businessId || DEFAULT_BUSINESS_ID;

  if (!intent.product) {
    // Not a product search — customer asked something else (delivery, timings, etc.)
    // Tell customer their query is forwarded, then notify the owner.
    const forwardMsg = {
      hindi   : `📝 आपका सवाल हमारी team को भेज दिया गया है!\n\n*"${message}"*\n\nवो जल्द ही आपसे contact करेंगे। 😊`,
      hinglish: `📝 Aapka query team ko forward ho gaya hai!\n\n*"${message}"*\n\nHum jald reply karenge. 😊`,
      english : `📝 Your query has been forwarded to our team!\n\n*"${message}"*\n\nWe'll get back to you shortly. 😊`,
    };
    await send(customerId, forwardMsg[lang] || forwardMsg.english);
    await notifyOwner(bizId, customerId, name, message, "query");
    return;
  }

  let searchResult = await catalog.search(intent, bizId);   // ← pass businessId
  let results      = searchResult.results || searchResult;

  // If no exact match — try showing all products for this business
  if (!results.length) {
    const all = await catalog.getAll(bizId);
    const allInStock = all.filter(p => p.inStock !== false);
    if (allInStock.length) {
      // Show all available products with a helpful message
      const bizSettings2  = await getSettings(bizId);
      const industry2     = (bizSettings2.industry || "").toLowerCase();
      const itemLabel     = industry2.includes("education") ? "courses" :
                            industry2.includes("tourism")   ? "packages" : "products";
      const browseMsg = {
        hindi   : `😕 *"${intent.rawQuery}"* नहीं मिला।\n\nयहाँ हमारे सभी available ${itemLabel} हैं:`,
        hinglish: `😕 *"${intent.rawQuery}"* nahi mila.\n\nYe hain hamare saare available ${itemLabel}:`,
        english : `😕 Couldn't find *"${intent.rawQuery}"* exactly.\n\nHere are all our available ${itemLabel}:`,
      };
      await send(customerId, browseMsg[lang] || browseMsg.english);
      results = allInStock;
    } else {
      const noResult = {
        hindi   : `😕 *"${intent.rawQuery}"* अभी available नहीं है।\n\nआपका request हमारी team को भेज दिया गया है — जल्द ही update मिलेगी! 🔔`,
        hinglish: `😕 *"${intent.rawQuery}"* abhi available nahi hai.\n\nRequest team ko forward ho gayi — jaldi update milega! 🔔`,
        english : `😕 *"${intent.rawQuery}"* isn't available right now.\n\nYour request has been forwarded to our team — we'll update you soon! 🔔`,
      };
      await send(customerId, noResult[lang] || noResult.english);
      await notifyOwner(bizId, customerId, name, intent.rawQuery || message, "product_request");
      return;
    }
  }

  session.update(customerId, { state: "selecting", lastSearch: intent, searchResults: results });

  const priceLabel = intent.maxPrice ? ` under ₹${intent.maxPrice}` : "";
  const header     = {
    hindi   : `🔍 *${results.length} प्रोडक्ट मिले "${intent.rawQuery}"${priceLabel} के लिए*\n\n`,
    hinglish: `🔍 *${results.length} results "${intent.rawQuery}"${priceLabel}*\n\n`,
    english : `🔍 *${results.length} result${results.length > 1 ? "s" : ""} for "${intent.rawQuery}"${priceLabel}*\n\n`,
  };

  const displayItems = results.slice(0, 5);
  const productList  = displayItems.map((p, i) => {
    const priceStr = p.price > 0 ? `₹${p.price}` : "📩 Contact";
    return `${i + 1}️⃣ *${p.name}* — ${priceStr}\n` +
           (p.colors?.length ? `   🎨 ${p.colors.slice(0, 3).join(", ")}` : "");
  }).join("\n\n");

  const footer = {
    hindi   : `\n\nनंबर reply करें select करने के लिए • "done" checkout के लिए 🛒`,
    hinglish: `\n\nNumber reply karo select karne ke liye • "done" for checkout 🛒`,
    english : `\n\nReply number to select • "done" to checkout 🛒`,
  };

  await send(customerId, (header[lang] || header.english) + productList + (footer[lang] || footer.english));

  // ── Shop link — send for product/tourism/food industries only ───────────────
  // Skip for education (course list needs no photo gallery) and kirana (quick orders)
  try {
    const bizSettings = await getSettings(bizId);
    const industry    = bizSettings.industry || "product";

    if (industry !== "kirana" && !industry.includes("education")) {
      const BASE_URL = (process.env.BASE_URL || "https://instagram-bot-production-ef01.up.railway.app").replace(/\/$/, "");
      const shopUrl  = shop.buildShopUrl(BASE_URL, bizId, intent);

      const linkMsg = {
        hindi   : `🖼️ *Photos के साथ देखें:*\n${shopUrl}`,
        hinglish: `🖼️ *Photos ke saath dekho:*\n${shopUrl}`,
        english : `🖼️ *View with photos:*\n${shopUrl}`,
      };
      await send(customerId, linkMsg[lang] || linkMsg.english);
    }
  } catch (e) {
    console.error("[Shop link] Error:", e.message); // non-fatal
  }

  if (sess.cart?.length) {
    const cartBizSettings = await getSettings(bizId);
    const cartBizInd      = (cartBizSettings.industry || "").toLowerCase();
    const cartItemWord    = cartBizInd.includes("education") ? "course" : cartBizInd.includes("tourism") ? "package" : "item";
    const cartMsg = {
      hindi   : `🛒 *Cart (${sess.cart.length} ${cartItemWord}):* ${sess.cart.map(i => i.name).join(", ")}`,
      hinglish: `🛒 *Cart (${sess.cart.length} ${cartItemWord}):* ${sess.cart.map(i => i.name).join(", ")}`,
      english : `🛒 *Selected (${sess.cart.length} ${cartItemWord}${sess.cart.length > 1 ? "s" : ""}):* ${sess.cart.map(i => i.name).join(", ")}`,
    };
    await send(customerId, cartMsg[lang] || cartMsg.english);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE: Shop-Page Cart (SELLY_CART: protocol)
// Customer tapped "Order X items" on the shop page → WhatsApp carries
// "Hi! I want:\n1. Blue Jeans (₹699)\n\nSELLY_CART:Blue Jeans|White Tee"
// ─────────────────────────────────────────────────────────────────────────────
async function handleSellyCart(customerId, sess, message, name) {
  const lang  = sess.lang || "english";
  const bizId = sess.businessId || DEFAULT_BUSINESS_ID;

  // Extract the pipe-separated item names after SELLY_CART:
  const cartMatch = message.match(/SELLY_CART:(.+)/);
  if (!cartMatch) return handleSearch(customerId, sess, message, name);

  const rawNames = cartMatch[1].split("|").map(n => n.trim()).filter(Boolean);
  if (!rawNames.length) return handleSearch(customerId, sess, message, name);

  const found    = [];
  const notFound = [];

  for (const itemName of rawNames) {
    try {
      const result = await catalog.search({ product: itemName, rawQuery: itemName }, bizId);
      const items  = result.results || result;
      if (items.length) {
        const best = items[0];
        if (!found.find(f => f.id === best.id)) {
          found.push({ ...best, selectedSize: null });
        }
      } else {
        notFound.push(itemName);
      }
    } catch (e) {
      console.error(`[SellyCart] Lookup error for "${itemName}":`, e.message);
      notFound.push(itemName);
    }
  }

  if (!found.length) {
    const nf = {
      hindi   : `😕 Select किए हुए items नहीं मिले। कृपया दोबारा search करें।`,
      hinglish: `😕 Selected items nahi mile. Dobara search karo.`,
      english : `😕 Couldn't find what you selected. Please try searching again.`,
    };
    return send(customerId, nf[lang] || nf.english);
  }

  // Merge with existing cart (avoid duplicates)
  const existing = sess.cart || [];
  const merged   = [...existing];
  for (const p of found) {
    if (!merged.find(i => i.id === p.id)) merged.push(p);
  }

  session.update(customerId, { cart: merged, state: "selecting" });

  const itemList = found.map((p, i) => {
    const priceStr = p.price > 0 ? `₹${p.price}` : "📩 Contact";
    return `${i + 1}. *${p.name}* — ${priceStr}`;
  }).join("\n");

  const total    = merged.reduce((s, p) => s + (p.price || 0), 0);
  const totalStr = total > 0 ? `\n\n💰 *Total: ₹${total.toLocaleString("en-IN")}*` : "";

  const notFoundStr = notFound.length
    ? `\n⚠️ Not found: ${notFound.map(n => `_${n}_`).join(", ")}`
    : "";

  const cartCountStr = merged.length > found.length
    ? ` (${merged.length} total selected)`
    : "";

  const cartSettings = await getSettings(bizId);
  const cartInd      = (cartSettings.industry || "").toLowerCase();
  const itemWord     = cartInd.includes("education") ? "course" : cartInd.includes("tourism") ? "package" : "item";
  const itemWords    = cartInd.includes("education") ? "courses" : cartInd.includes("tourism") ? "packages" : "items";
  const checkoutWord = cartInd.includes("education") ? "enroll" : "checkout";

  const confirmMsg = {
    hindi   : `🛒 *${found.length} ${itemWord} cart में add हुए!*${cartCountStr}\n\n${itemList}${notFoundStr}${totalStr}\n\n"done" reply करें ${checkoutWord} के लिए ✅\nया और ${itemWords} search करें 🔍`,
    hinglish: `🛒 *${found.length} ${itemWord} cart mein add ho gaye!*${cartCountStr}\n\n${itemList}${notFoundStr}${totalStr}\n\n"done" reply karo ${checkoutWord} ke liye ✅\nYa aur ${itemWords} search karo 🔍`,
    english : `🛒 *${found.length} ${itemWord}${found.length > 1 ? "s" : ""} added!*${cartCountStr}\n\n${itemList}${notFoundStr}${totalStr}\n\nReply *"done"* to ${checkoutWord} ✅\nOr search for more ${itemWords} 🔍`,
  };
  return send(customerId, confirmMsg[lang] || confirmMsg.english);
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE: Smart Bargaining
// ─────────────────────────────────────────────────────────────────────────────
async function handleBargain(customerId, sess, item, message) {
  const lang        = sess.lang || "english";
  const offeredPrice = bargain.extractOfferedPrice(message);
  const round        = sess.bargainRound || 1;
  const result       = bargain.getBargainReply(item, offeredPrice, round, lang);

  if (!result.handled) {
    // Not a bargain — continue to normal search
    return handleSearch(customerId, sess, message, sess.name);
  }

  if (result.accepted) {
    // Update cart item with bargained price
    const cart = (sess.cart || []).map(i =>
      i.id === item.id ? { ...i, price: result.finalPrice, originalPrice: i.price, bargained: true } : i
    );
    session.update(customerId, { cart, state: "selecting", bargainRound: 0 });
    await send(customerId, result.message);
    return;
  }

  // Counter offer
  const newRound = round + 1;
  if (newRound > bargain.MAX_ROUNDS) {
    // Exhausted — send final floor price
    const floorReply = bargain.getTooLowReply(item, lang);
    session.update(customerId, { bargainRound: 0 });
    return send(customerId, floorReply);
  }

  session.update(customerId, { bargainRound: newRound });
  await send(customerId, result.message);
}

// ── Product Selection (bargaining hook inside) ─────────────────────────────────
async function handleProductSelection(customerId, sess, message) {
  const msg  = message.toLowerCase().trim();
  const lang = sess.lang || "english";

  if (msg === "done" || msg === "checkout" || msg === "buy" || msg === "enroll") {
    if (!sess.cart?.length) {
      const doneSettings = await getSettings(sess.businessId || DEFAULT_BUSINESS_ID);
      const doneInd      = (doneSettings.industry || "").toLowerCase();
      const searchWord   = doneInd.includes("education") ? "courses" : doneInd.includes("tourism") ? "packages" : "products";
      const empty = {
        hindi   : `Cart खाली है! पहले ${searchWord} search करें 😊`,
        hinglish: `Cart empty hai! Pehle ${searchWord} search karo 😊`,
        english : `Nothing selected yet! Search for ${searchWord} first 😊`,
      };
      return send(customerId, empty[lang] || empty.english);
    }
    return startSizing(customerId, sess);
  }

  if (msg === "more") {
    const next = (sess.searchResults || []).slice(5, 10);
    if (!next.length) {
      const noMore = { hindi: "और results नहीं हैं।", hinglish: "Aur results nahi hain.", english: "No more results. Try a different search!" };
      return send(customerId, noMore[lang] || noMore.english);
    }
    session.update(customerId, { searchResults: sess.searchResults.slice(5) });
    return handleSearch(customerId, sess, sess.lastSearch?.rawQuery || "", sess.name);
  }

  const num = parseInt(msg);
  if (!isNaN(num) && num >= 1 && num <= 5) {
    const product = (sess.searchResults || [])[num - 1];
    if (!product) {
      const invalid = { hindi: "गलत selection। List से number reply करें।", hinglish: "Invalid selection. List se number reply karo.", english: "Invalid selection. Reply a number from the list." };
      return send(customerId, invalid[lang] || invalid.english);
    }

    // ── Out-of-stock → offer wishlist ──────────────────────────────────────
    if (product.inStock === false) {
      const oos = {
        hindi   : `😕 *${product.name}* abhi out of stock hai.\n\n1️⃣ Wishlist mein add karo (restock hone par notify karein)\n2️⃣ Kuch aur dhundo`,
        hinglish: `😕 *${product.name}* is currently out of stock.\n\n1️⃣ Add to wishlist — notify me when it's back\n2️⃣ Search something else`,
        english : `😕 *${product.name}* is currently out of stock.\n\n1️⃣ Add to wishlist (notify me when restocked)\n2️⃣ Search for something else`,
      };
      session.update(customerId, { state: "selecting", wishlistPending: product });
      return send(customerId, oos[lang] || oos.english);
    }

    // ── Wishlist pending pick ──────────────────────────────────────────────
    if (sess.wishlistPending) {
      if (num === 1) {
        await wishlistMod.add(customerId, sess.wishlistPending.id, sess.wishlistPending.name);
        const name_ = sess.wishlistPending.name;
        session.update(customerId, { wishlistPending: null });
        const added = {
          hindi   : `❤️ *${name_}* wishlist mein add ho gaya! Restock hone par notify karenge. 🔔`,
          hinglish: `❤️ *${name_}* added to your wishlist! We'll notify you when it's back. 🔔`,
          english : `❤️ *${name_}* added to your wishlist! We'll notify you when it's restocked. 🔔`,
        };
        return send(customerId, added[lang] || added.english);
      }
      session.update(customerId, { wishlistPending: null });
      return handleSearch(customerId, sess, message, sess.name);
    }

    // ── Bargaining check: if customer said "1 for 300" ─────────────────────
    if (bargain.isBargaining(message)) {
      const cart = [...(sess.cart || []), { ...product, selectedSize: null }];
      session.update(customerId, { cart, state: "selecting" });
      return handleBargain(customerId, sess, product, message);
    }

    const cart      = [...(sess.cart || [])];
    const alreadyIn = cart.find(i => i.id === product.id);

    // Get industry for item word
    const addSettings  = await getSettings(sess.businessId || DEFAULT_BUSINESS_ID);
    const addInd       = (addSettings.industry || "").toLowerCase();
    const addItemWord  = addInd.includes("education") ? "course" : addInd.includes("tourism") ? "package" : "item";
    const addCheckout  = addInd.includes("education") ? "enroll" : "checkout";

    if (alreadyIn) {
      const dup = {
        hindi   : `"${product.name}" already selected है! "done" reply करें ${addCheckout} के लिए।`,
        hinglish: `"${product.name}" already selected hai! "done" reply karo ${addCheckout} ke liye.`,
        english : `"${product.name}" is already selected! Reply "done" to ${addCheckout}.`,
      };
      return send(customerId, dup[lang] || dup.english);
    }

    cart.push({ ...product, selectedSize: null });
    session.update(customerId, { cart, state: "selecting", bargainRound: 0 });

    const added = {
      hindi   : `✅ *${product.name}* add हुआ!\n\n🛒 ${cart.length} ${addItemWord} selected\n\nAur search करें या "done" reply करें ${addCheckout} के लिए 👇`,
      hinglish: `✅ *${product.name}* add ho gaya!\n\n🛒 ${cart.length} ${addItemWord} selected\n\nAur search karo ya "done" reply karo ${addCheckout} ke liye 👇`,
      english : `✅ *${product.name}* added!\n\n🛒 ${cart.length} ${addItemWord}${cart.length > 1 ? "s" : ""} selected\n\nSearch more or reply "done" to ${addCheckout} 👇`,
    };
    return send(customerId, added[lang] || added.english);
  }

  // Treat as new search
  return handleSearch(customerId, sess, message, sess.name);
}

// ── Size Selection ─────────────────────────────────────────────────────────────
async function startSizing(customerId, sess) {
  const lang         = sess.lang || "english";

  // Education/tourism products don't have sizes — skip sizing entirely
  const sizeSettings = await getSettings(sess.businessId || DEFAULT_BUSINESS_ID);
  const sizeIndustry = (sizeSettings.industry || "").toLowerCase();
  if (sizeIndustry.includes("education") || sizeIndustry.includes("tourism")) {
    return startAddressCollection(customerId, sess);
  }

  const itemsNoSize  = (sess.cart || []).filter(i => i.hasSizes && !i.selectedSize);

  if (!itemsNoSize.length) return startAddressCollection(customerId, sess);

  const item   = itemsNoSize[0];
  const sizes  = item.sizes || ["XS","S","M","L","XL","XXL"];
  const avail  = sizes.map(s => `[ ${s} ]`).join("  ");

  session.update(customerId, { state: "sizing", sizingItem: item.id });

  const msgs = {
    hindi   : `📏 *${item.name}* के लिए size चुनें:\n\n${avail}\n\nSize reply करें (e.g. "M")`,
    hinglish: `📏 *${item.name}* ke liye size choose karo:\n\n${avail}\n\nSize reply karo (e.g. "M")`,
    english : `📏 *Select size for ${item.name}:*\n\n${avail}\n\nReply the size (e.g. "M")`,
  };
  await send(customerId, msgs[lang] || msgs.english);
}

async function handleSizeSelection(customerId, sess, message) {
  const lang    = sess.lang || "english";
  const size    = message.toUpperCase().trim();
  const validSz = ["XS","S","M","L","XL","XXL","FREESIZE","FREE SIZE","28","30","32","34","36","38","40","42"];

  if (!validSz.includes(size)) {
    const invalid = {
      hindi   : `"${message}" valid size नहीं है। S, M, L, XL जैसा reply करें।`,
      hinglish: `"${message}" valid size nahi hai. S, M, L, XL jaisa reply karo.`,
      english : `"${message}" is not a valid size. Reply S, M, L, XL etc.`,
    };
    return send(customerId, invalid[lang] || invalid.english);
  }

  const cart = (sess.cart || []).map(i =>
    i.id === sess.sizingItem ? { ...i, selectedSize: size } : i
  );
  session.update(customerId, { cart });

  const remaining = cart.filter(i => i.hasSizes && !i.selectedSize);
  if (remaining.length) return startSizing(customerId, { ...sess, cart });

  const done = { hindi: "✅ सभी sizes select हो गए!\n", hinglish: "✅ Sab sizes select ho gaye!\n", english: "✅ All sizes selected!\n" };
  await send(customerId, done[lang] || done.english);
  return startAddressCollection(customerId, { ...sess, cart });
}

// ── Address Collection ─────────────────────────────────────────────────────────
async function startAddressCollection(customerId, sess) {
  const lang     = sess.lang || "english";
  const bizId    = sess.businessId || DEFAULT_BUSINESS_ID;
  const settings = await getSettings(bizId);
  const industry = (settings.industry || "").toLowerCase();

  // Education & tourism don't need delivery address — skip to mobile collection
  if (industry.includes("education") || industry.includes("tourism") || industry.includes("travel")) {
    session.update(customerId, { address: "", state: "collecting_mobile" });
    const msgs = {
      hindi   : `📱 Enrollment confirmation ke liye aapka mobile number? (10 digit)`,
      hinglish: `📱 Enrollment ke liye mobile number? (10 digit)`,
      english : `📱 Your mobile number for enrollment confirmation? (10 digits)`,
    };
    return send(customerId, msgs[lang] || msgs.english);
  }

  session.update(customerId, { state: "collecting_address" });
  const msgs = {
    hindi:
      `📦 *लगभग हो गया!*\n\n` +
      `अपना delivery address भेजें:\n` +
      `_(घर नंबर, गली, शहर, राज्य, पिन कोड)_\n\n` +
      `📍 या WhatsApp Location share करें automatic fill के लिए`,
    hinglish:
      `📦 *Almost done!*\n\n` +
      `Apna delivery address bhejo:\n` +
      `_(House no, Street, City, State, Pincode)_\n\n` +
      `📍 Ya WhatsApp Location share karo auto-fill ke liye`,
    english:
      `📦 *Almost done!*\n\n` +
      `Please send your delivery address:\n` +
      `_(House/Flat no, Street, City, State, Pincode)_\n\n` +
      `📍 Or share your WhatsApp Location for auto-fill`,
  };
  await send(customerId, msgs[lang] || msgs.english);
}

async function handleAddressCollection(customerId, sess, message) {
  const lang = sess.lang || "english";
  session.update(customerId, { address: message, state: "collecting_mobile" });

  const bizId2    = sess.businessId || DEFAULT_BUSINESS_ID;
  const settings2 = await getSettings(bizId2);
  const industry2 = (settings2.industry || "").toLowerCase();
  const isEdu     = industry2.includes("education");

  const msgs = {
    hindi   : isEdu ? `📱 Course updates ke liye aapka mobile number? (10 digit)` : `📱 Delivery updates ke liye aapka mobile number? (10 digit)`,
    hinglish: isEdu ? `📱 Course updates ke liye mobile number? (10 digit)` : `📱 Delivery updates ke liye mobile number? (10 digit)`,
    english : isEdu ? `📱 Your mobile number for course updates? (10 digits)` : `📱 Your mobile number for delivery updates? (10 digits)`,
  };
  await send(customerId, msgs[lang] || msgs.english);
}

async function handleMobileCollection(customerId, sess, message) {
  const lang   = sess.lang || "english";
  const mobile = message.replace(/\D/g, "");

  if (mobile.length < 10) {
    const err = { hindi: "10 digit valid mobile number enter करें।", hinglish: "10 digit valid number enter karo.", english: "Please enter a valid 10-digit mobile number." };
    return send(customerId, err[lang] || err.english);
  }

  // ── OTP verification — send OTP to the provided mobile number ────────────────
  // Generates a 6-digit OTP and sends it to the number via WhatsApp so the
  // customer proves they own it. Works for all industries.
  const mobileOtp         = Math.floor(100000 + Math.random() * 900000).toString();
  const mobileNormalized  = mobile.slice(-10);                  // last 10 digits
  const mobileWithCountry = "91" + mobileNormalized;           // India prefix

  session.update(customerId, { mobile: mobileNormalized, state: "verifying_mobile_otp", pendingMobileOtp: mobileOtp });

  // Send OTP to the provided number on WhatsApp (best-effort — log errors but don't block)
  try {
    const ctx = _waCtx(customerId);
    await wa.send(
      mobileWithCountry,
      `🔐 *Your Selly OTP: ${mobileOtp}*\n_(Valid for 10 minutes — do not share with anyone)_`,
      ctx.phoneId, ctx.token
    );
  } catch (e) {
    console.error("[OTP] Failed to send to mobile:", mobileWithCountry, e.message);
  }

  const otpSent = {
    hindi   : `📱 *${mobileNormalized}* number pe OTP bheja gaya hai.\n\nWo OTP yahan enter karein:`,
    hinglish: `📱 OTP sent to *${mobileNormalized}*.\n\nWo OTP yahan enter karo:`,
    english : `📱 An OTP has been sent to *${mobileNormalized}*.\n\nPlease enter the OTP here to verify:`,
  };
  return send(customerId, otpSent[lang] || otpSent.english);
}

// ── Mobile OTP Verification ────────────────────────────────────────────────────
async function handleMobileOtpVerification(customerId, sess, message) {
  const lang  = sess.lang || "english";
  const input = message.trim().replace(/\D/g, "");

  if (input !== String(sess.pendingMobileOtp)) {
    const err = {
      hindi   : `❌ OTP गलत है। फिर से try करें।\n_(Type "cancel" to start over)_`,
      hinglish: `❌ OTP galat hai. Dobara try karo.\n_(Type "cancel" to start over)_`,
      english : `❌ Incorrect OTP. Please try again.\n_(Type "cancel" to start over)_`,
    };
    return send(customerId, err[lang] || err.english);
  }

  // OTP matched — proceed to payment selection
  session.update(customerId, { state: "choosing_payment", pendingMobileOtp: null });

  const ok = {
    hindi   : `✅ *Mobile number verify हो गया!*`,
    hinglish: `✅ *Mobile number verified!*`,
    english : `✅ *Mobile number verified!*`,
  };
  await send(customerId, ok[lang] || ok.english);

  // Show payment options (mirrors handleMobileCollection flow)
  const redeemInfo = await loyalty.getRedeemInfo(customerId);
  let loyaltyLine  = "";
  if (redeemInfo.canRedeem) {
    loyaltyLine = {
      hindi   : `\n⭐ *Loyalty Points:* ${redeemInfo.points} pts → ₹${redeemInfo.maxDiscount} off available!\nReply *USE POINTS* to redeem before payment.`,
      hinglish: `\n⭐ *Loyalty Points:* ${redeemInfo.points} pts → ₹${redeemInfo.maxDiscount} off available!\n*USE POINTS* reply karo redeem karne ke liye.`,
      english : `\n⭐ *Loyalty Points:* ${redeemInfo.points} pts → ₹${redeemInfo.maxDiscount} off available!\nReply *USE POINTS* to redeem before paying.`,
    }[lang] || "";
  }

  const paySettings = await getSettings(sess.businessId || DEFAULT_BUSINESS_ID);
  const payIndustry = (paySettings.industry || "").toLowerCase();
  const isEduPay    = payIndustry.includes("education") || payIndustry.includes("tourism");
  const cod2Label   = isEduPay ? "Pay at Venue / First Class" : "Cash on Delivery (COD) — ₹30 extra charge";

  const msgs = {
    hindi:
      `💳 *Payment method choose करें:*\n\n` +
      `1️⃣ Online (UPI / Card / Net Banking) — Razorpay\n` +
      `2️⃣ 💵 ${cod2Label}${loyaltyLine}`,
    hinglish:
      `💳 *Payment method choose karo:*\n\n` +
      `1️⃣ Online (UPI / Card / Net Banking) — Razorpay\n` +
      `2️⃣ 💵 ${cod2Label}${loyaltyLine}`,
    english:
      `💳 *Choose payment method:*\n\n` +
      `1️⃣ Online (UPI / Card / Net Banking) — Razorpay\n` +
      `2️⃣ 💵 ${cod2Label}${loyaltyLine}`,
  };
  return send(customerId, msgs[lang] || msgs.english);
}


async function handlePaymentChoice(customerId, sess, message) {
  const lang = sess.lang || "english";
  const msg  = message.trim().toLowerCase();

  // Loyalty points redemption
  if (msg.includes("use points") || msg === "redeem") {
    const redeemInfo = await loyalty.getRedeemInfo(customerId);
    if (!redeemInfo.canRedeem) {
      const nopts = { hindi: "Enough points नहीं हैं अभी।", hinglish: "Abhi enough points nahi hain.", english: "You don't have enough points to redeem yet." };
      return send(customerId, nopts[lang] || nopts.english);
    }
    const result = await loyalty.redeemPoints(customerId, redeemInfo.maxSets);
    session.update(customerId, { loyaltyDiscount: result.discountAmount });
    const redeemed = {
      hindi   : `✅ ${result.pointsUsed} points redeem हुए — ₹${result.discountAmount} discount!\n\nAbhi payment method choose करें:\n1️⃣ Online\n2️⃣ COD`,
      hinglish: `✅ ${result.pointsUsed} points redeem ho gaye — ₹${result.discountAmount} discount!\n\nAb payment method:\n1️⃣ Online\n2️⃣ COD`,
      english : `✅ ${result.pointsUsed} points redeemed — ₹${result.discountAmount} off!\n\nNow choose payment:\n1️⃣ Online\n2️⃣ COD`,
    };
    return send(customerId, redeemed[lang] || redeemed.english);
  }

  const isOnline = msg === "1" || msg.includes("online") || msg.includes("upi") || msg.includes("card") || msg.includes("razorpay");
  const isCOD    = msg === "2" || msg.includes("cod") || msg.includes("cash");

  if (!isOnline && !isCOD) {
    const choose = { hindi: "1 (Online) या 2 (COD) reply करें।", hinglish: "1 (Online) ya 2 (COD) reply karo.", english: "Please reply 1 for Online or 2 for COD." };
    return send(customerId, choose[lang] || choose.english);
  }

  await placeOrder(customerId, sess, isOnline ? "online" : "cod");
}

// ─────────────────────────────────────────────────────────────────────────────
// Order Creation + Billing
// ─────────────────────────────────────────────────────────────────────────────
async function placeOrder(customerId, sess, paymentMode) {
  const lang  = sess.lang || "english";
  const bizId = sess.businessId || DEFAULT_BUSINESS_ID;

  const bizSettings = await getSettings(bizId);
  const bill = billing.generate({
    cart            : sess.cart,
    address         : sess.address,
    mobile          : sess.mobile,
    name            : sess.name,
    businessName    : bizSettings.business_name,
    businessGST     : bizSettings.business_gst_no,
    businessAddress : bizSettings.business_address,
    extra           : paymentMode === "cod" ? (bizSettings.cod_fee ?? 30) : 0,
    settings        : bizSettings,
  });

  // Apply loyalty discount if any
  if (sess.loyaltyDiscount) {
    bill.loyaltyDiscount = sess.loyaltyDiscount;
    bill.total           = Math.max(0, bill.total - sess.loyaltyDiscount);
  }

  const promoSource = (() => {
    if (!sess.promoSource) return null;
    const age = Date.now() - (sess.promoSentAt || 0);
    return age > 24 * 60 * 60 * 1000 ? null : sess.promoSource;
  })();

  const commResult  = commissionEngine.calculate(sess.cart, promoSource);

  const order = await orders.create({
    customerId,
    name       : sess.name,
    cart       : sess.cart,
    address    : sess.address,
    mobile     : sess.mobile,
    bill,
    paymentMode,
    status     : paymentMode === "cod" ? "confirmed" : "pending_payment",
    promoSource,
    commission : commResult.commissionAmount || 0,
  }, bizId);

  if (commResult.eligible) {
    await commissionEngine.record(bizId, order.id, sess.cart, promoSource);
  }
  session.update(customerId, { promoSource: null, promoSentAt: null, loyaltyDiscount: 0 });
  await customers.touch(customerId, { name: sess.name, mobile: sess.mobile }, bizId);
  await customers.recordOrder(customerId, order, bizId);
  session.update(customerId, { currentOrderId: order.id });

  // ── Build order summary ────────────────────────────────────────────────────
  const itemLines = bill.items.map(i =>
    `${i.name}${i.size ? ` (${i.size})` : ""}`.padEnd(25) + `₹${i.price}` +
    (i.bargained ? " ✂️" : "")
  ).join("\n");

  const industry     = (bizSettings.industry || "").toLowerCase();
  const isEduOrder   = industry.includes("education") || industry.includes("tourism");
  const discountLine = sess.loyaltyDiscount ? `Loyalty Discount    -₹${sess.loyaltyDiscount}\n` : "";
  const codLine      = paymentMode === "cod" && !isEduOrder ? `COD Charge          ₹30\n` : "";
  const deliveryLine = bill.delivery > 0 ? `Delivery        ₹${bill.delivery}\n` : "";
  const addressLine  = sess.address ? `📍 ${sess.address}\n` : "";
  const footerLine   = isEduOrder
    ? `✅ Enrollment confirmed — we'll be in touch!\n`
    : `🚚 Delivery in 3-5 days\n`;

  const summaryTitle = isEduOrder ? `🎓 *ENROLLMENT SUMMARY*` : `🧾 *ORDER SUMMARY*`;

  const summary =
    `════════════════════════\n` +
    `${summaryTitle}\n` +
    `════════════════════════\n` +
    `${itemLines}\n` +
    `────────────────────────\n` +
    `Subtotal        ₹${bill.subtotal}\n` +
    `${deliveryLine}` +
    `GST (${bill.gstRate}%)      ₹${bill.gst}\n` +
    `${codLine}${discountLine}` +
    `────────────────────────\n` +
    `*TOTAL          ₹${bill.total}*\n` +
    `════════════════════════\n` +
    `${addressLine}` +
    `${footerLine}` +
    `════════════════════════`;

  await send(customerId, summary);

  if (paymentMode === "online") {
    // ── Online payment ─────────────────────────────────────────────────────
    const payLink = await payment.createLink({
      amount      : bill.total,
      customerName: sess.name,
      mobile      : sess.mobile,
      description : `Order: ${bill.items.map(i => i.name).join(", ")}`,
    });

    await orders.updatePayLink(order.id, payLink);
    session.update(customerId, { state: "awaiting_payment", payLink });

    const payMsg = {
      hindi   : `\n💳 *Online payment करें:*\n${payLink.url}\n_(Link 30 मिनट में expire होगा)_\n\nPayment के बाद "paid" reply करें।`,
      hinglish: `\n💳 *Online payment karo:*\n${payLink.url}\n_(Link 30 min mein expire hoga)_\n\nPayment ke baad "paid" reply karo.`,
      english : `\n💳 *Pay now:*\n${payLink.url}\n_(Link expires in 30 minutes)_\n\nReply "paid" once done.`,
    };
    await send(customerId, payMsg[lang] || payMsg.english);

  } else {
    // ── COD confirmed ──────────────────────────────────────────────────────
    await confirmOrder(customerId, order, false);
  }
}

// ── Confirm order + loyalty points + invoice ───────────────────────────────────
async function confirmOrder(customerId, order, isOnline = true) {
  const lang = session.get(customerId)?.lang || "english";

  await orders.updateStatus(order.id, "confirmed");

  // ── COD/Venue OTP — generate and send to customer ────────────────────────
  const confirmSettings = await getSettings(order.businessId || DEFAULT_BUSINESS_ID);
  const confirmIndustry = (confirmSettings.industry || "").toLowerCase();
  const isEduConfirm    = confirmIndustry.includes("education") || confirmIndustry.includes("tourism");

  let codOtpLine = { hindi: "", hinglish: "", english: "" };
  if (order.paymentMode === "cod") {
    const otp = await otpMod.createCodOTP(order.id);
    if (isEduConfirm) {
      codOtpLine = {
        hindi   : `\n🔐 *Enrollment OTP: ${otp}*\n_(Pehli class mein yeh OTP batana hai)_`,
        hinglish: `\n🔐 *Enrollment OTP: ${otp}*\n_(Share this OTP at your first class)_`,
        english : `\n🔐 *Enrollment OTP: ${otp}*\n_(Share this OTP at your first class)_`,
      };
    } else {
      codOtpLine = {
        hindi   : `\n🔐 *Delivery OTP: ${otp}*\n_(Delivery ke time yeh OTP delivery boy ko batana hai)_`,
        hinglish: `\n🔐 *Delivery OTP: ${otp}*\n_(Share this OTP with the delivery person)_`,
        english : `\n🔐 *Delivery OTP: ${otp}*\n_(Share this OTP when your order is delivered)_`,
      };
    }
  }

  // Award loyalty points
  const orderAmount   = order.bill?.total || 0;
  const basePoints      = loyalty.calcOrderPoints(orderAmount);
  const isFirst         = await loyalty.isFirstOrder(customerId);
  const { pointsAdded } = await loyalty.addPoints(customerId, basePoints, "purchase", order.id);

  // First order bonus
  let bonusPoints = 0;
  if (isFirst) {
    await loyalty.addPoints(customerId, 50, "first_order", order.id);
    bonusPoints = 50;
  }

  const totalAwarded  = pointsAdded + bonusPoints;
  const loyaltyRecord = await loyalty.getRecord(customerId);
  const tier          = loyalty.getTier(loyaltyRecord.totalEarned);
  const customer      = await customers.get(customerId);
  const referralCode  = customer?.referralCode || "";

  // WhatsApp handoff line
  const bizSettings_  = await getSettings(order.businessId || DEFAULT_BUSINESS_ID);
  const waNum         = (bizSettings_.whatsapp_number || "").replace(/[^0-9]/g, "");
  const waLine = waNum ? {
    hindi   : `\n💬 Koi sawaal? Direct chat: wa.me/${waNum}`,
    hinglish: `\n💬 Need help? Chat with us: wa.me/${waNum}`,
    english : `\n💬 Questions? Chat with us: wa.me/${waNum}`,
  } : { hindi: "", hinglish: "", english: "" };

  session.reset(customerId);

  const codNote  = order.paymentMode === "cod"
    ? isEduConfirm
      ? { hindi: "💵 Pehli class mein payment karein.", hinglish: "💵 Pehli class mein payment karna.", english: "💵 Pay at your first class." }
      : { hindi: "💵 Cash on delivery — delivery ke time payment karein.", hinglish: "💵 Cash on delivery — delivery ke time pay karna.", english: "💵 Pay cash on delivery when your order arrives." }
    : { hindi: "", hinglish: "", english: "" };

  const refLine = referralCode ? {
    hindi   : `\n🎟️ *Aapka Referral Code: ${referralCode}*\nFriends ko share karo — har order pe 5% earn karo!`,
    hinglish: `\n🎟️ *Your Referral Code: ${referralCode}*\nFriends ko share karo — unke har order pe 5% kamao!`,
    english : `\n🎟️ *Your Referral Code: ${referralCode}*\nShare with friends — earn 5% on every order they place!`,
  } : { hindi: "", hinglish: "", english: "" };

  const confirmTitle  = isEduConfirm ? "Enrollment" : "Order";

  // If any enrolled course has an online class link, include it in confirmation
  const classLinks = (order.cart || [])
    .map(c => c.extraFields?.classLink || c.classLink)
    .filter(Boolean);
  const classLinkLine = classLinks.length
    ? { hindi: `\n🔗 *Online Class Link:*\n${classLinks[0]}`, hinglish: `\n🔗 *Online Class Link:*\n${classLinks[0]}`, english: `\n🔗 *Online Class Link:*\n${classLinks[0]}` }
    : { hindi: "", hinglish: "", english: "" };

  const trackingNote  = isEduConfirm
    ? {
        hindi   : classLinks.length ? "✅ Class link upar share ki gayi hai." : "📚 Course details jald share kiye jaayenge.",
        hinglish: classLinks.length ? "✅ Class link upar share ki gayi hai." : "📚 Course details jald share hongi.",
        english : classLinks.length ? "✅ Class link shared above — see you in class!" : "📚 Course details will be shared with you shortly.",
      }
    : { hindi: "🚚 Tracking updates यहाँ आएंगे।\n\"track order\" reply करें status check करने के लिए।", hinglish: "🚚 Tracking updates yahan aayenge.\n\"track order\" reply karo status check karne ke liye.", english: "🚚 You'll get tracking updates here.\nReply \"track order\" anytime to check status." };

  // Loyalty lines: skip for education/tourism — they don't use a points programme
  const loyaltyHindi    = isEduConfirm ? "" :
    `\n\n⭐ *${totalAwarded} Selly Points earned!*\n` +
    (bonusPoints ? `🎁 +${bonusPoints} first order bonus!\n` : "") +
    `Balance: ${loyaltyRecord.points} pts ${tier.emoji}\n`;
  const loyaltyHinglish = isEduConfirm ? "" :
    `\n\n⭐ *${totalAwarded} Selly Points mile!*\n` +
    (bonusPoints ? `🎁 +${bonusPoints} first order bonus!\n` : "") +
    `Balance: ${loyaltyRecord.points} pts ${tier.emoji}\n`;
  const loyaltyEnglish  = isEduConfirm ? "" :
    `\n\n⭐ *${totalAwarded} Selly Points earned!*\n` +
    (bonusPoints ? `🎁 +${bonusPoints} first order bonus!\n` : "") +
    `Balance: ${loyaltyRecord.points} pts ${tier.emoji}\n`;

  const msgs = {
    hindi:
      `✅ *${confirmTitle} Confirmed!* 🎉\n\n` +
      `ID: *#SL${order.id}*\n` +
      `Amount: ₹${order.bill?.total}\n\n` +
      (codNote.hindi ? codNote.hindi + "\n\n" : "") +
      codOtpLine.hindi +
      classLinkLine.hindi +
      loyaltyHindi +
      `\n${trackingNote.hindi}\n` +
      refLine.hindi + waLine.hindi,

    hinglish:
      `✅ *${confirmTitle} Confirm ho gaya!* 🎉\n\n` +
      `ID: *#SL${order.id}*\n` +
      `Amount: ₹${order.bill?.total}\n\n` +
      (codNote.hinglish ? codNote.hinglish + "\n\n" : "") +
      codOtpLine.hinglish +
      classLinkLine.hinglish +
      loyaltyHinglish +
      `\n${trackingNote.hinglish}\n` +
      refLine.hinglish + waLine.hinglish,

    english:
      `✅ *${confirmTitle} Confirmed!* 🎉\n\n` +
      `ID: *#SL${order.id}*\n` +
      `Amount: ₹${order.bill?.total}\n\n` +
      (codNote.english ? codNote.english + "\n\n" : "") +
      codOtpLine.english +
      classLinkLine.english +
      loyaltyEnglish +
      `\n${trackingNote.english}\n` +
      refLine.english + waLine.english,
  };

  await send(customerId, msgs[lang] || msgs.english);
}

// ── Payment check (customer types "paid") ─────────────────────────────────────
async function handlePaymentCheck(customerId, sess, message) {
  const lang = sess.lang || "english";
  const msg  = message.toLowerCase();

  if (msg.includes("paid") || msg.includes("done") || msg.includes("payment")) {
    const isPaid = await payment.verify(sess.currentOrderId);
    if (isPaid) {
      const order = await orders.get(sess.currentOrderId);
      await confirmOrder(customerId, order, true);
    } else {
      const notPaid = {
        hindi   : `Payment अभी receive नहीं हुई।\n\n💳 यहाँ pay करें: ${sess.payLink?.url || "link expired"}\n\n"cancel" reply करें start over के लिए।`,
        hinglish: `Payment abhi receive nahi hui.\n\n💳 Yahan pay karo: ${sess.payLink?.url || "link expired"}\n\n"cancel" reply karo start over ke liye.`,
        english : `Payment not received yet.\n\n💳 Pay here: ${sess.payLink?.url || "link expired"}\n\nReply "cancel" to start over.`,
      };
      await send(customerId, notPaid[lang] || notPaid.english);
    }
  }
}

// ── Auto-confirm after Razorpay webhook ───────────────────────────────────────
async function handlePaymentSuccess(paymentLinkId) {
  // Find order by payment link ID
  const _res      = await orders.getAll();
  const allOrders = _res.orders || [];
  const order     = allOrders.find(o => o.payLink?.id === paymentLinkId);
  if (!order || order.status !== "pending_payment") return;
  console.log(`[Payment] Auto-confirming order #SL${order.id}`);
  await confirmOrder(order.customerId, order, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE: Loyalty Points Check
// ─────────────────────────────────────────────────────────────────────────────
async function handleLoyaltyCheck(customerId, sess) {
  const lang   = sess.lang || "english";
  const record = await loyalty.getRecord(customerId);
  const tier   = loyalty.getTier(record.totalEarned);
  const redeem = await loyalty.getRedeemInfo(customerId);

  const msgs = {
    hindi:
      `⭐ *Aapke Selly Points*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${tier.emoji} *${tier.name} Member*\n` +
      `💫 Balance: *${record.points} points*\n` +
      `📊 Total earned: ${record.totalEarned} pts\n` +
      `🛍️ Orders: ${record.ordersCount}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      (redeem.canRedeem
        ? `💸 *₹${redeem.maxDiscount} off* redeem kar sakte hain!\n` +
          `Checkout mein "USE POINTS" reply karein.`
        : `🎯 Sirf *${redeem.nextMilestone} aur points* chahiye ₹50 off ke liye!`),

    hinglish:
      `⭐ *Aapke Selly Points*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${tier.emoji} *${tier.name} Member*\n` +
      `💫 Balance: *${record.points} points*\n` +
      `📊 Total earned: ${record.totalEarned} pts\n` +
      `🛍️ Orders: ${record.ordersCount}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      (redeem.canRedeem
        ? `💸 *₹${redeem.maxDiscount} off* redeem kar sakte ho!\n` +
          `Checkout mein "USE POINTS" reply karo.`
        : `🎯 Bas *${redeem.nextMilestone} aur points* chahiye ₹50 off ke liye!`),

    english:
      `⭐ *Your Selly Points*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${tier.emoji} *${tier.name} Member*\n` +
      `💫 Balance: *${record.points} points*\n` +
      `📊 Total earned: ${record.totalEarned} pts\n` +
      `🛍️ Orders: ${record.ordersCount}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      (redeem.canRedeem
        ? `💸 You can redeem *₹${redeem.maxDiscount} off* your next order!\n` +
          `Reply "USE POINTS" during checkout.`
        : `🎯 Just *${redeem.nextMilestone} more points* to unlock ₹50 off!`),
  };
  await send(customerId, msgs[lang] || msgs.english);
}

// ─────────────────────────────────────────────────────────────────────────────
// Other handlers (tracking, returns, etc.)
// ─────────────────────────────────────────────────────────────────────────────
async function handleTracking(customerId, sess, message) {
  const customerOrders = await orders.getByCustomer(customerId);
  const lang           = sess.lang || "english";
  const trackSettings  = await getSettings(sess.businessId || DEFAULT_BUSINESS_ID);
  const trackInd       = (trackSettings.industry || "").toLowerCase();
  const isEduTrack     = trackInd.includes("education");

  if (!customerOrders.length) {
    const none = {
      hindi   : isEduTrack ? "अभी कोई enrollment नहीं है! Courses देखें 😊" : "अभी कोई order नहीं है! Shopping start करें 😊",
      hinglish: isEduTrack ? "Abhi koi enrollment nahi hai! Courses dekho 😊"  : "Abhi koi order nahi hai! Shopping karo 😊",
      english : isEduTrack ? "You don't have any enrollments yet! Browse courses 😊" : "You don't have any orders yet! Start shopping 😊",
    };
    return send(customerId, none[lang] || none.english);
  }

  return sendTrackingInfo(customerId, customerOrders[0], isEduTrack);
}

async function sendTrackingInfo(customerId, order, isEdu = false) {
  const timeline = buildTimeline(order, isEdu);
  const title    = isEdu ? "🎓 ENROLLMENT" : "📦 ORDER";
  const payLabel = order.paymentMode === "cod"
    ? (isEdu ? "💵 Pay at Venue" : "💵 COD")
    : "💳 Online";
  await send(customerId,
    `════════════════════════\n` +
    `${title} #SL${order.id}\n` +
    `════════════════════════\n` +
    `${(order.cart || []).map(i => `${i.name}`).join("\n")}\n` +
    `${isEdu ? "Fees" : "Total"}: ₹${order.bill?.total}\n` +
    `Payment: ${payLabel}\n` +
    `────────────────────────\n` +
    `${timeline}\n` +
    `════════════════════════\n` +
    (!isEdu && order.trackingNumber ? `🔗 Track: ${order.trackingUrl || order.trackingNumber}` : "")
  );
}

function buildTimeline(order, isEdu = false) {
  const steps = isEdu
    ? [
        { key: "confirmed",    label: "Enrolled",      emoji: "✅" },
        { key: "in_progress",  label: "In Progress",   emoji: "📖" },
        { key: "completed",    label: "Completed",     emoji: "🏆" },
      ]
    : [
        { key: "confirmed",        label: "Order Placed",     emoji: "✅" },
        { key: "packed",           label: "Packed",           emoji: "📦" },
        { key: "shipped",          label: "Shipped",          emoji: "🚚" },
        { key: "out_for_delivery", label: "Out for Delivery", emoji: "🛵" },
        { key: "delivered",        label: "Delivered",        emoji: "✅" },
      ];
  const currentIdx = steps.findIndex(s => s.key === order.status);
  return steps.map((s, i) => `${i <= currentIdx ? s.emoji : "⏳"} ${s.label}`).join("\n");
}

async function handleReturn(customerId, sess, message) {
  const lang        = sess.lang || "english";
  const retSettings = await getSettings(sess.businessId || DEFAULT_BUSINESS_ID);
  const retInd      = (retSettings.industry || "").toLowerCase();

  // Education/Tourism — no physical return; direct to support instead
  if (retInd.includes("education") || retInd.includes("tourism")) {
    const notApplicable = {
      hindi   : `📞 कोई issue है? हमसे directly contact करें और हम help करेंगे।`,
      hinglish: `📞 Koi issue hai? Directly contact karo, hum help karenge.`,
      english : `📞 Have a concern? Please contact us directly and we'll be happy to help.`,
    };
    return send(customerId, notApplicable[lang] || notApplicable.english);
  }

  const _cOrders = await orders.getByCustomer(customerId);
  const recent   = _cOrders.find(o => o.status === "delivered");
  if (!recent) {
    const none = { hindi: "Return के लिए कोई delivered order नहीं है।", hinglish: "Return ke liye koi delivered order nahi hai.", english: "No delivered orders found to return." };
    return send(customerId, none[lang] || none.english);
  }
  await orders.updateStatus(recent.id, "return_requested");
  const msgs = {
    hindi   : `🔄 *Return Request Received*\n\nOrder #SL${recent.id}\n24 घंटे में contact करेंगे।\nOriginal packaging के साथ item ready रखें।`,
    hinglish: `🔄 *Return Request Mila!*\n\nOrder #SL${recent.id}\n24 hours mein contact karenge.\nOriginal packaging ke saath item ready rakho.`,
    english : `🔄 *Return Request Received*\n\nOrder #SL${recent.id}\nWe'll contact you within 24 hours.\nPlease keep the item ready with original packaging.`,
  };
  await send(customerId, msgs[lang] || msgs.english);
}

async function handleOrderHistory(customerId, sess) {
  const lang       = sess.lang || "english";
  const histSettings = await getSettings(sess.businessId || DEFAULT_BUSINESS_ID);
  const histInd    = (histSettings.industry || "").toLowerCase();
  const isEduHist  = histInd.includes("education");
  const allOrders  = await orders.getByCustomer(customerId);
  if (!allOrders.length) {
    const none = {
      hindi   : isEduHist ? "अभी कोई enrollment नहीं। Courses देखें! 😊" : "अभी कोई order नहीं। Shopping शुरू करें! 😊",
      hinglish: isEduHist ? "Abhi koi enrollment nahi. Courses dekho! 😊"  : "Abhi koi order nahi. Shopping karo! 😊",
      english : isEduHist ? "No enrollments yet! Browse courses 😊"         : "No orders yet! Start shopping 😊",
    };
    return send(customerId, none[lang] || none.english);
  }
  const list = allOrders.slice(0, 5).map(o =>
    `#SL${o.id} — ${(o.cart||[])[0]?.name} — ₹${o.bill?.total} — ${getStatusEmoji(o.status)} ${o.status}`
  ).join("\n");
  const title  = isEduHist ? "📋 *आपके Enrollments:*" : "📋 *आपके Orders:*";
  const titleE = isEduHist ? "📋 *Your Enrollments:*"  : "📋 *Your Orders:*";
  const header = { hindi: `${title}\n\n${list}`, hinglish: `${title}\n\n${list}`, english: `${titleE}\n\n${list}` };
  await send(customerId, header[lang] || header.english);
}

async function handleReferralCode(customerId) {
  const customer = await customers.get(customerId);
  if (!customer) return send(customerId, "Start shopping first to get a referral code! 😊");
  const code = customer.referralCode;
  await send(customerId,
    `🎟️ *Your Referral Code:*\n━━━━━━━━\n📌 *${code}*\n━━━━━━━━\n\n` +
    `Share with friends! You earn *5%* every time someone orders with your code.\n\n` +
    `📊 ${customer.referralCount || 0} referrals · ₹${customer.referralEarnings || 0} earned`
  );
}

// ── Photo Search — customer sends image → try catalog match → inquiry if none ──
async function handlePhotoSearch(customerId, sess, imageUrl, name) {
  const lang = sess.lang || "english";

  const searching = {
    hindi   : "🔍 Aapki photo dekh raha hoon, ek second...",
    hinglish: "🔍 Searching for this product, one moment...",
    english : "🔍 Searching our catalog for this product...",
  };
  await send(customerId, searching[lang] || searching.english);

  try {
    // Use AI to extract product keywords from image
    const content = await ai.generateProductContent(imageUrl);
    const keywords = content.suggestedCategory || content.name ||
      (content.caption || "").split(" ").slice(0, 4).join(" ");

    if (keywords) {
      const searchResult = await catalog.search({ product: keywords, rawQuery: keywords });
      const results      = (searchResult.results || searchResult).filter(p => p.inStock !== false);

      if (results.length) {
        session.update(customerId, { state: "selecting", searchResults: results });
        const header = {
          hindi   : `✅ *${results.length} matching products mile:*\n\n`,
          hinglish: `✅ *${results.length} similar product${results.length > 1 ? "s" : ""} found:*\n\n`,
          english : `✅ *${results.length} similar product${results.length > 1 ? "s" : ""} found:*\n\n`,
        };
        const list = results.slice(0, 5).map((p, i) =>
          `${i + 1}️⃣ *${p.name}* — ₹${p.price > 0 ? p.price : "Contact"}\n` +
          (p.colors?.length ? `   🎨 ${p.colors.slice(0, 3).join(", ")}` : "")
        ).join("\n\n");
        const footer = {
          hindi   : `\n\nNumber reply karo select karne ke liye • "done" checkout ke liye 🛒`,
          hinglish: `\n\nNumber reply karo • "done" to checkout 🛒`,
          english : `\n\nReply number to select • "done" to checkout 🛒`,
        };
        return send(customerId, (header[lang] || header.english) + list + (footer[lang] || footer.english));
      }
    }
  } catch (e) {
    console.error("[PhotoSearch] AI error:", e.message);
  }

  // ── No match found — create inquiry and notify owner ──────────────────────
  await photoInquiry.create(customerId, imageUrl, name);

  const notFound = {
    hindi   : `📝 *Aapki request note ho gayi!* 🌟\n\nHamara team jald hi aapko matching products ke baare mein batayega.\nThoda wait karein — hum contact karenge! 🙏`,
    hinglish: `📝 *We've noted your wish!* 🌟\n\nOur team will review your photo and get back to you with the best matches shortly.\nThank you for your patience! 😊`,
    english : `📝 *Your request has been noted!* 🌟\n\nOur team will review your photo and get back to you with matching products shortly.\nThank you! 😊`,
  };
  return send(customerId, notFound[lang] || notFound.english);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function isWishlistRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("wishlist") || m.includes("wish list") || m.includes("meri list") ||
         m.includes("saved items") || m.includes("my wishlist");
}

async function handleWishlistCommand(customerId, sess, message) {
  const lang  = sess.lang || "english";
  const items = await wishlistMod.getByCustomer(customerId);

  if (!items.length) {
    const empty = {
      hindi   : `❤️ Aapki wishlist empty hai!\n\nKoi out-of-stock product dekhne par "1" reply karo wishlist mein add karne ke liye.`,
      hinglish: `❤️ Your wishlist is empty!\n\nWhen you see an out-of-stock product, reply "1" to add it and we'll notify you when it's back!`,
      english : `❤️ Your wishlist is empty!\n\nWhen you find an out-of-stock product, reply "1" to add it — we'll notify you when it's restocked!`,
    };
    return send(customerId, empty[lang] || empty.english);
  }

  const list = items.map((w, i) =>
    `${i + 1}. ${w.product_name || "Product"}${w.notified ? " ✅" : " ⏳"}`
  ).join("\n");

  const header = {
    hindi   : `❤️ *Aapki Wishlist (${items.length} items):*\n\n${list}\n\n⏳ = waiting  ✅ = notified`,
    hinglish: `❤️ *Your Wishlist (${items.length} item${items.length > 1 ? "s" : ""}):*\n\n${list}\n\n⏳ = waiting for restock  ✅ = you were notified`,
    english : `❤️ *Your Wishlist (${items.length} item${items.length > 1 ? "s" : ""}):*\n\n${list}\n\n⏳ = waiting for restock  ✅ = notified`,
  };
  return send(customerId, header[lang] || header.english);
}

function isLoyaltyRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("points") || m.includes("loyalty") || m.includes("reward") ||
         m.includes("mera points") || m.includes("kitne points") || m.includes("selly points");
}
function isTrackingRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("track") || m.includes("order status") || m.includes("kahan hai") ||
         m.includes("kab aayega") || m.includes("delivery status");
}
function isReturnRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("return") || m.includes("refund") || m.includes("exchange") ||
         m.includes("wrong") || m.includes("damaged");
}
function isOrderHistoryRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("my orders") || m.includes("order history") || m.includes("past orders") ||
         m.includes("mera order");
}
function isReferralRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("referral") || m.includes("refer") || m.includes("my code");
}
function getStatusEmoji(s) {
  const map = {
    pending_payment  : "⏳",
    confirmed        : "✅",
    packed           : "📦",
    shipped          : "🚚",
    out_for_delivery : "🛵",
    delivered        : "✅",
    in_progress      : "📖",   // education: active / in progress
    completed        : "🏆",   // education: course completed
    return_requested : "🔄",
    cancelled        : "❌",
  };
  return map[s] || "📋";
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD APIs (used by Selly mobile app)
// ─────────────────────────────────────────────────────────────────────────────

app.get ("/api/orders",         async (req, res) => {
  try {
    const bid = getBid(req);
    const [stats, result] = await Promise.all([
      orders.getStats(bid),
      orders.getAll({ status: req.query.status, page: Number(req.query.page) || 1, businessId: bid }),
    ]);
    res.json({ stats, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get ("/api/stats",          async (req, res) => {
  try { res.json(await orders.getStats(getBid(req))); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get ("/api/customers",      async (req, res) => {
  try {
    const bid = getBid(req);
    const [stats, result] = await Promise.all([
      customers.getStats(bid),
      customers.getAll({ tag: req.query.tag, page: Number(req.query.page) || 1, businessId: bid }),
    ]);
    res.json({ stats, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get ("/api/customers/stats", async (req, res) => {
  try { res.json(await customers.getStats()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get ("/api/customers/:id",   async (req, res) => {
  try {
    const [c, cOrders] = await Promise.all([
      customers.get(req.params.id),
      orders.getByCustomer(req.params.id),
    ]);
    if (!c) return res.status(404).json({ error: "Not found" });
    res.json({ customer: c, orders: cOrders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// (duplicate GET /api/orders removed — the handler at line ~1582 handles this)

app.post("/api/orders/:id/status", async (req, res) => {
  const { status: newStatus, trackingNumber, trackingUrl } = req.body;
  const updated = await orders.updateStatus(req.params.id, newStatus, { trackingNumber, trackingUrl });
  if (!updated) return res.status(404).json({ error: "Order not found" });

  const msgs = {
    packed          : "📦 Great news! Your order is packed and ready to ship.",
    shipped         : `🚚 Your order is on the way!${trackingNumber ? ` Tracking: ${trackingNumber}` : ""}`,
    delivered       : "✅ Delivered! Hope you love it 😊\nReply ⭐⭐⭐⭐⭐ to rate your experience.",
  };

  // ── Out for delivery → generate delivery OTP ──────────────────────────────
  if (newStatus === "out_for_delivery") {
    const otp = await otpMod.createDeliveryOTP(req.params.id);
    wa.send(updated.customerId,
      `🛵 *Out for Delivery!*\n\nYour order is arriving today!\n\n` +
      `🔐 *Delivery OTP: ${otp}*\n` +
      `_(Share this with the delivery person to confirm receipt)_`
    ).catch(() => {});
  } else if (msgs[newStatus]) {
    wa.send(updated.customerId, msgs[newStatus]).catch(() => {});
  }

  if (newStatus === "delivered") scheduleReviewRequest(updated.customerId, updated.id, updated.name);
  res.json({ ok: true, order: updated });
});

// ── Catalog APIs ──────────────────────────────────────────────────────────────
app.get   ("/api/catalog",        async (req, res) => {
  try { res.json({ products: await catalog.getAll(getBid(req)) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post  ("/api/catalog/add",    async (req, res) => {
  try { res.json({ ok: true, product: await catalog.addProduct(req.body, getBid(req)) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put   ("/api/catalog/:id",    async (req, res) => {
  try {
    const p = await catalog.update(req.params.id, req.body, getBid(req));
    p ? res.json({ ok: true, p }) : res.status(404).json({ error: "Not found" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/catalog/:id",    async (req, res) => {
  try {
    const d = await catalog.deleteProduct(req.params.id, getBid(req));
    d ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post  ("/api/catalog/stock",  async (req, res) => {
  try {
    const { id, inStock } = req.body;
    if (!id) return res.status(400).json({ error: "id required" });
    const p = await catalog.toggleStock(id, inStock);
    if (!p) return res.status(404).json({ error: "Not found" });

    // ── Restock alerts — notify everyone who wishlisted this product ─────
    let restockNotified = 0;
    if (inStock === true || inStock === "true") {
      const wishers = await wishlistMod.getByProduct(id);
      for (const w of wishers) {
        try {
          await wa.send(w.customer_id,
            `🎉 *Back in Stock!*\n\n` +
            `*${w.product_name || p.name}* is now available!\n\n` +
            `Reply "${w.product_name || p.name}" to order now 🛍️`
          );
          await wishlistMod.markNotified(w.customer_id, id);
          restockNotified++;
        } catch {}
      }
      if (restockNotified) console.log(`[Restock] Notified ${restockNotified} wishlist customers for product ${id}`);
    }

    res.json({ ok: true, p, restockNotified });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post  ("/api/catalog/upload", (req, res) => {
  res.status(400).json({ error: "CSV upload not supported. Add products via the app." });
});
app.post("/api/insta/fetch", async (req, res) => {
  const { url } = req.body;
  if (!url || !instafetch.isInstaUrl(url)) return res.status(400).json({ ok:false, error:"Not a valid Instagram URL" });
  try {
    const data = await instafetch.fetchPostData(url);
    res.json({ ok:true, imageUrl:data.imageUrl, caption:data.caption, name:instafetch.guessName(data.caption), category:instafetch.guessCategory(data.caption), colors:instafetch.guessColors(data.caption) });
  } catch (err) { res.json({ ok:false, error:err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE APIs: Status, Loyalty, Festivals
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/status/log — Selly app calls this when business owner posts a status
app.post("/api/status/log", async (req, res) => {
  const entry = await status.logStatus(req.body);
  res.json({ ok: true, entry });
});

// GET /api/status/active — list active statuses
app.get("/api/status/active", async (req, res) => {
  res.json({ statuses: await status.getActiveStatuses() });
});

// GET /api/loyalty/:customerId — get loyalty record
app.get("/api/loyalty/:id", async (req, res) => {
  const record     = await loyalty.getRecord(req.params.id);
  const tier       = loyalty.getTier(record.totalEarned);
  const redeemInfo = await loyalty.getRedeemInfo(req.params.id);
  res.json({ record, tier, redeemInfo });
});

// GET /api/loyalty/leaderboard — top customers by points
app.get("/api/loyalty/leaderboard", async (req, res) => {
  const { customers: allCustomers = [] } = await customers.getAll();
  const withLoyalty = await Promise.all(allCustomers.map(async c => {
    const loyaltyRecord = await loyalty.getRecord(c.id);
    return { ...c, loyaltyRecord, tier: loyalty.getTier(loyaltyRecord.totalEarned) };
  }));
  const leaderboard = withLoyalty
    .sort((a, b) => b.loyaltyRecord.points - a.loyaltyRecord.points)
    .slice(0, 20);
  res.json({ leaderboard });
});

// GET /api/festivals/upcoming — upcoming festivals
app.get("/api/festivals/upcoming", (req, res) => {
  const daysAhead = parseInt(req.query.days || "14");
  res.json({ festivals: festivals.getUpcoming(daysAhead) });
});

// GET /api/festivals/alerts — festivals in their alert window today
app.get("/api/festivals/alerts", (req, res) => {
  res.json({ alerts: festivals.getAlertsForToday() });
});

// POST /api/promote/festival — broadcast a festival campaign
app.post("/api/promote/festival", async (req, res) => {
  const { festivalName, discount = 10, businessName = "our store" } = req.body;
  if (!festivalName) return res.status(400).json({ error: "festivalName required" });

  if (await festivals.wasAlreadyBroadcast(festivalName)) {
    return res.json({ ok: false, reason: "Already broadcast for this festival. Clear log to resend." });
  }

  const message = festivals.getCampaignMessage(festivalName, businessName, discount);
  if (!message) return res.status(400).json({ error: "Unknown festival" });

  const { customers: allCustomers = [] } = await customers.getAll();
  let sent = 0;
  for (const c of allCustomers) {
    try {
      await wa.send(c.id, message);
      session.update(c.id, { promoSource: "festival_" + festivalName.toLowerCase().replace(/\s/g, "_"), promoSentAt: Date.now() });
      sent++;
    } catch {}
  }

  await festivals.logBroadcast(festivalName, sent);
  console.log(`[festival] ${festivalName} broadcast sent to ${sent} customers`);
  res.json({ ok: true, sent, total: allCustomers.length });
});

// ── Existing promotion APIs ────────────────────────────────────────────────────
app.post("/api/promote/flash", async (req, res) => {
  const { message, productIds = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  // Build product list block if products were selected
  let productBlock = "";
  if (productIds.length > 0) {
    const prods = await Promise.all(productIds.map(id => catalog.get(id)));
    const lines  = prods.filter(Boolean).map(p =>
      `• *${p.name}* — ₹${p.price > 0 ? p.price.toLocaleString("en-IN") : "Contact"}` +
      (p.sizes?.length ? ` | Sizes: ${p.sizes.join(", ")}` : "") +
      (p.colors?.length ? ` | ${p.colors.join(", ")}` : "")
    );
    if (lines.length) productBlock = `\n\n🛍️ *Products on Sale:*\n${lines.join("\n")}`;
  }

  const fullMsg = message + productBlock + "\n\nReply with a product name to order! 👇";
  const { customers: allCustomers = [] } = await customers.getAll();
  let sent = 0;
  for (const c of allCustomers) {
    try { await wa.send(c.id, fullMsg); session.update(c.id, { promoSource: "flash_sale", promoSentAt: Date.now() }); sent++; } catch {}
  }
  res.json({ ok: true, sent, total: allCustomers.length });
});

app.post("/api/promote/newarrival", async (req, res) => {
  const { productIds = [], message } = req.body;
  if (!productIds.length) return res.status(400).json({ error: "productIds required" });

  const prods = await Promise.all(productIds.map(id => catalog.get(id)));
  const valid  = prods.filter(Boolean);
  if (!valid.length) return res.status(404).json({ error: "No valid products found" });

  const productLines = valid.map(p =>
    `✨ *${p.name}*\n` +
    `   💰 ${p.price > 0 ? `₹${p.price.toLocaleString("en-IN")}` : "Contact for price"}\n` +
    (p.sizes?.length  ? `   📏 ${p.sizes.join(", ")}\n`  : "") +
    (p.colors?.length ? `   🎨 ${p.colors.join(", ")}\n` : "") +
    (p.description    ? `   ${p.description.slice(0, 60)}${p.description.length > 60 ? "…" : ""}\n` : "")
  ).join("\n");

  const header = message || "🆕 *New Arrivals are here!* Check out what's fresh 👇";
  const fullMsg = `${header}\n\n${productLines}\nReply with a product name to order!`;

  const { customers: allCustomers = [] } = await customers.getAll();
  let sent = 0;
  for (const c of allCustomers) {
    try { await wa.send(c.id, fullMsg); session.update(c.id, { promoSource: "new_arrival", promoSentAt: Date.now() }); sent++; } catch {}
  }
  res.json({ ok: true, sent });
});

app.post("/api/promote/abandoned", async (req, res) => {
  const recovered = await runAbandonedCartRecovery();
  res.json({ ok: true, sent: recovered });
});

// POST /api/promote/video — blast a video + caption to all/segment customers
app.post("/api/promote/video", async (req, res) => {
  const bid = req.headers["x-business-id"] || req.query.bid || DEFAULT_BUSINESS_ID;
  const { videoUrl, caption = "", segment = "all" } = req.body;
  if (!videoUrl) return res.status(400).json({ error: "videoUrl required" });

  const { customers: allCustomers = [] } = await customers.getAll({ businessId: bid });

  // Filter by segment
  const targets = allCustomers.filter(c => {
    if (segment === "all")      return true;
    if (segment === "vip")      return (c.tags || []).includes("vip");
    if (segment === "repeat")   return (c.totalOrders || 0) >= 2;
    if (segment === "new")      return c.firstSeenAt && (Date.now() - new Date(c.firstSeenAt).getTime()) < 30 * 86400000;
    if (segment === "inactive") return c.lastActiveAt && (Date.now() - new Date(c.lastActiveAt).getTime()) > 60 * 86400000;
    return true;
  });

  let sent = 0;
  for (const c of targets) {
    try {
      const ctx = _waCtx(c.id);
      await wa.sendVideo(c.id, videoUrl, caption, ctx.phoneId, ctx.token);
      sent++;
    } catch (e) {
      console.warn(`[VideoBlast] Failed to send to ${c.id}:`, e.message);
    }
  }
  res.json({ ok: true, sent, total: targets.length });
});

// POST /api/promote/upload — save a base64 file to public/media/, return URL
// Used by Image Blast and PDF Blast so teachers can pick from device
app.post("/api/promote/upload", async (req, res) => {
  try {
    const { base64, mimeType = "application/octet-stream", filename = "file" } = req.body;
    if (!base64) return res.status(400).json({ error: "base64 required" });

    const buf  = Buffer.from(base64, "base64");
    const ext  = path.extname(filename) || (mimeType.includes("pdf") ? ".pdf" : ".jpg");
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const dir  = path.join(__dirname, "../public/media");

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, name), buf);

    const BASE_URL = (process.env.BASE_URL || "https://instagram-bot-production-ef01.up.railway.app").replace(/\/$/, "");
    res.json({ ok: true, url: `${BASE_URL}/media/${name}`, filename: name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/promote/image — blast an image to all/segment customers (or students)
app.post("/api/promote/image", async (req, res) => {
  const bid = req.headers["x-business-id"] || req.query.bid || DEFAULT_BUSINESS_ID;
  const { imageUrl, caption = "", segment = "all" } = req.body;
  if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });

  const { customers: allCustomers = [] } = await customers.getAll({ businessId: bid });
  const targets = allCustomers.filter(c => {
    if (segment === "all")      return true;
    if (segment === "vip")      return (c.tags || []).includes("vip");
    if (segment === "repeat")   return (c.totalOrders || 0) >= 2;
    if (segment === "new")      return c.firstSeenAt && (Date.now() - new Date(c.firstSeenAt).getTime()) < 30 * 86400000;
    if (segment === "inactive") return c.lastActiveAt && (Date.now() - new Date(c.lastActiveAt).getTime()) > 60 * 86400000;
    return true;
  });

  let sent = 0;
  for (const c of targets) {
    try {
      const ctx = _waCtx(c.id);
      await wa.sendImage(c.id, imageUrl, caption, ctx.phoneId, ctx.token);
      sent++;
    } catch (e) {
      console.warn(`[ImageBlast] Failed ${c.id}:`, e.message);
    }
  }
  res.json({ ok: true, sent, total: targets.length });
});

// POST /api/promote/pdf — blast a PDF/document to all/segment customers (or students)
app.post("/api/promote/pdf", async (req, res) => {
  const bid = req.headers["x-business-id"] || req.query.bid || DEFAULT_BUSINESS_ID;
  const { pdfUrl, caption = "", filename = "Document.pdf", segment = "all" } = req.body;
  if (!pdfUrl) return res.status(400).json({ error: "pdfUrl required" });

  const { customers: allCustomers = [] } = await customers.getAll({ businessId: bid });
  const targets = allCustomers.filter(c => {
    if (segment === "all")      return true;
    if (segment === "vip")      return (c.tags || []).includes("vip");
    if (segment === "repeat")   return (c.totalOrders || 0) >= 2;
    if (segment === "new")      return c.firstSeenAt && (Date.now() - new Date(c.firstSeenAt).getTime()) < 30 * 86400000;
    if (segment === "inactive") return c.lastActiveAt && (Date.now() - new Date(c.lastActiveAt).getTime()) > 60 * 86400000;
    return true;
  });

  let sent = 0;
  for (const c of targets) {
    try {
      const ctx = _waCtx(c.id);
      await wa.sendDocument(c.id, pdfUrl, filename, caption, ctx.phoneId, ctx.token);
      sent++;
    } catch (e) {
      console.warn(`[PdfBlast] Failed ${c.id}:`, e.message);
    }
  }
  res.json({ ok: true, sent, total: targets.length });
});

// POST /api/customers/import — bulk add existing contacts (students) to the list
// Uses a single Supabase upsert (not N sequential queries) so even 500 contacts
// completes in ~1 second instead of timing out.
app.post("/api/customers/import", async (req, res) => {
  const bid = req.headers["x-business-id"] || req.query.bid || DEFAULT_BUSINESS_ID;
  const { contacts = [] } = req.body;
  if (!contacts.length) return res.status(400).json({ error: "No contacts provided" });
  try {
    const result = await customers.bulkImport(contacts, bid);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[Import] bulk import error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WISHLIST APIs
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/wishlist/:customerId", async (req, res) => {
  try {
    const items = await wishlistMod.getByCustomer(req.params.customerId);
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// OTP APIs
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/orders/:id/otp", async (req, res) => {
  try {
    const otps = await otpMod.getOTPs(req.params.id);
    res.json({ otps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/orders/:id/verify-otp", async (req, res) => {
  const { otp, type = "delivery" } = req.body;
  try {
    const ok = type === "cod"
      ? await otpMod.verifyCodOTP(req.params.id, otp)
      : await otpMod.verifyDeliveryOTP(req.params.id, otp);
    res.json({ ok, verified: ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PHOTO INQUIRY APIs
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/inquiries", async (req, res) => {
  try {
    const pending = req.query.pending === "true";
    const items   = pending
      ? await photoInquiry.getPending()
      : await photoInquiry.getAll();
    res.json({ inquiries: items, pending: items.filter(i => i.status === "pending").length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/inquiries/:id/reply", async (req, res) => {
  const { reply: ownerReply, productId } = req.body;
  if (!ownerReply) return res.status(400).json({ error: "reply required" });
  try {
    const inquiry = await photoInquiry.reply(req.params.id, ownerReply, productId || null);
    if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });
    // Send WA DM to customer with owner's reply
    const replyMsg = productId
      ? `✨ *We found something for you!*\n\n${ownerReply}\n\nReply "${ownerReply.split(" ")[0]}" to order!`
      : `✨ *Update from our team:*\n\n${ownerReply}`;
    wa.send(inquiry.customer_id, replyMsg).catch(() => {});
    res.json({ ok: true, inquiry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// TRACKING API
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/tracking/:awb", async (req, res) => {
  const { awb } = req.params;
  const carrier = req.query.carrier || "shiprocket";
  try {
    const bid      = req.headers["x-business-id"] || req.query.bid || DEFAULT_BUSINESS_ID;
    const settings = await getSettings(bid);
    const result   = await trackingMod.track(awb, carrier, {
      shiprocketEmail   : settings.shiprocket_email,
      shiprocketPassword: settings.shiprocket_password,
      delhiveryApiKey   : settings.delhivery_api_key,
    });
    if (!result) return res.status(404).json({ error: "Tracking data not found. Check AWB and carrier credentials." });

    // Auto-advance order status based on carrier status
    const orderId = req.query.orderId;
    if (orderId) {
      const mapped = trackingMod.mapStatus(result.statusText);
      if (mapped) await orders.updateStatus(orderId, mapped).catch(() => {});
    }

    res.json({ ok: true, tracking: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEGMENT BROADCAST
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/promote/segment", async (req, res) => {
  const { segment = "all", message, productIds = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const { customers: allCustomers = [] } = await customers.getAll();
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const SIXTY_DAYS  = 60 * 24 * 60 * 60 * 1000;

  let targets;
  switch (segment) {
    case "vip":
      targets = allCustomers.filter(c => (c.totalSpend || 0) >= 5000);
      break;
    case "new":
      targets = allCustomers.filter(c => (now - (c.firstSeenAt || 0)) < THIRTY_DAYS);
      break;
    case "inactive":
      targets = allCustomers.filter(c => (now - (c.lastActiveAt || 0)) > SIXTY_DAYS);
      break;
    case "repeat":
      targets = allCustomers.filter(c => (c.totalOrders || 0) >= 2);
      break;
    default:
      targets = allCustomers;
  }

  // Build product block
  let productBlock = "";
  if (productIds.length > 0) {
    const prods = await Promise.all(productIds.map(id => catalog.get(id)));
    const lines  = prods.filter(Boolean).map(p =>
      `• *${p.name}* — ₹${p.price > 0 ? p.price.toLocaleString("en-IN") : "Contact"}` +
      (p.sizes?.length  ? ` | ${p.sizes.join(", ")}`  : "") +
      (p.colors?.length ? ` | ${p.colors.join(", ")}` : "")
    );
    if (lines.length) productBlock = `\n\n🛍️ *Featured:*\n${lines.join("\n")}`;
  }

  const fullMsg = message + productBlock + "\n\nReply with a product name to order! 👇";
  let sent = 0;
  for (const c of targets) {
    try {
      await wa.send(c.id, fullMsg);
      session.update(c.id, { promoSource: "segment_" + segment, promoSentAt: now });
      sent++;
    } catch {}
  }

  console.log(`[Segment] ${segment} broadcast sent to ${sent}/${targets.length}`);
  res.json({ ok: true, sent, total: targets.length, segment });
});

// ── Business Settings ─────────────────────────────────────────────────────────
// In-memory cache so every order doesn't hit the DB
const db = require("./db");
const { supabaseAdmin } = require("./supabase");
const _settingsCache = {};

// Reads business settings from Supabase (migrated from Railway PostgreSQL)
async function getSettings(businessId = DEFAULT_BUSINESS_ID) {
  if (_settingsCache[businessId]) return _settingsCache[businessId];
  try {
    if (!supabaseAdmin) return {};
    const { data, error } = await supabaseAdmin
      .from("business_settings")
      .select("*")
      .eq("business_id", businessId)
      .maybeSingle();
    if (data) { _settingsCache[businessId] = data; return data; }
  } catch {}
  return {}; // fallback to billing.js defaults
}

app.get("/api/settings", async (req, res) => {
  const bid = req.headers["x-business-id"] || req.query.bid || DEFAULT_BUSINESS_ID;
  const s   = await getSettings(bid);
  res.json({ settings: s });
});

app.post("/api/settings", async (req, res) => {
  const bid = req.headers["x-business-id"] || req.query.bid || DEFAULT_BUSINESS_ID;
  const allowed = [
    "business_name","business_gst_no","business_address",
    "gst_enabled","gst_rate","delivery_charge","free_above","cod_fee",
    "whatsapp_number","shiprocket_email","shiprocket_password","delhivery_api_key",
    "industry",
  ];
  const updates = { business_id: bid, updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length <= 2) return res.status(400).json({ error: "No fields to update" });

  try {
    if (!supabaseAdmin) return res.status(503).json({ error: "Supabase not configured" });
    const { error } = await supabaseAdmin
      .from("business_settings")
      .upsert(updates, { onConflict: "business_id" });
    if (error) throw new Error(error.message);
    delete _settingsCache[bid]; // invalidate cache
    const s = await getSettings(bid);
    res.json({ ok: true, settings: s });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN APIs — protected by ADMIN_SECRET env var
// Only callable from the Selly admin account (codeforeai.app@gmail.com)
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || "selly_admin_2024";

function isAdmin(req) {
  return req.headers["x-admin-token"] === ADMIN_SECRET;
}

// GET /api/admin/clients — list all subscriptions + days remaining + registered number
app.get("/api/admin/clients", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  try {
    const allSubs   = await subscriptions.getAll();
    const allNums   = await waNumbers.getAll();
    const numsByBid = {};
    for (const n of allNums) numsByBid[n.business_id] = n;
    const now     = Date.now();
    const clients = allSubs.map(s => {
      const num = numsByBid[s.businessId];
      return {
        businessId   : s.businessId,
        status       : s.status,
        plan         : s.plan,
        monthlyFee   : s.monthlyFee,
        daysRemaining: s.status === "trial"
          ? Math.max(0, Math.ceil((s.trialEnds - now) / 86400000))
          : Math.max(0, Math.ceil((s.paidUntil - now) / 86400000)),
        trialStarted : s.trialStarted,
        trialEnds    : s.trialEnds,
        paidUntil    : s.paidUntil,
        createdAt    : s.createdAt,
        // WhatsApp number info
        phoneNumber    : num?.phone_number    || null,
        phoneNumberId  : num?.phone_number_id || null,
        botActive      : num?.active          || false,
      };
    });
    res.json({ clients });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/clients/:businessId/activate — trial → active (30 days)
app.post("/api/admin/clients/:businessId/activate", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  try {
    const { businessId } = req.params;
    const now        = Date.now();
    const paidUntil  = now + 30 * 86400000;
    await db.query(
      `INSERT INTO subscriptions (business_id, status, plan, monthly_fee, trial_started, trial_ends,
         current_period_start, current_period_end, paid_until, created_at, updated_at, payment_history)
       VALUES ($1,'active','starter',3000,$2,$3,$4,$5,$6,$7,$8,'[]')
       ON CONFLICT (business_id) DO UPDATE
         SET status='active', paid_until=$6, updated_at=$8`,
      [businessId, now, now + 14*86400000, now, paidUntil, paidUntil, now, now]
    );
    const sub = await subscriptions.get(businessId);
    res.json({ ok: true, subscription: sub });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/clients/:businessId/extend — add 30 days
app.post("/api/admin/clients/:businessId/extend", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  try {
    const { businessId } = req.params;
    const sub       = await subscriptions.getOrCreate(businessId);
    const now       = Date.now();
    const base      = Math.max(sub.paidUntil || 0, now);
    const newExpiry = base + 30 * 86400000;
    await db.query(
      `UPDATE subscriptions SET status='active', paid_until=$1, updated_at=$2 WHERE business_id=$3`,
      [newExpiry, now, businessId]
    );
    const updated = await subscriptions.get(businessId);
    res.json({ ok: true, subscription: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/clients/:businessId/expire — cut off access
app.post("/api/admin/clients/:businessId/expire", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  try {
    await subscriptions.expire(req.params.businessId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: WhatsApp Number Management ────────────────────────────────────────
// GET /api/admin/numbers — list all registered numbers
app.get("/api/admin/numbers", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  try {
    const numbers = await waNumbers.getAll();
    res.json({ numbers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/numbers/register — link phone_number_id → business_id
// Body: { businessId, phoneNumberId, phoneNumber, token }
app.post("/api/admin/numbers/register", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  try {
    const { businessId, phoneNumberId, phoneNumber = "", token = "" } = req.body;
    if (!businessId || !phoneNumberId) return res.status(400).json({ error: "businessId and phoneNumberId required" });
    await waNumbers.register(businessId, phoneNumberId, phoneNumber, token);
    res.json({ ok: true, businessId, phoneNumberId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/numbers/:phoneNumberId — deactivate a number
app.delete("/api/admin/numbers/:phoneNumberId", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  try {
    await waNumbers.deactivate(req.params.phoneNumberId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Billing & Subscription APIs ───────────────────────────────────────────────
// bid helper — reads from header (X-Business-ID), query param (bid), or falls back to default
function getBid(req) {
  return req.headers["x-business-id"] || req.query.bid || req.query.businessId || DEFAULT_BUSINESS_ID;
}

app.get("/api/billing/summary", async (req, res) => {
  const bid     = getBid(req);
  const sub     = await subscriptions.get(bid);
  const billing = await commissionEngine.getMonthlySummary(bid, sub.monthlyFee);
  const [days, active] = await Promise.all([subscriptions.daysRemaining(bid), subscriptions.isActive(bid)]);
  res.json({ subscription: { status: sub.status, plan: sub.plan, monthlyFee: sub.monthlyFee, daysRemaining: days, isActive: active }, billing });
});
app.get("/api/billing/commissions", async (req, res) => {
  const bid = getBid(req);
  res.json({ commissions: await commissionEngine.getAll({ businessId: bid, month: req.query.month }) });
});
app.get("/api/billing/subscription", async (req, res) => {
  const bid  = getBid(req);
  const sub  = await subscriptions.get(bid);
  const [active, days] = await Promise.all([subscriptions.isActive(bid), subscriptions.daysRemaining(bid)]);
  res.json({ ...sub, isActive: active, daysRemaining: days });
});
app.post("/api/billing/payment", async (req, res) => {
  const bid = getBid(req);
  const { amount, paymentId, method } = req.body;
  res.json({ ok: true, subscription: await subscriptions.recordPayment(bid, { amount, paymentId, method }) });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST CHAT (no WhatsApp needed — used by test-chat.html)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/test/chat", async (req, res) => {
  const { subscriber_id, text, first_name = "TestUser" } = req.body;
  if (!subscriber_id) return res.status(400).json({ error: "subscriber_id required" });

  const replies = [];
  wa._testMode    = true;
  wa._testReplies = replies;

  try {
    await customers.touch(subscriber_id, { name: first_name, first_name });
    let sess = session.get(subscriber_id) || session.create(subscriber_id, { name: first_name, first_name });

    if (!sess.lang) {
      const detected = language.detectLanguage(text);
      session.update(subscriber_id, { lang: detected });
      sess = session.get(subscriber_id);
    }

    if (text) await routeMessage(subscriber_id, sess, text.trim(), first_name);

    const updatedSess = session.get(subscriber_id);
    res.json({
      replies,
      cart        : updatedSess?.cart || [],
      sessionState: updatedSess?.state,
      lang        : updatedSess?.lang,
      loyalty     : await loyalty.getRedeemInfo(subscriber_id),
    });
  } catch (err) {
    res.json({ replies: ["⚠️ Error: " + err.message], cart: [] });
  } finally {
    wa._testMode    = false;
    wa._testReplies = null;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND JOBS
// ─────────────────────────────────────────────────────────────────────────────

// Abandoned cart recovery (every 1 hour)
const CART_TIMEOUT_MS   = 2 * 60 * 60 * 1000;
const RECOVERY_INTERVAL = 60 * 60 * 1000;

async function runAbandonedCartRecovery() {
  const now = Date.now(); let sent = 0;
  for (const sess of session.all()) {
    if (!sess.cart?.length || sess.state === "awaiting_payment" || sess.abandonedNudgeSent) continue;
    if (now - (sess.updatedAt || 0) < CART_TIMEOUT_MS) continue;
    const lang  = sess.lang || "english";
    const names = sess.cart.map(i => i.name).join(", ");
    const total = sess.cart.reduce((s, i) => s + (i.price || 0), 0);
    const msgs  = {
      hindi   : `${sess.name || "जी"}! 👋 आपने cart में कुछ छोड़ा था 🛒\n\n*${names}*\nTotal: ₹${total}\n\n"done" reply करें checkout के लिए! 🎁`,
      hinglish: `Hey ${sess.name || "yaar"}! 👋 Cart mein kuch chhod aaye ho 🛒\n\n*${names}*\nTotal: ₹${total}\n\n"done" reply karo checkout ke liye! 🎁`,
      english : `Hey ${sess.name || "there"}! 👋 You left something behind 🛒\n\n*${names}*\nTotal: ₹${total}\n\nReply "done" to complete your order! 🎁`,
    };
    try {
      await wa.send(sess.customerId, msgs[lang] || msgs.english);
      session.update(sess.customerId, { abandonedNudgeSent: true, promoSource: "abandoned_cart", promoSentAt: Date.now() });
      sent++;
    } catch {}
  }
  if (sent) console.log(`[abandoned-cart] Recovered ${sent} carts`);
  return sent;
}
setInterval(runAbandonedCartRecovery, RECOVERY_INTERVAL);

// Auto-broadcast festival campaigns (check every 6 hours)
async function checkFestivalBroadcasts() {
  const alerts = festivals.getAlertsForToday();
  for (const f of alerts) {
    if (!await festivals.wasAlreadyBroadcast(f.name)) {
      console.log(`[festival] Auto-alert: ${f.name} is coming up — use /api/promote/festival to broadcast.`);
      // We log but don't auto-send — business owner should confirm
    }
  }
}
setInterval(() => checkFestivalBroadcasts().catch(e => console.error("[festivals] check failed:", e.message)), 6 * 60 * 60 * 1000);

// Review request (24h after delivery)
function scheduleReviewRequest(customerId, orderId, customerName) {
  setTimeout(async () => {
    try {
      const order = await orders.get(orderId);
      if (!order || order.status !== "delivered") return;
      const lang = session.get(customerId)?.lang || "english";
      const msgs = {
        hindi   : `नमस्ते ${customerName}! 😊\nOrder #SL${orderId} कैसा लगा?\n\n⭐1 Poor · ⭐⭐⭐3 Good · ⭐⭐⭐⭐⭐5 Excellent\n\nFeedback दें! 🙏`,
        hinglish: `Hey ${customerName}! 😊\nOrder #SL${orderId} kaisa laga?\n\n⭐1 Poor · ⭐⭐⭐3 Good · ⭐⭐⭐⭐⭐5 Excellent\n\nFeedback do! 🙏`,
        english : `Hi ${customerName}! 😊\nHow was your order #SL${orderId}?\n\n⭐1 Poor · ⭐⭐⭐3 Good · ⭐⭐⭐⭐⭐5 Excellent\n\nYour feedback helps us improve 🙏`,
      };
      await wa.send(customerId, msgs[lang] || msgs.english);
    } catch {}
  }, 24 * 60 * 60 * 1000);
}

// Seller catalog builder webhook (legacy — kept working)
const sellerSessions = new Map();
app.post("/webhook/seller", async (req, res) => {
  res.sendStatus(200);
  const { subscriber_id, text, attachments } = req.body;
  if (!subscriber_id) return;
  const businessId = String(subscriber_id);
  const message    = (text || "").trim();
  const msgLower   = message.toLowerCase();
  let   sess       = sellerSessions.get(businessId) || { step: "idle" };

  if (instafetch.isInstaUrl(message)) {
    await wa.send(businessId, "⏳ Fetching post...");
    try {
      const postData = await instafetch.fetchPostData(message);
      sess = { step: "ask_price", pendingProduct: { instaPostUrl: message, imageUrl: postData.imageUrl||"", description: postData.caption||"", name: instafetch.guessName(postData.caption), category: instafetch.guessCategory(postData.caption), colors: instafetch.guessColors(postData.caption) } };
      sellerSessions.set(businessId, sess);
      return wa.send(businessId, `✅ Got your post!\n\n💰 What's the price?\n_(e.g. 799 or "contact")_`);
    } catch {
      sess = { step: "ask_price", pendingProduct: { instaPostUrl: message, imageUrl:"", description:"", name:"", category:"general", colors:[] } };
      sellerSessions.set(businessId, sess);
      return wa.send(businessId, `✅ Got your post link!\n\n💰 What's the price?`);
    }
  }

  switch (sess.step) {
    case "ask_price": {
      const isContact = msgLower === "contact" || msgLower === "0";
      const priceVal  = isContact ? 0 : parseFloat(message.replace(/[^0-9.]/g,""));
      if (!isContact && (isNaN(priceVal)||priceVal<0)) return wa.send(businessId, `Enter a valid price (e.g. "799") or "contact"`);
      sess.pendingProduct.price = isContact ? 0 : priceVal;
      sess.pendingProduct.contactForPrice = isContact;
      sess.step = sess.pendingProduct.name ? "ask_sizes" : "ask_name";
      sellerSessions.set(businessId, sess);
      return wa.send(businessId, sess.step === "ask_sizes"
        ? `💰 ₹${priceVal} set!\n\n📏 Sizes? (e.g. S,M,L or "no")`
        : `💰 Set!\n\n📝 Product name?`);
    }
    case "ask_name": {
      sess.pendingProduct.name = message;
      sess.step = "ask_sizes";
      sellerSessions.set(businessId, sess);
      return wa.send(businessId, `📏 Sizes? (e.g. S,M,L or "no")`);
    }
    case "ask_sizes": {
      sess.pendingProduct.sizes = msgLower === "no" ? [] : message.split(/[,;]/).map(s=>s.trim().toUpperCase()).filter(Boolean);
      if (sess.pendingProduct.colors?.length) { return saveProduct(businessId, sess); }
      sess.step = "ask_colors";
      sellerSessions.set(businessId, sess);
      return wa.send(businessId, `🎨 Colors? (e.g. Red,Blue or "no")`);
    }
    case "ask_colors": {
      sess.pendingProduct.colors = msgLower === "no" ? [] : message.split(/[,;]/).map(c=>c.trim()).filter(Boolean);
      return saveProduct(businessId, sess);
    }
    default:
      sellerSessions.set(businessId, { step: "idle" });
      return wa.send(businessId, `👋 Send an Instagram post link or photo to add products. Type "list" to see catalog.`);
  }
});

async function saveProduct(businessId, sess) {
  const product = await catalog.addProduct(sess.pendingProduct);
  sellerSessions.set(businessId, { step: "idle" });
  await wa.send(businessId,
    `✅ *Product Added!*\n━━━━━━━━━━━━━━━━\n` +
    `📦 *${product.name||"Unnamed"}*\n` +
    `💰 ${product.price>0?`₹${product.price}`:"Contact"}\n` +
    `📏 ${product.sizes?.length?product.sizes.join(", "):"One size"}\n` +
    `🎨 ${product.colors?.length?product.colors.join(", "):"—"}\n` +
    `━━━━━━━━━━━━━━━━\nSend another link or photo to add more! 📸`
  );
}

// ── Global error guards — prevent crashes from unhandled rejections ───────────
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message, err.stack);
  // Don't exit — keep server running
});
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
  // Don't exit — keep server running
});
process.on("SIGTERM", () => {
  console.log("[Selly Bot] SIGTERM received — shutting down gracefully");
  process.exit(0);
});

// ── Start server ──────────────────────────────────────────────────────────────
// Start server immediately — don't wait for DB setup to bind the port
// This ensures Railway health checks pass and the process stays alive
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Selly Bot] Running on port ${PORT} 🚀`);
  console.log(`[Selly Bot] Features: multi-language · status-reply · loyalty · bargaining · festivals · COD+Razorpay`);
});

// DB setup with auto-retry — if DB is slow to start, retry every 5s
async function setupWithRetry(attempts = 0) {
  try {
    await setup();
    console.log("[Selly Bot] DB ready ✓");
    checkFestivalBroadcasts().catch(e => console.error("[festivals] startup check failed:", e.message));
  } catch (err) {
    console.error(`[Selly Bot] DB setup failed (attempt ${attempts + 1}):`, err.message);
    if (attempts < 5) {
      console.log(`[Selly Bot] Retrying DB setup in 5s...`);
      setTimeout(() => setupWithRetry(attempts + 1), 5000);
    } else {
      console.error("[Selly Bot] DB setup gave up after 5 attempts — server running without DB");
    }
  }
}
setupWithRetry();

module.exports = app;
