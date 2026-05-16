// ── shop.js — Customer-facing catalog web page ────────────────────────────────
// Route: GET /shop/:businessId?q=jeans&max=800&min=200&color=blue
// Features:
//   • Multi-select items → "Order X items via WhatsApp" (SELLY_CART: message)
//   • Heart button → save to Wishlist (localStorage, per businessId)
//   • Wishlist section at top shows saved items, "Order Saved" button
//   • Single-item "Order" button still works for quick orders
// Industry-aware: product / education / tourism / cakes / icecream
// NOT served for: kirana
// ─────────────────────────────────────────────────────────────────────────────

const catalog = require("./catalog");
const { supabaseAdmin } = require("./supabase");

// ── Industry config ───────────────────────────────────────────────────────────
const INDUSTRY = {
  product: {
    accent      : "#0EA5E9",
    accentDark  : "#0284c7",
    emoji       : "🛍️",
    itemLabel   : "products",
    btnText     : "Order via WhatsApp",
    orderMsg    : (names) => `Hi! I want to order these items:\n${names}`,
    singleMsg   : (name)  => `Hi, I want to order ${name}`,
    wishlistMsg : (names) => `Hi! I saved these and want to order:\n${names}`,
    chipFields  : (p) => [
      ...(p.colors?.slice(0, 3) || []).map(c => c),
      ...(p.sizes?.slice(0, 3)  || []).map(s => s),
      p.material || null,
    ].filter(Boolean),
    priceLabel  : (p) => p.price > 0 ? `₹${p.price.toLocaleString("en-IN")}` : "Contact",
    placeholder : "🛍️",
  },
  education: {
    accent      : "#6C47FF",
    accentDark  : "#5b3de8",
    emoji       : "📚",
    itemLabel   : "courses",
    btnText     : "Enroll via WhatsApp",
    orderMsg    : (names) => `Hi! I want to enroll in:\n${names}`,
    singleMsg   : (name)  => `Hi, I want to enroll in ${name}`,
    wishlistMsg : (names) => `Hi! I saved these courses:\n${names}`,
    chipFields  : (p) => [
      p.extraFields?.mode     || null,
      p.extraFields?.duration || null,
      p.extraFields?.subject  || null,
    ].filter(Boolean),
    priceLabel  : (p) => p.price > 0 ? `₹${p.price.toLocaleString("en-IN")} fees` : "Free",
    placeholder : "📚",
  },
  tourism: {
    accent      : "#10B981",
    accentDark  : "#059669",
    emoji       : "🌍",
    itemLabel   : "packages",
    btnText     : "Book via WhatsApp",
    orderMsg    : (names) => `Hi! I want to book:\n${names}`,
    singleMsg   : (name)  => `Hi, I want to book the ${name}`,
    wishlistMsg : (names) => `Hi! I saved these packages:\n${names}`,
    chipFields  : (p) => [
      p.extraFields?.destination || null,
      (p.extraFields?.nights && p.extraFields?.days) ? `${p.extraFields.nights}N/${p.extraFields.days}D` : null,
      p.extraFields?.groupSize ? `Up to ${p.extraFields.groupSize} pax` : null,
    ].filter(Boolean),
    priceLabel  : (p) => p.price > 0 ? `₹${p.price.toLocaleString("en-IN")}/person` : "Contact",
    placeholder : "🌍",
  },
  cakes: {
    accent      : "#ec4899",
    accentDark  : "#db2777",
    emoji       : "🎂",
    itemLabel   : "cakes",
    btnText     : "Order Cake",
    orderMsg    : (names) => `Hi! I want to order these cakes:\n${names}`,
    singleMsg   : (name)  => `Hi, I want to order a ${name}`,
    wishlistMsg : (names) => `Hi! I saved these cakes:\n${names}`,
    chipFields  : (p) => [
      p.extraFields?.category || null,
      ...(p.extraFields?.flavors?.slice(0, 2) || []),
      ...(p.extraFields?.sizes?.slice(0, 2)   || []),
    ].filter(Boolean),
    priceLabel  : (p) => p.price > 0 ? `₹${p.price.toLocaleString("en-IN")}/kg` : "Contact",
    placeholder : "🎂",
  },
  icecream: {
    accent      : "#a855f7",
    accentDark  : "#9333ea",
    emoji       : "🍦",
    itemLabel   : "flavors",
    btnText     : "Order Now",
    orderMsg    : (names) => `Hi! I want to order:\n${names}`,
    singleMsg   : (name)  => `Hi, I want to order ${name}`,
    wishlistMsg : (names) => `Hi! I saved these flavors:\n${names}`,
    chipFields  : (p) => [
      p.extraFields?.category || null,
      p.extraFields?.per500ml ? `500ml ₹${p.extraFields.per500ml}` : null,
    ].filter(Boolean),
    priceLabel  : (p) => p.price > 0 ? `₹${p.price.toLocaleString("en-IN")}/scoop` : "Contact",
    placeholder : "🍦",
  },
};

