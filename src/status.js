// ── WhatsApp Status Reply Handler ─────────────────────────────────────────────
// When a customer sees a WhatsApp Business Status and replies to it,
// the message arrives with a `context` object containing the status message ID.
//
// Business owner logs statuses via the Selly app (POST /api/status/log)
// Bot maps incoming status replies to the correct product automatically.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

const DATA_DIR  = path.join(__dirname, "../data");
const DATA_FILE = path.join(DATA_DIR, "status_log.json");

const STATUS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Persistence ───────────────────────────────────────────────────────────────
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {}
  return { statuses: [] };
}

function save(db) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("[status] Save error:", err.message);
  }
}

// ── Log a status posted by the business owner ─────────────────────────────────
// Called from Selly app (POST /api/status/log)
// { caption, productId?, productName?, imageUrl?, postedAt? }
function logStatus(statusData) {
  const db  = load();
  const now = Date.now();

  // Prune expired entries
  db.statuses = (db.statuses || []).filter(s => now - s.postedAt < STATUS_TTL_MS);

  const entry = {
    id         : `status_${now}`,
    caption    : statusData.caption    || "",
    productId  : statusData.productId  || null,
    productName: statusData.productName|| null,
    imageUrl   : statusData.imageUrl   || null,
    postedAt   : now,
  };

  db.statuses.unshift(entry); // most recent first
  if (db.statuses.length > 20) db.statuses = db.statuses.slice(0, 20);

  save(db);
  console.log(`[status] Logged status: "${entry.caption.slice(0, 60)}"`);
  return entry;
}

// ── Detect if a WhatsApp message is a reply to a status ─────────────────────
// WhatsApp includes msg.context.id when someone replies to a status/message
function isStatusReply(msg) {
  return !!(msg && msg.context && msg.context.id);
}

// ── Get the most recently active status product ───────────────────────────────
function getMostRecentStatus() {
  const db  = load();
  const now = Date.now();
  const live = (db.statuses || []).filter(s => now - s.postedAt < STATUS_TTL_MS);
  return live.length ? live[0] : null;
}

// ── Get all active (within 24h) statuses ─────────────────────────────────────
function getActiveStatuses() {
  const db  = load();
  const now = Date.now();
  return (db.statuses || []).filter(s => now - s.postedAt < STATUS_TTL_MS);
}

// ── Build the bot reply for a status inquiry ──────────────────────────────────
// lang: detected customer language
function buildStatusReply(status, lang = "english") {
  if (!status) {
    const msgs = {
      hindi   : "अरे! हमारा latest status देखकर आए 😊\nआप क्या ढूंढ रहे हैं? बताइए!",
      hinglish: "Hey! Humara status dekha na 😊\nKya chahiye aapko? Bolo!",
      english : "Hey! Glad you saw our status 😊\nWhat are you looking for? Tell me!",
    };
    return msgs[lang] || msgs.english;
  }

  const productLine = status.productName
    ? `*${status.productName}*`
    : "this product";

  const msgs = {
    hindi:
      `${status.imageUrl ? "🖼️ " : ""}Aapne humara status dekha — great! 😊\n\n` +
      `Aap *${productLine}* ke baare mein interested hain?\n\n` +
      `1️⃣ Haan, price batao!\n` +
      `2️⃣ Aur products dikhao\n` +
      `3️⃣ Kuch aur chahiye`,

    hinglish:
      `Hey! Humara status dekha na 😊\n\n` +
      `${productLine} mein interested ho?\n\n` +
      `1️⃣ Yes, price batao!\n` +
      `2️⃣ More products dikha\n` +
      `3️⃣ Kuch aur dhundna hai`,

    english:
      `Hey! Saw you checked out our status 😊\n\n` +
      `Interested in ${productLine}?\n\n` +
      `1️⃣ Yes, show me the price!\n` +
      `2️⃣ Show more products\n` +
      `3️⃣ Looking for something else`,
  };
  return msgs[lang] || msgs.english;
}

// ── Clear old statuses (manual cleanup) ──────────────────────────────────────
function pruneExpired() {
  const db  = load();
  const now = Date.now();
  const before = (db.statuses || []).length;
  db.statuses  = (db.statuses || []).filter(s => now - s.postedAt < STATUS_TTL_MS);
  if (db.statuses.length < before) save(db);
  return before - db.statuses.length;
}

module.exports = {
  logStatus,
  isStatusReply,
  getMostRecentStatus,
  getActiveStatuses,
  buildStatusReply,
  pruneExpired,
};
