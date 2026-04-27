// ── WhatsApp Status Reply Handler — Railway PostgreSQL backed ──────────────────
const db = require("./db");

const STATUS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Log a status posted by the business owner ─────────────────────────────────
async function logStatus(statusData) {
  const now   = Date.now();
  const entry = {
    id          : `status_${now}`,
    caption     : statusData.caption     || "",
    product_id  : statusData.productId   || null,
    product_name: statusData.productName || null,
    image_url   : statusData.imageUrl    || null,
    posted_at   : now,
  };

  try {
    // Prune expired
    await db.query(`DELETE FROM status_logs WHERE posted_at < $1`, [now - STATUS_TTL_MS]);

    await db.query(
      `INSERT INTO status_logs (id, caption, product_id, product_name, image_url, posted_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.id, entry.caption, entry.product_id, entry.product_name, entry.image_url, entry.posted_at]
    );

    // Keep max 20 entries
    await db.query(`
      DELETE FROM status_logs
      WHERE id NOT IN (SELECT id FROM status_logs ORDER BY posted_at DESC LIMIT 20)
    `);

    console.log(`[status] Logged: "${entry.caption.slice(0, 60)}"`);
    return _toStatus(entry);
  } catch (e) {
    console.error("[status] logStatus error:", e.message);
    return _toStatus(entry);
  }
}

// ── Detect if a WhatsApp message is a reply to a status ──────────────────────
function isStatusReply(msg) {
  return !!(msg && msg.context && msg.context.id);
}

// ── Get the most recently active status ──────────────────────────────────────
async function getMostRecentStatus() {
  try {
    const now = Date.now();
    const { rows } = await db.query(
      `SELECT * FROM status_logs WHERE posted_at > $1 ORDER BY posted_at DESC LIMIT 1`,
      [now - STATUS_TTL_MS]
    );
    return rows[0] ? _toStatus(rows[0]) : null;
  } catch (e) {
    console.error("[status] getMostRecentStatus error:", e.message);
    return null;
  }
}

// ── Get all active (within 24h) statuses ─────────────────────────────────────
async function getActiveStatuses() {
  try {
    const now = Date.now();
    const { rows } = await db.query(
      `SELECT * FROM status_logs WHERE posted_at > $1 ORDER BY posted_at DESC`,
      [now - STATUS_TTL_MS]
    );
    return rows.map(_toStatus);
  } catch (e) {
    console.error("[status] getActiveStatuses error:", e.message);
    return [];
  }
}

// ── Build bot reply for a status inquiry ─────────────────────────────────────
function buildStatusReply(status, lang = "english") {
  if (!status) {
    const msgs = {
      hindi   : "अरे! हमारा latest status देखकर आए 😊\nआप क्या ढूंढ रहे हैं? बताइए!",
      hinglish: "Hey! Humara status dekha na 😊\nKya chahiye aapko? Bolo!",
      english : "Hey! Glad you saw our status 😊\nWhat are you looking for? Tell me!",
    };
    return msgs[lang] || msgs.english;
  }

  const productLine = status.productName ? `*${status.productName}*` : "this product";

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

// ── Clear expired statuses ────────────────────────────────────────────────────
async function pruneExpired() {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM status_logs WHERE posted_at < $1`,
      [Date.now() - STATUS_TTL_MS]
    );
    return rowCount || 0;
  } catch (e) {
    console.error("[status] pruneExpired error:", e.message);
    return 0;
  }
}

function _toStatus(row) {
  return {
    id         : row.id,
    caption    : row.caption     || "",
    productId  : row.product_id  || null,
    productName: row.product_name|| null,
    imageUrl   : row.image_url   || null,
    postedAt   : row.posted_at   || 0,
  };
}

module.exports = { logStatus, isStatusReply, getMostRecentStatus, getActiveStatuses, buildStatusReply, pruneExpired };