// ── Settings cache ─────────────────────────────────────────────────────────────
const _cache = {};
async function getSettings(businessId) {
  if (_cache[businessId]) return _cache[businessId];
  try {
    const { data } = await supabaseAdmin.from("business_settings").select("*").eq("business_id", businessId).maybeSingle();
    if (data) { _cache[businessId] = data; setTimeout(() => delete _cache[businessId], 5 * 60 * 1000); }
    return data || {};
  } catch { return {}; }
}

// ── Express route ──────────────────────────────────────────────────────────────
function register(app, catalogModule) {
  app.get("/shop/:businessId", async (req, res) => {
    const { businessId } = req.params;
    const { q = "", max, min, color, cat } = req.query;

    try {
      const settings = await getSettings(businessId);
      const industry = settings.industry || "product";

      if (industry === "kirana") {
        return res.status(404).send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:#f1f5f9"><h2>Shop not available</h2><p style="color:#94a3b8;margin-top:8px">This business uses a different order flow.</p></body></html>`);
      }

      const cfg     = INDUSTRY[industry] || INDUSTRY.product;
      const bizName = settings.business_name || "Our Store";
      const waNum   = (settings.whatsapp_number || "").replace(/[^0-9]/g, "");

      const intent = {
        product: q || undefined, rawQuery: q || undefined,
        maxPrice: max ? Number(max) : undefined,
        minPrice: min ? Number(min) : undefined,
        color: color || undefined, category: cat || undefined,
      };

      const searchResult = q
        ? await catalogModule.search(intent, businessId)
        : { results: await catalogModule.getAll(businessId) };

      const products     = (searchResult.results || []).filter(p => p.inStock !== false);
      const noExactMatch = searchResult.noExactMatch || false;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(generateHTML({ bizName, industry, cfg, products, q, max, min, color, cat, waNum, noExactMatch, businessId }));

    } catch (e) {
      console.error("[Shop] Error:", e.message);
      res.status(500).send(`<html><body style="background:#0a0a0f;color:#f1f5f9;font-family:sans-serif;text-align:center;padding:40px">Something went wrong. Please try again.</body></html>`);
    }
  });
}

// ── Build shop URL from bot search intent ──────────────────────────────────────
function buildShopUrl(baseUrl, businessId, intent) {
  const params = new URLSearchParams();
  if (intent.rawQuery || intent.product) params.set("q",     intent.rawQuery || intent.product);
  if (intent.maxPrice)                   params.set("max",   intent.maxPrice);
  if (intent.minPrice)                   params.set("min",   intent.minPrice);
  if (intent.color)                      params.set("color", intent.color);
  if (intent.category)                   params.set("cat",   intent.category);
  const qs = params.toString();
  return `${baseUrl}/shop/${businessId}${qs ? "?" + qs : ""}`;
}

