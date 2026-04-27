// ── Order Manager — Railway PostgreSQL backed ──────────────────────────────────
const db = require("./db");

const DEFAULT_BID = process.env.BUSINESS_ID || "default";

// ── Create order ──────────────────────────────────────────────────────────────
async function create(data) {
  const row = {
    id             : Date.now().toString(),
    business_id    : DEFAULT_BID,
    customer_id    : data.customerId    || null,
    name           : data.name          || "",
    cart           : data.cart          || [],
    address        : data.address       || "",
    mobile         : data.mobile        || "",
    bill           : data.bill          || {},
    pay_link       : data.payLink       || null,
    payment_mode   : data.paymentMode   || "cod",
    status         : data.status        || "pending_payment",
    status_dates   : { [data.status || "pending_payment"]: new Date().toLocaleDateString("en-IN") },
    tracking_number: null,
    tracking_url   : null,
    source         : "whatsapp",
    promo_source   : data.promoSource   || null,
    commission     : data.commission    || 0,
  };

  try {
    const { rows } = await db.query(
      `INSERT INTO orders
         (id, business_id, customer_id, name, cart, address, mobile, bill,
          pay_link, payment_mode, status, status_dates, tracking_number,
          tracking_url, source, promo_source, commission)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        row.id, row.business_id, row.customer_id, row.name,
        JSON.stringify(row.cart), row.address, row.mobile, JSON.stringify(row.bill),
        row.pay_link, row.payment_mode, row.status, JSON.stringify(row.status_dates),
        row.tracking_number, row.tracking_url, row.source,
        row.promo_source, row.commission,
      ]
    );
    return _toOrder(rows[0]);
  } catch (e) {
    console.error("[Orders] create error:", e.message);
    return _toOrder(row);
  }
}

// ── Get order by ID ───────────────────────────────────────────────────────────
async function get(orderId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM orders WHERE id = $1`,
      [String(orderId)]
    );
    return rows[0] ? _toOrder(rows[0]) : null;
  } catch (e) {
    console.error("[Orders] get error:", e.message);
    return null;
  }
}

// ── Get all orders for a customer ─────────────────────────────────────────────
async function getByCustomer(customerId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
      [customerId]
    );
    return rows.map(_toOrder);
  } catch (e) {
    console.error("[Orders] getByCustomer error:", e.message);
    return [];
  }
}

// ── Get all orders (for business dashboard) ───────────────────────────────────
async function getAll({ status, page = 1, limit = 20 } = {}) {
  try {
    const vals = [DEFAULT_BID, limit, (page - 1) * limit];
    let where  = `WHERE business_id = $1`;
    if (status) { where += ` AND status = $4`; vals.push(status); }

    const { rows } = await db.query(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      vals
    );

    // Total count
    const cVals = [DEFAULT_BID];
    let   cWhere = `WHERE business_id = $1`;
    if (status) { cWhere += ` AND status = $2`; cVals.push(status); }
    const { rows: cnt } = await db.query(
      `SELECT COUNT(*)::int AS total FROM orders ${cWhere}`,
      cVals
    );

    return { orders: rows.map(_toOrder), total: cnt[0]?.total || 0, page };
  } catch (e) {
    console.error("[Orders] getAll error:", e.message);
    return { orders: [], total: 0, page };
  }
}

// ── Update order status ───────────────────────────────────────────────────────
async function updateStatus(orderId, status, extra = {}) {
  const existing = await get(orderId);
  if (!existing) return null;

  const statusDates = {
    ...(existing.statusDates || {}),
    [status]: new Date().toLocaleDateString("en-IN"),
  };

  const sets = [`status=$1`, `status_dates=$2`, `updated_at=NOW()`];
  const vals = [status, JSON.stringify(statusDates)];
  let i = 3;

  if (extra.trackingNumber) { sets.push(`tracking_number=$${i++}`); vals.push(extra.trackingNumber); }
  if (extra.trackingUrl)    { sets.push(`tracking_url=$${i++}`);    vals.push(extra.trackingUrl); }

  vals.push(String(orderId));
  try {
    const { rows } = await db.query(
      `UPDATE orders SET ${sets.join(", ")} WHERE id=$${i} RETURNING *`,
      vals
    );
    return rows[0] ? _toOrder(rows[0]) : null;
  } catch (e) {
    console.error("[Orders] updateStatus error:", e.message);
    return null;
  }
}

// ── Set payment link on an order ──────────────────────────────────────────────
async function updatePayLink(orderId, payLink) {
  try {
    const { rows } = await db.query(
      `UPDATE orders SET pay_link=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [payLink, String(orderId)]
    );
    return rows[0] ? _toOrder(rows[0]) : null;
  } catch (e) {
    console.error("[Orders] updatePayLink error:", e.message);
    return null;
  }
}

// ── Update tracking info ──────────────────────────────────────────────────────
async function updateTracking(orderId, trackingNumber, trackingUrl) {
  return updateStatus(orderId, "shipped", { trackingNumber, trackingUrl });
}

// ── Get stats for dashboard ───────────────────────────────────────────────────
async function getStats() {
  const today = new Date().toDateString();
  try {
    const { rows } = await db.query(
      `SELECT * FROM orders WHERE business_id = $1`,
      [DEFAULT_BID]
    );
    const all = rows.map(_toOrder);
    return {
      total        : all.length,
      pending      : all.filter(o => o.status === "pending_payment").length,
      confirmed    : all.filter(o => o.status === "confirmed").length,
      shipped      : all.filter(o => o.status === "shipped").length,
      delivered    : all.filter(o => o.status === "delivered").length,
      todayRevenue : all
        .filter(o => new Date(o.createdAt).toDateString() === today && o.status !== "pending_payment")
        .reduce((s, o) => s + (o.bill?.total || 0), 0),
      totalRevenue : all
        .filter(o => o.status !== "pending_payment" && o.status !== "cancelled")
        .reduce((s, o) => s + (o.bill?.total || 0), 0),
    };
  } catch (e) {
    console.error("[Orders] getStats error:", e.message);
    return { total: 0, pending: 0, confirmed: 0, shipped: 0, delivered: 0, todayRevenue: 0, totalRevenue: 0 };
  }
}

// ── Map DB row → app order shape ──────────────────────────────────────────────
function _toOrder(row) {
  return {
    id             : row.id,
    customerId     : row.customer_id,
    name           : row.name           || "",
    cart           : row.cart           || [],
    address        : row.address        || "",
    mobile         : row.mobile         || "",
    bill           : row.bill           || {},
    payLink        : row.pay_link       || null,
    paymentMode    : row.payment_mode   || "cod",
    status         : row.status         || "pending_payment",
    statusDates    : row.status_dates   || {},
    trackingNumber : row.tracking_number || null,
    trackingUrl    : row.tracking_url   || null,
    source         : row.source         || "whatsapp",
    promoSource    : row.promo_source   || null,
    commission     : row.commission     || 0,
    createdAt      : row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt      : row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

module.exports = { create, get, getByCustomer, getAll, updateStatus, updatePayLink, updateTracking, getStats };
