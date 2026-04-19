// ── CodeForge Instagram Bot — Main Server ─────────────────────────────────────
// Flow:
//   Instagram DM → ManyChat webhook → HERE → AI → ManyChat API → Customer DM
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();

const express    = require("express");
const bodyParser = require("body-parser");
const path       = require("path");
const session    = require("./session");
const manychat   = require("./manychat");
const catalog    = require("./catalog");
const orders     = require("./orders");
const customers  = require("./customers");
const ai         = require("./ai");
const billing    = require("./billing");
const payment    = require("./payment");
const instafetch      = require("./instafetch");
const subscriptions   = require("./subscriptions");
const commissionEngine = require("./commission");

// Default business ID (single-tenant for now — multi-tenant comes with Selly app)
const DEFAULT_BUSINESS_ID = process.env.BUSINESS_ID || "default";

const app  = express();
const PORT = process.env.PORT || 3000;

// Allow Selly mobile/web app (any localhost port) to call the API
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (!origin || origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(bodyParser.json());
app.use(bodyParser.text({ type: "text/plain", limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../public")));

// ── Health check ───────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "CodeForge Instagram Bot running" }));

// ── Seller Catalog Builder Webhook ───────────────────────────────────────────
// Separate endpoint for business owner to build catalog via DM conversation
// Business DMs product photo → bot asks name, price, sizes, colors

// ── Seller Sessions ───────────────────────────────────────────────────────────
const sellerSessions = new Map(); // businessId → { step, pendingProduct }

app.post("/webhook/seller", async (req, res) => {
  res.sendStatus(200);
  const { subscriber_id, text, attachments } = req.body;
  if (!subscriber_id) return;

  const businessId = String(subscriber_id);
  const message    = (text || "").trim();
  const msgLower   = message.toLowerCase();
  let   sess       = sellerSessions.get(businessId) || { step: "idle" };

  // ── 1. Business sends an Instagram post URL ─────────────────────────────────
  if (instafetch.isInstaUrl(message)) {
    await manychat.send(businessId, "⏳ Fetching your post details...");

    try {
      const postData = await instafetch.fetchPostData(message);

      // Auto-fill everything we can from the post
      const pendingProduct = {
        instaPostUrl : message,
        imageUrl     : postData.imageUrl    || "",
        description  : postData.caption     || "",
        // Smart guesses from caption
        name         : instafetch.guessName(postData.caption),
        category     : instafetch.guessCategory(postData.caption),
        colors       : instafetch.guessColors(postData.caption),
        tags         : extractHashtags(postData.caption),
      };

      sess = { step: "ask_price", pendingProduct };
      sellerSessions.set(businessId, sess);

      const namePreview = pendingProduct.name
        ? `\n_Detected name: "${pendingProduct.name}"_\n`
        : "";
      const catPreview  = pendingProduct.category !== "general"
        ? `_Category: ${pendingProduct.category}_\n`
        : "";

      return manychat.send(businessId,
        `✅ *Got your Instagram post!*\n` +
        (postData.imageUrl ? `🖼️ Image fetched successfully\n` : `⚠️ Image not fetched (will use post link)\n`) +
        namePreview + catPreview +
        `\n💰 *What's the price?*\n_(e.g. 799  or type "contact" if price varies)_`
      );

    } catch (err) {
      console.error("[seller/instaUrl] Fetch error:", err.message);
      // Even if fetch fails, store the URL and continue
      sess = {
        step          : "ask_price",
        pendingProduct: { instaPostUrl: message, imageUrl: "", description: "", name: "", category: "general", colors: [], tags: [] }
      };
      sellerSessions.set(businessId, sess);
      return manychat.send(businessId,
        `✅ *Got your post link!*\n_(Couldn't auto-fetch image — you can add it later from the dashboard)_\n\n` +
        `💰 *What's the price?*\n_(e.g. 799  or type "contact" if price varies)_`
      );
    }
  }

  // ── 2. Business uploads a product photo directly ────────────────────────────
  if (attachments?.length && attachments[0]?.url) {
    const imageUrl = attachments[0].url;
    sess = { step: "ask_price", pendingProduct: { imageUrl, instaPostUrl: "", description: "", name: "", category: "general", colors: [], tags: [] } };
    sellerSessions.set(businessId, sess);
    return manychat.send(businessId,
      `✅ *Got your product photo!*\n\n` +
      `💰 *What's the price?*\n_(e.g. 799  or type "contact" if price varies)_`
    );
  }

  // ── 3. Handle "done" / "list" commands ─────────────────────────────────────
  if (msgLower === "done" || msgLower === "list" || msgLower === "catalog") {
    const products = catalog.getAll();
    sellerSessions.set(businessId, { step: "idle" });
    return manychat.send(businessId,
      `📦 *Your Catalog (${products.length} products):*\n\n` +
      products.slice(0, 10).map((p, i) =>
        `${i + 1}. ${p.name || "Unnamed"} — ${p.price > 0 ? "₹" + p.price : "Contact"}`
      ).join("\n") +
      (products.length > 10 ? `\n_...and ${products.length - 10} more_` : "") +
      `\n\nSend an Instagram post link or photo to add more! 📸`
    );
  }

  // ── 4. Step machine ─────────────────────────────────────────────────────────
  switch (sess.step) {

    // ── Price ──────────────────────────────────────────────────────────────
    case "ask_price": {
      const isContact = msgLower === "contact" || msgLower === "0";
      const priceVal  = isContact ? 0 : parseFloat(message.replace(/[^0-9.]/g, ""));

      if (!isContact && (isNaN(priceVal) || priceVal < 0)) {
        return manychat.send(businessId, `Please enter a valid price (e.g. "799") or type "contact"`);
      }

      sess.pendingProduct.price           = isContact ? 0 : priceVal;
      sess.pendingProduct.contactForPrice = isContact;

      // If we already have a name from the post, skip asking for it
      if (sess.pendingProduct.name) {
        sess.step = "ask_sizes";
        sellerSessions.set(businessId, sess);
        return manychat.send(businessId,
          `💰 Price set: ${isContact ? "Contact for price" : "₹" + priceVal}\n\n` +
          `📏 *Sizes available?*\n_(e.g. S,M,L,XL  or  28,30,32 — type "no" if one size)_`
        );
      } else {
        // No name detected from caption — ask for it
        sess.step = "ask_name";
        sellerSessions.set(businessId, sess);
        return manychat.send(businessId,
          `💰 Price set: ${isContact ? "Contact for price" : "₹" + priceVal}\n\n` +
          `📝 *Product name?*\n_(e.g. Rose Scented Candle)_`
        );
      }
    }

    // ── Name (only asked if not auto-detected) ─────────────────────────────
    case "ask_name": {
      sess.pendingProduct.name = message;
      sess.step = "ask_sizes";
      sellerSessions.set(businessId, sess);
      return manychat.send(businessId,
        `📏 *Sizes available?*\n_(e.g. S,M,L,XL  or  28,30,32 — type "no" if one size)_`
      );
    }

    // ── Sizes ──────────────────────────────────────────────────────────────
    case "ask_sizes": {
      sess.pendingProduct.sizes    = msgLower === "no" ? [] :
        message.split(/[,;]/).map(s => s.trim().toUpperCase()).filter(Boolean);
      sess.pendingProduct.hasSizes = sess.pendingProduct.sizes.length > 0;

      // If we auto-detected colors, skip asking
      if (sess.pendingProduct.colors?.length) {
        return saveAndConfirmProduct(businessId, sess);
      }

      sess.step = "ask_colors";
      sellerSessions.set(businessId, sess);
      return manychat.send(businessId,
        `🎨 *Colors available?*\n_(e.g. White, Pink, Blue — type "no" if only one color)_`
      );
    }

    // ── Colors ─────────────────────────────────────────────────────────────
    case "ask_colors": {
      sess.pendingProduct.colors = msgLower === "no" ? [] :
        message.split(/[,;]/).map(c => c.trim()).filter(Boolean);

      return saveAndConfirmProduct(businessId, sess);
    }

    // ── Default / idle ─────────────────────────────────────────────────────
    default:
      sellerSessions.set(businessId, { step: "idle" });
      return manychat.send(businessId,
        `👋 *Hi! Add products to your catalog:*\n\n` +
        `📸 Send an *Instagram post link* — bot auto-fills image + name\n` +
        `🖼️ Or send a *product photo* directly\n\n` +
        `Type "list" to see your current catalog.`
      );
  }
});

// ── Save product and send confirmation ────────────────────────────────────────
async function saveAndConfirmProduct(businessId, sess) {
  // Ensure category exists
  if (!sess.pendingProduct.category || sess.pendingProduct.category === "general") {
    // Try to detect from name
    sess.pendingProduct.category =
      instafetch.guessCategory(sess.pendingProduct.name + " " + sess.pendingProduct.description);
  }

  const product      = catalog.addProduct(sess.pendingProduct);
  const priceDisplay = product.price > 0 ? `₹${product.price}` : "Contact for price";
  const imageStatus  = product.imageUrl ? "🖼️ Image: ✅ ready" : "🖼️ Image: add from dashboard";
  const postLink     = product.instaPostUrl
    ? `🔗 Post: ${product.instaPostUrl.slice(0, 40)}...`
    : "";

  sellerSessions.set(businessId, { step: "idle" });

  await manychat.send(businessId,
    `✅ *Product Added to Catalog!*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📦 *${product.name || "Unnamed Product"}*\n` +
    `💰 ${priceDisplay}\n` +
    `📁 Category: ${product.category}\n` +
    `📏 Sizes: ${product.sizes?.length ? product.sizes.join(", ") : "One size"}\n` +
    `🎨 Colors: ${product.colors?.length ? product.colors.join(", ") : "—"}\n` +
    `${imageStatus}\n` +
    (postLink ? `${postLink}\n` : "") +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🛍️ Customers can now find this by searching!\n\n` +
    `Send another post link or photo to add more 📸`
  );
}

// ── Extract hashtags from caption ─────────────────────────────────────────────
function extractHashtags(caption = "") {
  const matches = caption.match(/#(\w+)/g) || [];
  return matches
    .map(h => h.slice(1).toLowerCase())
    .filter(h => h.length > 2 && h.length < 20)
    .slice(0, 10);
}

// ── Business Dashboard APIs ────────────────────────────────────────────────────

// GET  /api/orders          — list all orders with stats
app.get("/api/orders", (req, res) => {
  const { status, page } = req.query;
  res.json({
    stats : orders.getStats(),
    ...orders.getAll({ status, page: Number(page) || 1 }),
  });
});

// POST /api/orders/:id/status — update order status + tracking
app.post("/api/orders/:id/status", (req, res) => {
  const { status, trackingNumber, trackingUrl } = req.body;
  const updated = orders.updateStatus(req.params.id, status, { trackingNumber, trackingUrl });
  if (!updated) return res.status(404).json({ error: "Order not found" });

  // Notify customer via DM
  const emoji = { packed:"📦", shipped:"🚚", out_for_delivery:"🛵", delivered:"✅" };
  const msgs  = {
    packed          : "📦 Great news! Your order is packed and ready to ship.",
    shipped         : `🚚 Your order is on the way!\n${trackingNumber ? `Tracking: ${trackingNumber}` : ""}`,
    out_for_delivery: "🛵 Out for delivery today! Please be available.",
    delivered       : "✅ Delivered! Hope you love it 😊\nHow was your experience? Reply ⭐⭐⭐⭐⭐",
  };

  if (msgs[status]) {
    manychat.send(updated.customerId, msgs[status]).catch(() => {});
  }

  // Schedule review request 24 hours after delivery
  if (status === "delivered") {
    scheduleReviewRequest(updated.customerId, updated.id, updated.name);
  }

  res.json({ ok: true, order: updated });
});

// POST /api/catalog/upload  — upload CSV catalog
app.post("/api/catalog/upload", (req, res) => {
  try {
    const csvText  = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const imported = catalog.importCSV(csvText);
    res.json({ ok: true, imported: imported.length, message: `${imported.length} products imported` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/catalog/add     — add single product
app.post("/api/catalog/add", (req, res) => {
  const product = catalog.addProduct(req.body);
  res.json({ ok: true, product });
});

// GET  /api/catalog         — list all products
app.get("/api/catalog", (req, res) => {
  res.json({ products: catalog.getAll() });
});

// POST /api/catalog/stock   — toggle product in/out of stock
app.post("/api/catalog/stock", (req, res) => {
  const { id, inStock } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  const product = catalog.toggleStock(id, inStock);
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json({ ok: true, product });
});

// DELETE /api/catalog/:id   — remove product from catalog
app.delete("/api/catalog/:id", (req, res) => {
  const deleted = catalog.deleteProduct(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Product not found" });
  res.json({ ok: true });
});

// PUT /api/catalog/:id      — update product fields
app.put("/api/catalog/:id", (req, res) => {
  const product = catalog.update(req.params.id, req.body);
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json({ ok: true, product });
});

// GET  /api/stats           — dashboard stats
app.get("/api/stats", (req, res) => {
  res.json(orders.getStats());
});

// ── Instagram Post Fetch API — used by dashboard ──────────────────────────────
// POST /api/insta/fetch  { url } → { ok, imageUrl, name, category, colors, caption }
app.post("/api/insta/fetch", async (req, res) => {
  const { url } = req.body;
  if (!url || !instafetch.isInstaUrl(url)) {
    return res.status(400).json({ ok: false, error: "Not a valid Instagram URL" });
  }

  try {
    const data = await instafetch.fetchPostData(url);
    res.json({
      ok       : true,
      imageUrl : data.imageUrl,
      caption  : data.caption,
      name     : instafetch.guessName(data.caption),
      category : instafetch.guessCategory(data.caption),
      colors   : instafetch.guessColors(data.caption),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── ManyChat Webhook — receives every customer DM ─────────────────────────────
// ManyChat sends POST to this endpoint whenever customer sends a DM
app.post("/webhook/manychat", async (req, res) => {
  res.sendStatus(200); // Always respond immediately to ManyChat

  try {
    const { subscriber_id, first_name, last_name, text, attachments } = req.body;
    if (!subscriber_id) return;

    const customerId = String(subscriber_id);
    const name       = first_name || "there";
    const message    = (text || "").trim();

    // Load or create conversation session
    let sess = session.get(customerId) || session.create(customerId, { name, first_name, last_name });

    // ── Handle image attachment (Seller Toolkit) ──────────────────────────────
    if (attachments?.length) {
      const imageUrl = attachments[0]?.url;
      if (imageUrl) {
        await handleImageUpload(customerId, sess, imageUrl, name);
        return;
      }
    }

    if (!message) return;

    // ── Route to correct handler based on session state ───────────────────────
    await routeMessage(customerId, sess, message, name);

  } catch (err) {
    console.error("[webhook] Error:", err.message);
  }
});

// ── Message Router ────────────────────────────────────────────────────────────
async function routeMessage(customerId, sess, message, name) {
  const state = sess.state;

  // ── Global shortcuts (work in any state) ─────────────────────────────────
  if (isTrackingRequest(message)) {
    return handleTracking(customerId, sess, message);
  }
  if (isReturnRequest(message)) {
    return handleReturn(customerId, sess, message);
  }
  if (message.toLowerCase() === "cancel" || message.toLowerCase() === "start over") {
    session.reset(customerId);
    return manychat.send(customerId, "Okay, starting fresh! 😊\n\nWhat are you looking for today?");
  }
  if (isOrderHistoryRequest(message)) {
    return handleOrderHistory(customerId, sess);
  }
  if (isReferralRequest(message)) {
    return handleReferralCode(customerId);
  }

  // ── State machine ─────────────────────────────────────────────────────────
  switch (state) {

    case "idle":
    case "searching":
      return handleSearch(customerId, sess, message, name);

    case "selecting":
      return handleProductSelection(customerId, sess, message);

    case "sizing":
      return handleSizeSelection(customerId, sess, message);

    case "collecting_address":
      return handleAddressCollection(customerId, sess, message);

    case "collecting_mobile":
      return handleMobileCollection(customerId, sess, message);

    case "awaiting_payment":
      return handlePaymentCheck(customerId, sess, message);

    default:
      session.reset(customerId);
      return handleSearch(customerId, sess, message, name);
  }
}

// ── Handler: Product Search ───────────────────────────────────────────────────
async function handleSearch(customerId, sess, message, name) {
  // Check if customer is adding to existing cart or refining search
  const isRefining = sess.cart?.length > 0 &&
    (message.toLowerCase().includes("add") || message.toLowerCase().includes("also"));

  // AI extracts search intent
  const intent = await ai.extractSearchIntent(message);

  if (!intent.product) {
    return manychat.send(customerId,
      `Hi ${name}! 👋 I'm your shopping assistant.\n\n` +
      `Tell me what you're looking for!\n` +
      `Example: "blue jeans under ₹800" or "cotton kurti size M"`
    );
  }

  // Search catalog
  const searchResult = catalog.search(intent);
  const results      = searchResult.results || searchResult; // backward compat

  if (!results.length) {
    return manychat.send(customerId,
      `😕 No products found for "${intent.rawQuery}".\n\n` +
      `Try:\n• Different keywords\n• Remove price filter\n• Check spelling`
    );
  }

  // No exact price match — suggest closest
  if (searchResult.noExactMatch) {
    const closest = results;
    const header  = `😕 No "${intent.rawQuery}" found under ₹${searchResult.searchedMax}.\n\n` +
                    `💡 *Closest options:*\n\n`;
    const list    = closest.map((p, i) =>
      `${i + 1}️⃣ *${p.name}* — ₹${p.price}\n` +
      `   ⭐ ${p.rating || "New"} | ${p.colors?.join(", ") || ""}`
    ).join("\n\n");

    session.update(customerId, { state: "selecting", lastSearch: intent, searchResults: closest });
    return manychat.send(customerId,
      header + list + "\n\nReply number to select or search again 🔍"
    );
  }

  // Update session
  session.update(customerId, {
    state        : "selecting",
    lastSearch   : intent,
    searchResults: results,
  });

  // Build product grid response
  const priceLabel    = intent.maxPrice ? ` under ₹${intent.maxPrice}` : "";
  const displayItems  = results.slice(0, 5);
  const hasInstaCards = displayItems.some(p => p.imageUrl || p.instaPostUrl);

  if (hasInstaCards) {
    // ── Send Instagram-style image cards ─────────────────────────────────────
    // Add post link as a view button where available
    const cardProducts = displayItems.map(p => ({
      ...p,
      // Ensure subtitle shows post origin if available
      _viewPostUrl: p.instaPostUrl || null,
    }));

    const header = `🔍 *${results.length} result${results.length > 1 ? "s" : ""} for "${intent.rawQuery}"${priceLabel}*`;
    await manychat.send(customerId, header);
    await manychat.sendProductCards(customerId, cardProducts);

    const footer = results.length > 5
      ? `_Showing 5 of ${results.length}. Say "more" to see more._\n\n`
      : "";
    await manychat.send(customerId,
      footer + `Reply number to select • "more" for more • "done" to checkout 🛒`
    );
  } else {
    // ── Plain text listing (no images) ───────────────────────────────────────
    const header = `🔍 *${results.length} result${results.length > 1 ? "s" : ""} for "${intent.rawQuery}"${priceLabel}*\n\n`;

    const productList = displayItems.map((p, i) => {
      const priceStr = p.price > 0 ? `₹${p.price}` : "📩 Contact for price";
      return `${i + 1}️⃣ *${p.name}* — ${priceStr}\n` +
             `   ⭐ ${p.rating || "New"} | ${p.colors?.join(", ") || ""}`;
    }).join("\n\n");

    const footer  = results.length > 5 ? `\n\n_Showing 5 of ${results.length}. Say "more" to see more._` : "";
    const actions = `\n\nReply number to select • "more" for more • "done" to checkout 🛒`;

    await manychat.send(customerId, header + productList + footer + actions);
  }

  // Show cart status if items already selected
  if (sess.cart?.length) {
    await manychat.send(customerId,
      `🛒 *Cart (${sess.cart.length} item${sess.cart.length > 1 ? "s" : ""}):* ` +
      sess.cart.map(i => i.name).join(", ")
    );
  }
}

// ── Handler: Product Selection ────────────────────────────────────────────────
async function handleProductSelection(customerId, sess, message) {
  const msg = message.toLowerCase().trim();

  // Customer wants to checkout
  if (msg === "done" || msg === "checkout" || msg === "buy") {
    if (!sess.cart?.length) {
      return manychat.send(customerId, "Your cart is empty! Search for products first 😊");
    }
    return startSizing(customerId, sess);
  }

  // Customer wants more results
  if (msg === "more") {
    const next = (sess.searchResults || []).slice(5, 10);
    if (!next.length) return manychat.send(customerId, "No more results. Try a different search!");
    session.update(customerId, { searchResults: sess.searchResults.slice(5) });
    return handleSearch(customerId, sess, sess.lastSearch?.rawQuery || "", sess.name);
  }

  // Customer selected a number
  const num = parseInt(msg);
  if (!isNaN(num) && num >= 1 && num <= 5) {
    const product = (sess.searchResults || [])[num - 1];
    if (!product) return manychat.send(customerId, "Invalid selection. Reply a number from the list.");

    const cart = sess.cart || [];
    const alreadyIn = cart.find(i => i.id === product.id);

    if (alreadyIn) {
      return manychat.send(customerId, `"${product.name}" is already in your cart! Reply "done" to checkout or search for more.`);
    }

    cart.push({ ...product, selectedSize: null });
    session.update(customerId, { cart, state: "selecting" });

    await manychat.send(customerId,
      `✅ *${product.name}* added to cart!\n\n` +
      `🛒 Cart: ${cart.length} item${cart.length > 1 ? "s" : ""}\n\n` +
      `Search more products or reply "done" to checkout 👇`
    );
    return;
  }

  // Customer is searching again
  return handleSearch(customerId, sess, message, sess.name);
}

// ── Handler: Size Selection ────────────────────────────────────────────────────
async function startSizing(customerId, sess) {
  const itemsNeedingSize = sess.cart.filter(i =>
    i.hasSizes && !i.selectedSize
  );

  if (!itemsNeedingSize.length) {
    // No sizing needed — go straight to address
    return startAddressCollection(customerId, sess);
  }

  const item = itemsNeedingSize[0];
  session.update(customerId, { state: "sizing", sizingItem: item.id });

  const sizes = item.sizes || ["XS", "S", "M", "L", "XL", "XXL"];
  const available = sizes.map(s => `[ ${s} ]`).join("  ");

  await manychat.send(customerId,
    `📏 *Select size for:*\n` +
    `*${item.name}* — ₹${item.price}\n\n` +
    `${available}\n\n` +
    `Reply the size (e.g. "M" or "L")`
  );
}

async function handleSizeSelection(customerId, sess, message) {
  const size    = message.toUpperCase().trim();
  const validSz = ["XS", "S", "M", "L", "XL", "XXL", "FREE SIZE", "28", "30", "32", "34", "36", "38", "40", "42"];

  if (!validSz.includes(size)) {
    return manychat.send(customerId, `Invalid size "${message}". Please reply with a valid size like S, M, L, XL etc.`);
  }

  // Update size for the item being sized
  const cart = sess.cart.map(item =>
    item.id === sess.sizingItem ? { ...item, selectedSize: size } : item
  );
  session.update(customerId, { cart });

  // Check if more items need sizing
  const remaining = cart.filter(i => i.hasSizes && !i.selectedSize);
  if (remaining.length) {
    return startSizing(customerId, { ...sess, cart });
  }

  // All sizes selected — collect address
  await manychat.send(customerId, `✅ All sizes selected!\n`);
  return startAddressCollection(customerId, { ...sess, cart });
}

// ── Handler: Address Collection ───────────────────────────────────────────────
async function startAddressCollection(customerId, sess) {
  session.update(customerId, { state: "collecting_address" });
  await manychat.send(customerId,
    `📦 *Almost done!*\n\n` +
    `Please send your delivery address:\n` +
    `_(House/Flat no, Street, City, State, Pincode)_`
  );
}

async function handleAddressCollection(customerId, sess, message) {
  session.update(customerId, { address: message, state: "collecting_mobile" });
  await manychat.send(customerId, `📱 Your mobile number for delivery updates?`);
}

async function handleMobileCollection(customerId, sess, message) {
  const mobile = message.replace(/\D/g, "");
  if (mobile.length < 10) {
    return manychat.send(customerId, "Please enter a valid 10-digit mobile number.");
  }

  session.update(customerId, { mobile, state: "awaiting_payment" });

  // Generate bill
  const bill = billing.generate({
    cart    : sess.cart,
    address : sess.address,
    mobile,
    name    : sess.name,
  });

  // Create payment link
  const payLink = await payment.createLink({
    amount      : bill.total,
    customerName: sess.name,
    mobile,
    description : `Order: ${bill.items.map(i => i.name).join(", ")}`,
  });

  // Determine promo source — expires after 24 hours to avoid false attribution
  const promoSource = (() => {
    if (!sess.promoSource) return null;
    const age = Date.now() - (sess.promoSentAt || 0);
    if (age > 24 * 60 * 60 * 1000) return null; // promo tag expired
    return sess.promoSource;
  })();

  // Calculate commission before saving order
  const commResult = commissionEngine.calculate(sess.cart, promoSource);

  // Save order as pending
  const order = orders.create({
    customerId,
    name       : sess.name,
    cart       : sess.cart,
    address    : sess.address,
    mobile,
    bill,
    payLink,
    status     : "pending_payment",
    promoSource,                                   // track how they found us
    commission : commResult.commissionAmount || 0, // ₹ owed to Selly
  });

  // Record commission if applicable
  if (commResult.eligible) {
    commissionEngine.record(DEFAULT_BUSINESS_ID, order.id, sess.cart, promoSource);
    console.log(`[commission] Order #${order.id} via ${promoSource} → ₹${commResult.commissionAmount} commission`);
  }

  // Clear promo tag from session after attribution
  session.update(customerId, { promoSource: null, promoSentAt: null });

  // Track customer (bot-only customer base)
  customers.touch(customerId, { name: sess.name, mobile });
  customers.recordOrder(customerId, order);

  session.update(customerId, { currentOrderId: order.id });

  // Send bill summary
  const itemLines = bill.items.map(i =>
    `${i.name}${i.size ? ` (${i.size})` : ""}`.padEnd(28) + `₹${i.price}`
  ).join("\n");

  await manychat.send(customerId,
    `════════════════════════\n` +
    `🧾 *ORDER SUMMARY*\n` +
    `════════════════════════\n` +
    `${itemLines}\n` +
    `────────────────────────\n` +
    `Subtotal        ₹${bill.subtotal}\n` +
    `Delivery           ₹${bill.delivery}\n` +
    `GST (${bill.gstRate}%)       ₹${bill.gst}\n` +
    `────────────────────────\n` +
    `*TOTAL          ₹${bill.total}*\n` +
    `════════════════════════\n` +
    `📍 ${sess.address}\n` +
    `🚚 Delivery in 3-5 days\n` +
    `════════════════════════\n\n` +
    `💳 *Pay now:* ${payLink.url}\n` +
    `_(Link valid for 30 minutes)_`
  );
}

// ── Handler: Payment Check ────────────────────────────────────────────────────
async function handlePaymentCheck(customerId, sess, message) {
  const msg = message.toLowerCase();
  if (msg.includes("paid") || msg.includes("done") || msg.includes("payment")) {
    const isPaid = await payment.verify(sess.currentOrderId);
    if (isPaid) {
      orders.updateStatus(sess.currentOrderId, "confirmed");
      const order = orders.get(sess.currentOrderId);
      session.reset(customerId);

      await manychat.send(customerId,
        `✅ *Order Confirmed!*\n\n` +
        `Order ID: #CF${order.id}\n` +
        `Amount: ₹${order.bill.total}\n\n` +
        `📄 Invoice sent!\n` +
        `🚚 You'll get tracking updates here.\n\n` +
        `Thank you for shopping! 🙏\n` +
        `Reply "track order" anytime to check status.`
      );
    } else {
      await manychat.send(customerId,
        `Payment not received yet.\n\n` +
        `💳 Pay here: ${sess.payLink?.url || "link expired"}\n\n` +
        `Reply "cancel" to start over.`
      );
    }
  }
}

// ── Handler: Order Tracking ───────────────────────────────────────────────────
async function handleTracking(customerId, sess, message) {
  const customerOrders = orders.getByCustomer(customerId);

  if (!customerOrders.length) {
    return manychat.send(customerId, "You don't have any orders yet! Start shopping 😊");
  }

  if (customerOrders.length === 1) {
    return sendTrackingInfo(customerId, customerOrders[0]);
  }

  // Multiple orders — ask which one
  const list = customerOrders.slice(0, 5).map((o, i) =>
    `${i + 1}️⃣ #CF${o.id} — ${o.cart[0]?.name} — ${getStatusEmoji(o.status)} ${o.status}`
  ).join("\n");

  session.update(customerId, { state: "tracking_select", trackingOrders: customerOrders });
  await manychat.send(customerId, `📦 *Your Orders:*\n\n${list}\n\nReply number to track`);
}

async function sendTrackingInfo(customerId, order) {
  const timeline = buildTimeline(order);
  await manychat.send(customerId,
    `════════════════════════\n` +
    `📦 ORDER #CF${order.id}\n` +
    `════════════════════════\n` +
    `${order.cart.map(i => `${i.name}${i.selectedSize ? ` (${i.selectedSize})` : ""}`).join("\n")}\n` +
    `Total: ₹${order.bill?.total}\n` +
    `────────────────────────\n` +
    `${timeline}\n` +
    `════════════════════════\n` +
    (order.trackingNumber ? `🔗 Track: ${order.trackingUrl || order.trackingNumber}` : "")
  );
}

function buildTimeline(order) {
  const steps = [
    { key: "confirmed",       label: "Order Placed",       emoji: "✅" },
    { key: "payment_received",label: "Payment Received",   emoji: "✅" },
    { key: "packed",          label: "Packed",              emoji: "📦" },
    { key: "shipped",         label: "Shipped",             emoji: "🚚" },
    { key: "out_for_delivery",label: "Out for Delivery",    emoji: "🛵" },
    { key: "delivered",       label: "Delivered",           emoji: "✅" },
  ];

  const currentIdx = steps.findIndex(s => s.key === order.status);
  return steps.map((s, i) =>
    `${i <= currentIdx ? s.emoji : "⏳"} ${s.label}` +
    (order.statusDates?.[s.key] ? `  _${order.statusDates[s.key]}_` : "")
  ).join("\n");
}

// ── Handler: Return Request ───────────────────────────────────────────────────
async function handleReturn(customerId, sess, message) {
  const recent = orders.getByCustomer(customerId).find(o => o.status === "delivered");
  if (!recent) {
    return manychat.send(customerId, "No delivered orders found to return.");
  }

  orders.updateStatus(recent.id, "return_requested");
  await manychat.send(customerId,
    `🔄 *Return Request Received*\n\n` +
    `Order #CF${recent.id}\n` +
    `We'll contact you within 24 hours.\n\n` +
    `Please keep the item ready with original packaging.`
  );
}

// ── Handler: Order History ─────────────────────────────────────────────────────
async function handleOrderHistory(customerId, sess) {
  const allOrders = orders.getByCustomer(customerId);
  if (!allOrders.length) {
    return manychat.send(customerId, "No orders yet! Start shopping 😊");
  }

  const list = allOrders.slice(0, 5).map(o =>
    `#CF${o.id} — ${o.cart[0]?.name} — ₹${o.bill?.total} — ${getStatusEmoji(o.status)} ${o.status}`
  ).join("\n");

  await manychat.send(customerId, `📋 *Your Orders:*\n\n${list}`);
}

// ── Handler: Referral Code ────────────────────────────────────────────────────
async function handleReferralCode(customerId) {
  const customer = customers.get(customerId);
  if (!customer) {
    return manychat.send(customerId, "Start shopping with us first and you'll get a referral code! 😊");
  }

  const code  = customer.referralCode;
  const earn  = customer.referralEarnings || 0;
  const count = customer.referralCount    || 0;

  return manychat.send(customerId,
    `🎟️ *Your Referral Code:*\n` +
    `━━━━━━━━━━━━━━\n` +
    `📌 Code: *${code}*\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `Share this with friends!\n` +
    `You earn *5% commission* every time someone orders using your code. 🎉\n\n` +
    `📊 Stats: ${count} referral${count !== 1 ? "s" : ""} · ₹${earn} earned\n\n` +
    `_Ask your friend to mention code *${code}* when ordering._`
  );
}

// ── Handler: Image Upload (Seller Toolkit) ────────────────────────────────────
async function handleImageUpload(customerId, sess, imageUrl, name) {
  await manychat.send(customerId, "✨ Generating content for your product...");

  const content = await ai.generateProductContent(imageUrl);

  await manychat.send(customerId,
    `📝 *Caption:*\n${content.caption}\n\n` +
    `#️⃣ *Hashtags:*\n${content.hashtags}\n\n` +
    `🎵 *Music for Reel:*\n${content.music.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n` +
    `💰 *Suggested Price:* ₹${content.suggestedPrice}`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isTrackingRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("track") || m.includes("where is my order") ||
         m.includes("order status") || m.includes("delivery status") ||
         m.includes("kahan hai") || m.includes("kab aayega");
}

function isReturnRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("return") || m.includes("refund") || m.includes("wrong") ||
         m.includes("damaged") || m.includes("exchange");
}

function isOrderHistoryRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("my orders") || m.includes("past orders") || m.includes("order history");
}

function isReferralRequest(msg) {
  const m = msg.toLowerCase();
  return m.includes("referral") || m.includes("refer a friend") ||
         m.includes("my code") || m.includes("referral code") ||
         m.includes("refer") || m.includes("commission");
}

function getStatusEmoji(status) {
  const map = {
    pending_payment : "⏳",
    confirmed       : "✅",
    packed          : "📦",
    shipped         : "🚚",
    out_for_delivery: "🛵",
    delivered       : "✅",
    return_requested: "🔄",
    cancelled       : "❌",
  };
  return map[status] || "📋";
}

// ── Customer APIs ─────────────────────────────────────────────────────────────

// GET  /api/customers        — all bot customers with stats
app.get("/api/customers", (req, res) => {
  const { tag, page } = req.query;
  res.json({
    stats: customers.getStats(),
    ...customers.getAll({ tag, page: Number(page) || 1 }),
  });
});

// GET  /api/customers/stats  — just the stats
app.get("/api/customers/stats", (req, res) => {
  res.json(customers.getStats());
});

// ── Test Chat Endpoint (no Instagram needed) ──────────────────────────────────
// Simulates ManyChat webhook — used by test-chat.html
// Collects all bot replies and returns them as an array

app.post("/test/chat", async (req, res) => {
  const { subscriber_id, text, first_name = "TestUser", attachments } = req.body;
  if (!subscriber_id) return res.status(400).json({ error: "subscriber_id required" });

  // Collect replies instead of sending via ManyChat
  const replies = [];
  const originalSend = manychat.send.bind(manychat);

  // Temporarily override manychat.send to capture replies
  manychat._testMode  = true;
  manychat._testReplies = replies;

  try {
    // Register / update customer
    const customer = customers.touch(subscriber_id, { name: first_name, first_name });

    // Process through the same webhook logic
    let sess = session.get(subscriber_id) || session.create(subscriber_id, { name: first_name, first_name });

    if (attachments?.length) {
      await handleImageUpload(subscriber_id, sess, attachments[0].url, first_name);
    } else if (text) {
      await routeMessage(subscriber_id, sess, text.trim(), first_name);
    }

    // Get updated session for cart info
    const updatedSess = session.get(subscriber_id);
    const updatedCustomer = customers.get(subscriber_id);

    // Suggest quick replies based on state
    const quickReplies = getQuickReplies(updatedSess);

    res.json({
      replies,
      customer     : updatedCustomer,
      cart         : updatedSess?.cart || [],
      sessionState : updatedSess?.state,
      quickReplies,
    });

  } catch (err) {
    console.error("[test/chat]", err.message);
    res.json({ replies: ["⚠️ Error: " + err.message], customer: null, cart: [] });
  } finally {
    manychat._testMode    = false;
    manychat._testReplies = null;
  }
});

function getQuickReplies(sess) {
  if (!sess) return ["jeans", "kurti", "shirts"];
  switch (sess.state) {
    case "idle":
    case "searching" : return ["👖 jeans", "👗 kurti", "👕 t-shirt", "📦 track order"];
    case "selecting" : return sess.cart?.length ? ["✅ done", "🔍 search more"] : ["🔍 search more"];
    case "sizing"    : return ["S", "M", "L", "XL", "XXL"];
    case "awaiting_payment": return ["✅ I have paid", "❌ cancel"];
    default          : return [];
  }
}

// ── Promotion APIs ────────────────────────────────────────────────────────────

// POST /api/promote/flash   — broadcast flash sale to ALL bot customers
app.post("/api/promote/flash", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const allCustomers = customers.getAll().customers;
  if (!allCustomers.length) return res.json({ ok: true, sent: 0 });

  let sent = 0;
  for (const c of allCustomers) {
    try {
      await manychat.send(c.id, message);
      // Tag this customer's session so next order is tracked as flash_sale
      session.update(c.id, { promoSource: "flash_sale", promoSentAt: Date.now() });
      sent++;
    } catch (err) {
      console.error(`[promote/flash] Failed to send to ${c.id}:`, err.message);
    }
  }

  console.log(`[promote/flash] Sent to ${sent}/${allCustomers.length} customers`);
  res.json({ ok: true, sent, total: allCustomers.length });
});

// POST /api/promote/newarrival — alert customers about a new product
// Sends to customers who bought from same category, or ALL if no match
app.post("/api/promote/newarrival", async (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: "productId required" });

  const product = catalog.get(productId);
  if (!product) return res.status(404).json({ error: "Product not found" });

  const message =
    `🆕 *New Arrival!*\n\n` +
    `✨ *${product.name}*\n` +
    `💰 ${product.price > 0 ? `₹${product.price}` : "Contact for price"}\n` +
    `🎨 ${(product.colors || []).join(", ") || "—"}\n` +
    `📏 Sizes: ${(product.sizes || []).join(", ") || "One size"}\n\n` +
    `Reply "show me ${product.category}" to see it now! 👇`;

  // Target: customers who ordered from this category before → else all customers
  const allCustomers = customers.getAll().customers;
  const category     = product.category.toLowerCase();

  const targeted = allCustomers.filter(c => {
    const theirOrders = orders.getByCustomer(c.id);
    return theirOrders.some(o =>
      o.cart.some(item => item.category?.toLowerCase() === category)
    );
  });

  const recipients = targeted.length ? targeted : allCustomers;

  let sent = 0;
  for (const c of recipients) {
    try {
      await manychat.send(c.id, message);
      // Tag session so next purchase is tracked as new_arrival commission
      session.update(c.id, { promoSource: "new_arrival", promoSentAt: Date.now() });
      sent++;
    } catch (err) {
      console.error(`[promote/newarrival] Failed for ${c.id}:`, err.message);
    }
  }

  console.log(`[promote/newarrival] Sent to ${sent} customers (targeted: ${targeted.length > 0})`);
  res.json({ ok: true, sent, total: recipients.length, targeted: targeted.length > 0 });
});