// ── HTML page generator ────────────────────────────────────────────────────────
function generateHTML({ bizName, industry, cfg, products, q, max, min, color, cat, waNum, noExactMatch, businessId }) {
  const accent     = cfg.accent;
  const accentDark = cfg.accentDark;

  // Filter badges
  const filterBadges = [
    q     ? { text: `"${q}"`,        bg: accent + "25",   color: accent }   : null,
    max   ? { text: `Under ₹${max}`, bg: "#fef3c725",     color: "#d97706" } : null,
    min   ? { text: `Above ₹${min}`, bg: "#d1fae525",     color: "#065f46" } : null,
    color ? { text: color,           bg: "#e0e7ff",        color: "#3730a3" } : null,
    cat   ? { text: cat,             bg: "#f3e8ff",        color: "#7c3aed" } : null,
  ].filter(Boolean);

  // Serialize product data for JS (id, name, price only — enough for cart)
  const productDataJS = JSON.stringify(products.map(p => ({
    id   : p.id,
    name : p.name,
    price: p.price || 0,
  })));

  // Product cards
  const cardsHTML = products.map((p, idx) => {
    const chips    = cfg.chipFields(p);
    const priceStr = cfg.priceLabel(p);
    const imgUrl   = p.imageUrl || p.image_url || "";
    // Include SELLY_CART: so the bot directly adds to cart instead of treating as a search
    const singleWaMsg = cfg.singleMsg(p.name) + "\n\nSELLY_CART:" + p.name;
    const singleWa = waNum
      ? `https://wa.me/${waNum}?text=${encodeURIComponent(singleWaMsg)}`
      : "#";

    const chipsHTML = chips.length
      ? `<div class="chips">${chips.map(c => `<span class="chip">${escapeHTML(c)}</span>`).join("")}</div>`
      : "";

    return `
    <div class="card" id="card-${idx}" data-idx="${idx}" data-name="${escapeAttr(p.name)}" data-price="${p.price || 0}">
      <div class="card-media" onclick="toggleSelect(${idx})">
        ${imgUrl
          ? `<img class="card-img" src="${escapeAttr(imgUrl)}" alt="${escapeAttr(p.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ""}
        <div class="card-placeholder" style="display:${imgUrl ? "none" : "flex"}">${cfg.placeholder}</div>
        <div class="price-badge">${escapeHTML(priceStr)}</div>
        <div class="select-tick" id="tick-${idx}">✓</div>
      </div>
      <div class="card-body">
        <div class="card-top-row">
          <div class="card-name" onclick="toggleSelect(${idx})">${escapeHTML(p.name)}</div>
          <button class="heart-btn" id="heart-${idx}" onclick="toggleWishlist(${idx})" title="Save to Wishlist">♡</button>
        </div>
        ${chipsHTML}
        ${p.description ? `<div class="card-desc">${escapeHTML(p.description.slice(0, 70))}${p.description.length > 70 ? "…" : ""}</div>` : ""}
        <button class="quick-order-btn" id="addbtn-${idx}" onclick="addToCartAndOrder(${idx}, event)">
          🛒 Add to Cart
        </button>
      </div>
    </div>`;
  }).join("");

  const emptyHTML = `
    <div class="empty">
      <div class="empty-icon">${cfg.emoji}</div>
      <div class="empty-title">No ${cfg.itemLabel} found</div>
      <div class="empty-desc">${q ? `No results for "${escapeHTML(q)}"${max ? ` under ₹${max}` : ""}` : `No ${cfg.itemLabel} available right now`}</div>
      ${waNum ? `<a class="wa-btn-empty" href="https://wa.me/${waNum}?text=${encodeURIComponent("Hi, I need help finding something")}" target="_blank">💬 Ask on WhatsApp</a>` : ""}
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="theme-color" content="${accent}">
<title>${escapeHTML(bizName)}${q ? ` — ${escapeHTML(q)}` : ""}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --accent: ${accent};
    --accent-dark: ${accentDark};
    --bg: #0a0a0f;
    --bg-card: #13131a;
    --bg-card2: #1a1a24;
    --border: #1e1e2e;
    --text: #f1f5f9;
    --text-sec: #94a3b8;
    --text-muted: #475569;
    --radius: 14px;
    --green: #25d366;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding-bottom: 100px; }

  /* ── Header ─────────────────────────────────────────────────── */
  .header { background: var(--bg-card); border-bottom: 1px solid var(--border); padding: 12px 16px; position: sticky; top: 0; z-index: 20; }
  .header-row { display: flex; align-items: center; gap: 10px; }
  .header-logo { font-size: 20px; }
  .header-biz  { font-size: 16px; font-weight: 800; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .wishlist-badge-btn { background: none; border: 1.5px solid var(--border); border-radius: 20px; padding: 5px 10px; cursor: pointer; font-size: 13px; color: var(--text-sec); display: flex; align-items: center; gap: 4px; transition: all .2s; }
  .wishlist-badge-btn.has-items { border-color: #ef444466; color: #ef4444; }
  .powered { font-size: 10px; color: var(--text-muted); font-weight: 600; white-space: nowrap; }
  .powered span { color: var(--accent); font-weight: 900; }

  /* ── Wishlist section ───────────────────────────────────────── */
  .wishlist-section { display: none; background: var(--bg-card2); border-bottom: 2px solid #ef444433; padding: 14px 16px; }
  .wishlist-section.visible { display: block; }
  .wishlist-title { font-size: 13px; font-weight: 800; color: #ef4444; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
  .wishlist-clear { font-size: 11px; color: var(--text-muted); background: none; border: none; cursor: pointer; padding: 2px 6px; }
  .wishlist-items { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
  .wl-item { display: flex; align-items: center; gap: 10px; background: var(--bg); border-radius: 10px; padding: 8px 10px; border: 1px solid var(--border); }
  .wl-item-name { flex: 1; font-size: 13px; font-weight: 700; }
  .wl-item-price { font-size: 13px; font-weight: 800; color: var(--accent); }
  .wl-remove { background: none; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; padding: 0 4px; }
  .wl-order-btn { width: 100%; background: #ef444422; border: 1.5px solid #ef444466; color: #ef4444; border-radius: 10px; padding: 10px; font-size: 13px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; text-decoration: none; }

  /* ── Filter bar ─────────────────────────────────────────────── */
  .filter-bar { padding: 10px 16px 4px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .filter-label { font-size: 11px; color: var(--text-muted); font-weight: 600; }
  .filter-chip  { font-size: 12px; padding: 4px 10px; border-radius: 20px; font-weight: 700; border: 1px solid currentColor; }

  /* ── Count bar ──────────────────────────────────────────────── */
  .count-bar { padding: 4px 16px 8px; font-size: 12px; color: var(--text-sec); font-weight: 600; }
  .no-exact  { margin: 0 16px 8px; font-size: 12px; color: #d97706; background: #fef3c715; border: 1px solid #d9770633; border-radius: 8px; padding: 8px 12px; }

  /* ── Grid ───────────────────────────────────────────────────── */
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0 16px 24px; }
  @media (min-width: 500px) { .grid { grid-template-columns: repeat(3, 1fr); } }

  /* ── Card ───────────────────────────────────────────────────── */
  .card { background: var(--bg-card); border-radius: var(--radius); border: 2px solid var(--border); overflow: hidden; display: flex; flex-direction: column; transition: border-color .15s, transform .15s; cursor: pointer; }
  .card.selected { border-color: var(--accent); background: var(--accent)0a; transform: scale(0.98); }
  .card-media { position: relative; aspect-ratio: 4/3; overflow: hidden; background: var(--border); flex-shrink: 0; }
  .card-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .card-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 38px; background: var(--accent)18; }
  .price-badge { position: absolute; bottom: 7px; right: 7px; background: rgba(0,0,0,0.78); color: #fff; font-size: 11px; font-weight: 800; padding: 3px 7px; border-radius: 20px; }
  .select-tick { position: absolute; top: 7px; left: 7px; width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 14px; font-weight: 900; display: none; align-items: center; justify-content: center; }
  .card.selected .select-tick { display: flex; }

  /* ── Card body ──────────────────────────────────────────────── */
  .card-body { padding: 10px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .card-top-row { display: flex; align-items: flex-start; gap: 4px; }
  .card-name { font-size: 12px; font-weight: 800; color: var(--text); line-height: 1.35; flex: 1; }
  .card-desc { font-size: 11px; color: var(--text-sec); line-height: 1.4; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip  { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; background: var(--border); color: var(--text-sec); }

  /* ── Heart button ──��────────────────────────────────────────── */
  .heart-btn { background: none; border: none; font-size: 18px; cursor: pointer; padding: 0 2px; line-height: 1; flex-shrink: 0; transition: transform .2s; color: var(--text-muted); }
  .heart-btn.saved { color: #ef4444; }
  .heart-btn:active { transform: scale(1.3); }

  /* ── Quick order button (single item) ──────────────────────── */
  .quick-order-btn { display: flex; align-items: center; justify-content: center; gap: 5px; background: var(--green); color: #fff; font-size: 11px; font-weight: 800; padding: 8px; border-radius: 9px; text-decoration: none; margin-top: auto; border: none; cursor: pointer; width: 100%; transition: background .2s; }
  .quick-order-btn:active { opacity: 0.85; }

  /* ── Floating cart bar ──────────────────────────────────────── */
  .float-bar { position: fixed; bottom: 0; left: 0; right: 0; z-index: 30; padding: 12px 16px 20px; background: linear-gradient(to top, var(--bg) 60%, transparent); transform: translateY(110%); transition: transform .25s cubic-bezier(.34,1.56,.64,1); }
  .float-bar.visible { transform: translateY(0); }
  .float-btn { width: 100%; background: var(--accent); color: #fff; border: none; border-radius: 14px; padding: 15px 20px; font-size: 15px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .float-btn:active { background: var(--accent-dark); }
  .float-btn-left { display: flex; align-items: center; gap: 8px; }
  .float-count { background: rgba(255,255,255,0.25); border-radius: 20px; padding: 2px 10px; font-size: 13px; }
  .float-total { font-size: 14px; opacity: 0.9; }

  /* ── Empty state ─────────────────────────────────────────────── */
  .empty { padding: 60px 30px; text-align: center; }
  .empty-icon  { font-size: 52px; margin-bottom: 12px; }
  .empty-title { font-size: 18px; font-weight: 800; margin-bottom: 8px; }
  .empty-desc  { font-size: 14px; color: var(--text-sec); margin-bottom: 24px; line-height: 1.5; }
  .wa-btn-empty { display: inline-flex; align-items: center; gap: 8px; background: var(--green); color: #fff; font-size: 14px; font-weight: 700; padding: 12px 24px; border-radius: 12px; text-decoration: none; }

  /* ── Footer ─────────────────────────────────────────────────── */
  .footer { text-align: center; padding: 16px; color: var(--text-muted); font-size: 11px; border-top: 1px solid var(--border); }
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="header-row">
    <span class="header-logo">${cfg.emoji}</span>
    <span class="header-biz">${escapeHTML(bizName)}</span>
    <div class="header-actions">
      <button class="wishlist-badge-btn" id="wl-header-btn" onclick="toggleWishlistSection()" title="My Wishlist">
        ♡ <span id="wl-count">0</span>
      </button>
      <span class="powered">by <span>selly</span></span>
    </div>
  </div>
</div>

<!-- WISHLIST SECTION (hidden until items saved) -->
<div class="wishlist-section" id="wl-section">
  <div class="wishlist-title">
    ❤️ My Saved Items
    <button class="wishlist-clear" onclick="clearWishlist()">Clear all</button>
  </div>
  <div class="wishlist-items" id="wl-list"></div>
  <a class="wl-order-btn" id="wl-order-btn" href="#" target="_blank">
    ❤️ Order Saved Items via WhatsApp
  </a>
</div>

<!-- FILTER BADGES -->
${filterBadges.length ? `
<div class="filter-bar">
  <span class="filter-label">Showing:</span>
  ${filterBadges.map(b => `<span class="filter-chip" style="background:${b.bg};color:${b.color}">${escapeHTML(b.text)}</span>`).join("")}
</div>` : ""}

<!-- COUNT -->
<div class="count-bar">
  ${products.length} ${cfg.itemLabel}${filterBadges.length ? " matching your search" : " available"}
  ${products.length > 1 ? ` · Tap cards to select multiple` : ""}
</div>

${noExactMatch ? `<div class="no-exact">No exact matches — showing closest available ${cfg.itemLabel}</div>` : ""}

<!-- PRODUCT GRID -->
${products.length > 0 ? `<div class="grid">${cardsHTML}</div>` : emptyHTML}

<!-- FOOTER -->
<div class="footer">Powered by <strong style="color:var(--accent)">Selly</strong> — WhatsApp Commerce</div>

<!-- FLOATING CART BAR -->
<div class="float-bar" id="float-bar">
  <button class="float-btn" id="float-btn" onclick="orderSelected()">
    <div class="float-btn-left">
      🛒 <span id="float-label">Order</span>
      <span class="float-count" id="float-count">0 items</span>
    </div>
    <span class="float-total" id="float-total"></span>
  </button>
</div>

<script>
// ── Product data ──────────────────────────────────────────────────────────���───
const PRODUCTS  = ${productDataJS};
const WA_NUM    = ${JSON.stringify(waNum || "")};
const BIZ_ID    = ${JSON.stringify(businessId || "")};
const WL_KEY    = "selly_wishlist_" + BIZ_ID;
const ORDER_MSG = ${JSON.stringify(cfg.orderMsg("__NAMES__"))};
const WL_MSG    = ${JSON.stringify(cfg.wishlistMsg("__NAMES__"))};

// ── State ─────────────────────────────────────────────────────────────────────
let selected  = new Set();   // indices of selected-for-order cards
let wishlist  = loadWishlist();

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  renderWishlist();
  refreshWishlistHearts();
});

// ── Cart select / deselect ────────────────────────────────────────────────────
function toggleSelect(idx) {
  if (selected.has(idx)) {
    selected.delete(idx);
    document.getElementById("card-" + idx).classList.remove("selected");
  } else {
    selected.add(idx);
    document.getElementById("card-" + idx).classList.add("selected");
  }
  updateFloatBar();
}

function updateFloatBar() {
  const bar   = document.getElementById("float-bar");
  const count = document.getElementById("float-count");
  const label = document.getElementById("float-label");
  const total = document.getElementById("float-total");

  if (selected.size === 0) {
    bar.classList.remove("visible");
    return;
  }

  bar.classList.add("visible");
  const items     = [...selected].map(i => PRODUCTS[i]).filter(Boolean);
  const totalAmt  = items.reduce((s, p) => s + (p.price || 0), 0);
  const n         = items.length;

  count.textContent = n + " item" + (n > 1 ? "s" : "");
  label.textContent = "Order";
  total.textContent = totalAmt > 0 ? "₹" + totalAmt.toLocaleString("en-IN") : "";
}

// Add single item to local cart (select it) and update button label
function addToCartAndOrder(idx, evt) {
  evt.stopPropagation();
  const btn = document.getElementById("addbtn-" + idx);
  if (selected.has(idx)) {
    // Already in cart — remove it
    selected.delete(idx);
    document.getElementById("card-" + idx).classList.remove("selected");
    if (btn) { btn.textContent = "🛒 Add to Cart"; btn.style.background = "var(--green)"; }
  } else {
    // Add to cart
    selected.add(idx);
    document.getElementById("card-" + idx).classList.add("selected");
    if (btn) { btn.textContent = "✓ In Cart"; btn.style.background = "var(--accent)"; }
  }
  updateFloatBar();
}

function orderSelected() {
  if (!selected.size || !WA_NUM) return;
  const items    = [...selected].map(i => PRODUCTS[i]).filter(Boolean);
  const nameList = items.map((p, i) => (i + 1) + ". " + p.name + (p.price ? " (₹" + p.price.toLocaleString("en-IN") + ")" : "")).join("\\n");
  // SELLY_CART: prefix lets the bot detect and bulk-add to cart without searching
  const msgBody  = "SELLY_CART:" + items.map(p => p.name).join("|");
  const fullMsg  = ORDER_MSG.replace("__NAMES__", nameList) + "\\n\\n" + msgBody;
  window.open("https://wa.me/" + WA_NUM + "?text=" + encodeURIComponent(fullMsg), "_blank");
}

// ── Wishlist ──────────────────────────────────────────────────────────────────
function loadWishlist() {
  try { return JSON.parse(localStorage.getItem(WL_KEY) || "[]"); }
  catch { return []; }
}

function saveWishlistData() {
  try { localStorage.setItem(WL_KEY, JSON.stringify(wishlist)); }
  catch {}
}

function toggleWishlist(idx) {
  event.stopPropagation();
  const p       = PRODUCTS[idx];
  if (!p) return;
  const exists  = wishlist.findIndex(w => w.id === p.id);
  const heartEl = document.getElementById("heart-" + idx);

  if (exists >= 0) {
    wishlist.splice(exists, 1);
    if (heartEl) { heartEl.textContent = "♡"; heartEl.classList.remove("saved"); }
  } else {
    wishlist.push({ id: p.id, name: p.name, price: p.price || 0 });
    if (heartEl) { heartEl.textContent = "♥"; heartEl.classList.add("saved"); animateHeart(heartEl); }
  }
  saveWishlistData();
  renderWishlist();
}

function animateHeart(el) {
  el.style.transform = "scale(1.5)";
  setTimeout(() => { el.style.transform = "scale(1)"; }, 200);
}

function refreshWishlistHearts() {
  PRODUCTS.forEach((p, idx) => {
    const saved   = wishlist.some(w => w.id === p.id);
    const heartEl = document.getElementById("heart-" + idx);
    if (!heartEl) return;
    heartEl.textContent = saved ? "♥" : "♡";
    if (saved) heartEl.classList.add("saved");
    else heartEl.classList.remove("saved");
  });
}

function renderWishlist() {
  const section   = document.getElementById("wl-section");
  const list      = document.getElementById("wl-list");
  const badge     = document.getElementById("wl-count");
  const headerBtn = document.getElementById("wl-header-btn");
  const orderBtn  = document.getElementById("wl-order-btn");

  badge.textContent = wishlist.length;
  headerBtn.classList.toggle("has-items", wishlist.length > 0);

  if (!wishlist.length) {
    section.classList.remove("visible");
    return;
  }

  list.innerHTML = wishlist.map((w, i) => \`
    <div class="wl-item">
      <div class="wl-item-name">\${escapeHtml(w.name)}</div>
      <div class="wl-item-price">\${w.price > 0 ? "₹" + w.price.toLocaleString("en-IN") : "—"}</div>
      <button class="wl-remove" onclick="removeFromWishlist('\${w.id}')" title="Remove">✕</button>
    </div>
  \`).join("");

  // Build WhatsApp link for all wishlist items
  if (WA_NUM) {
    const nameList = wishlist.map((w, i) => (i + 1) + ". " + w.name).join("\\n");
    const msgBody  = "SELLY_CART:" + wishlist.map(w => w.name).join("|");
    const fullMsg  = WL_MSG.replace("__NAMES__", nameList) + "\\n\\n" + msgBody;
    orderBtn.href  = "https://wa.me/" + WA_NUM + "?text=" + encodeURIComponent(fullMsg);
  }
}

function removeFromWishlist(id) {
  const idx = wishlist.findIndex(w => w.id === id);
  if (idx < 0) return;
  wishlist.splice(idx, 1);
  saveWishlistData();
  renderWishlist();
  refreshWishlistHearts();
}

function clearWishlist() {
  wishlist = [];
  saveWishlistData();
  renderWishlist();
  refreshWishlistHearts();
  document.getElementById("wl-section").classList.remove("visible");
}

function toggleWishlistSection() {
  const section = document.getElementById("wl-section");
  if (!wishlist.length) return;
  section.classList.toggle("visible");
  if (section.classList.contains("visible")) section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
</script>
</body>
</html>`;
}

// ── Escape helpers ─────────────────────────────────────────────────────────────
function escapeHTML(str)  { return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function escapeAttr(str)  { return String(str || "").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

module.exports = { register, buildShopUrl, getSettings };