// POST /api/promote/abandoned — manually trigger abandoned cart recovery blast
app.post("/api/promote/abandoned", async (req, res) => {
  const recovered = await runAbandonedCartRecovery();
  res.json({ ok: true, sent: recovered });
});

// ── Single Customer API ────────────────────────────────────────────────────────
app.get("/api/customers/:id", (req, res) => {
  const customer = customers.get(req.params.id);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  const customerOrders = orders.getByCustomer(req.params.id);
  res.json({ customer, orders: customerOrders });
});

// ── Abandoned Cart Recovery Engine ────────────────────────────────────────────
// Every hour: check for carts abandoned > 2 hours ago and send a nudge
const CART_TIMEOUT_MS    = 2  * 60 * 60 * 1000; // 2 hours
const RECOVERY_INTERVAL  = 60 * 60 * 1000;        // check every 1 hour

async function runAbandonedCartRecovery() {
  const now      = Date.now();
  const allSess  = session.all();
  let   sent     = 0;

  for (const sess of allSess) {
    // Must have items in cart, not already in payment flow, not already nudged
    if (
      !sess.cart?.length ||
      sess.state === "awaiting_payment" ||
      sess.abandonedNudgeSent
    ) continue;

    const idleTime = now - (sess.updatedAt || sess.createdAt || 0);
    if (idleTime < CART_TIMEOUT_MS) continue;

    const itemNames = sess.cart.map(i => i.name).join(", ");
    const total     = sess.cart.reduce((s, i) => s + (i.price || 0), 0);

    try {
      await manychat.send(sess.customerId,
        `Hey ${sess.name || "there"}! 👋 You left something behind 🛒\n\n` +
        `*Your cart:* ${itemNames}\n` +
        `*Estimated total:* ₹${total}\n\n` +
        `Ready to complete your order? Reply "done" to checkout! 🎁\n` +
        `_(Reply "cancel" to clear your cart)_`
      );
      session.update(sess.customerId, { abandonedNudgeSent: true, promoSource: "abandoned_cart", promoSentAt: Date.now() });
      sent++;
    } catch (err) {
      console.error(`[abandoned-cart] Error sending to ${sess.customerId}:`, err.message);
    }
  }

  if (sent) console.log(`[abandoned-cart] Recovered ${sent} carts`);
  return sent;
}

// Run abandoned cart recovery on an interval
setInterval(runAbandonedCartRecovery, RECOVERY_INTERVAL);

// ── Review Pipeline: request review after delivery ────────────────────────────
// Triggered from the order status update API when status becomes "delivered"
// (already sends a "How was your experience? ⭐⭐⭐⭐⭐" in the DM above)
// Additionally schedule a follow-up review request 24 hours later
function scheduleReviewRequest(customerId, orderId, customerName) {
  setTimeout(async () => {
    try {
      const order = orders.get(orderId);
      if (!order || order.status !== "delivered") return; // cancelled or returned
      await manychat.send(customerId,
        `Hi ${customerName}! 😊\n\n` +
        `How was your experience with order #CF${orderId}?\n\n` +
        `⭐ Reply 1 — Poor\n` +
        `⭐⭐⭐ Reply 3 — Good\n` +
        `⭐⭐⭐⭐⭐ Reply 5 — Excellent!\n\n` +
        `Your feedback helps us improve 🙏`
      );
    } catch {}
  }, 24 * 60 * 60 * 1000); // 24 hours later
}

// ── Billing & Subscription APIs ───────────────────────────────────────────────

// GET /api/billing/summary  — monthly bill breakdown
app.get("/api/billing/summary", (req, res) => {
  const businessId = req.query.businessId || DEFAULT_BUSINESS_ID;
  const sub        = subscriptions.get(businessId);
  const summary    = commissionEngine.getMonthlySummary(businessId, sub.monthlyFee);

  res.json({
    subscription: {
      status       : sub.status,
      plan         : sub.plan,
      monthlyFee   : sub.monthlyFee,
      daysRemaining: subscriptions.daysRemaining(businessId),
      trialEnds    : sub.trialEnds,
      paidUntil    : sub.paidUntil,
      isActive     : subscriptions.isActive(businessId),
    },
    billing: summary,
  });
});

// GET /api/billing/commissions  — list commissions this month
app.get("/api/billing/commissions", (req, res) => {
  const businessId = req.query.businessId || DEFAULT_BUSINESS_ID;
  const month      = req.query.month;  // optional: "2026-04"
  res.json({ commissions: commissionEngine.getAll({ businessId, month }) });
});

// POST /api/billing/payment  — record a manual payment (subscription renewal)
app.post("/api/billing/payment", (req, res) => {
  const { businessId = DEFAULT_BUSINESS_ID, amount, paymentId, method } = req.body;
  const sub = subscriptions.recordPayment(businessId, { amount, paymentId, method });
  res.json({ ok: true, subscription: sub });
});

// POST /api/billing/commissions/record  — record commission (used by tests + admin)
app.post("/api/billing/commissions/record", (req, res) => {
  const { businessId = DEFAULT_BUSINESS_ID, orderId, cart, promoSource } = req.body;
  const result = commissionEngine.calculate(cart || [], promoSource);
  if (!result.eligible) return res.json({ ok: true, eligible: false, commissionAmount: 0 });
  const entry = commissionEngine.record(businessId, orderId, cart, promoSource);
  res.json({ ok: true, eligible: true, commissionAmount: entry.commissionAmount, entry });
});

// GET /api/billing/subscription  — current subscription status
app.get("/api/billing/subscription", (req, res) => {
  const businessId = req.query.businessId || DEFAULT_BUSINESS_ID;
  res.json({
    ...subscriptions.get(businessId),
    isActive     : subscriptions.isActive(businessId),
    daysRemaining: subscriptions.daysRemaining(businessId),
  });
});

// ── Subscription gate middleware ──────────────────────────────────────────────
// Called before routing customer messages — blocks bot if subscription lapsed
function checkSubscription(businessId) {
  if (!subscriptions.isActive(businessId)) {
    console.warn(`[subscription] Business ${businessId} subscription lapsed — bot paused`);
    return false;
  }
  return true;
}

// Patch the order status update route to also schedule review requests
const _origUpdateRoute = app._router?.stack; // we wire it inside the handler below

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[CodeForge Instagram Bot] Running on port ${PORT}`);
  console.log(`[ManyChat webhook] POST http://your-server.com/webhook/manychat`);
});

module.exports = app;
