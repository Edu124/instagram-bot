// ── Commission Engine — Railway PostgreSQL backed ──────────────────────────────
const db = require("./db");
const { COMMISSION_PCT, COMMISSION_MIN } = require("./subscriptions");

const PROMO_SOURCES = new Set(["flash_sale", "new_arrival", "abandoned_cart", "referral"]);

// ── Calculate commission (pure — no DB) ──────────────────────────────────────
function calculate(cart = [], promoSource = null) {
  if (!promoSource || !PROMO_SOURCES.has(promoSource)) {
    return { eligible: false, commissionAmount: 0, breakdown: [] };
  }

  const breakdown = cart
    .filter(item => (item.price || 0) > COMMISSION_MIN)
    .map(item => ({
      itemName        : item.name,
      itemPrice       : item.price,
      commissionRate  : COMMISSION_PCT,
      commissionAmount: Math.round(item.price * COMMISSION_PCT),
    }));

  return {
    eligible        : breakdown.length > 0,
    commissionAmount: breakdown.reduce((s, b) => s + b.commissionAmount, 0),
    breakdown,
    promoSource,
  };
}

// ── Record commission for a completed order ───────────────────────────────────
async function record(businessId, orderId, cart, promoSource) {
  const result = calculate(cart, promoSource);
  if (!result.eligible) return null;

  const entry = {
    id              : Date.now().toString(),
    business_id     : businessId,
    order_id        : orderId,
    promo_source    : promoSource,
    commission_amount: result.commissionAmount,
    breakdown       : result.breakdown,
    status          : "pending",
    created_at      : Date.now(),
  };

  try {
    const { rows } = await db.query(
      `INSERT INTO commissions
         (id, business_id, order_id, promo_source, commission_amount, breakdown, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        entry.id, entry.business_id, entry.order_id, entry.promo_source,
        entry.commission_amount, JSON.stringify(entry.breakdown),
        entry.status, entry.created_at,
      ]
    );
    return rows[0];
  } catch (e) {
    console.error("[Commission] record error:", e.message);
    return null;
  }
}

// ── Get all commissions for a business this month ─────────────────────────────
async function getMonthly(businessId) {
  const now        = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  try {
    const { rows } = await db.query(
      `SELECT * FROM commissions WHERE business_id=$1 AND created_at >= $2 ORDER BY created_at DESC`,
      [businessId, monthStart]
    );
    return rows.map(_toCommission);
  } catch (e) {
    console.error("[Commission] getMonthly error:", e.message);
    return [];
  }
}

// ── Billing summary for a business ───────────────────────────────────────────
async function getMonthlySummary(businessId, monthlyFee = 3000) {
  const monthly   = await getMonthly(businessId);
  const totalComm = monthly.reduce((s, c) => s + c.commissionAmount, 0);

  return {
    businessId,
    period         : new Date().toLocaleString("en-IN", { month: "long", year: "numeric" }),
    subscriptionFee: monthlyFee,
    commissions    : monthly,
    totalCommission: totalComm,
    totalDue       : monthlyFee + totalComm,
    breakdown      : monthly.map(c => ({
      orderId    : c.orderId,
      promoSource: c.promoSource,
      amount     : c.commissionAmount,
      date       : new Date(c.createdAt).toLocaleDateString("en-IN"),
    })),
  };
}

// ── Get all commissions (admin) ───────────────────────────────────────────────
async function getAll({ businessId, month } = {}) {
  try {
    const vals  = [];
    const wheres = [];
    let i = 1;

    if (businessId) { wheres.push(`business_id=$${i++}`); vals.push(businessId); }
    if (month) {
      const [y, m]  = month.split("-").map(Number);
      const start   = new Date(y, m - 1, 1).getTime();
      const end     = new Date(y, m, 0, 23, 59, 59).getTime();
      wheres.push(`created_at >= $${i++}`); vals.push(start);
      wheres.push(`created_at <= $${i++}`); vals.push(end);
    }

    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const { rows } = await db.query(
      `SELECT * FROM commissions ${where} ORDER BY created_at DESC`,
      vals
    );
    return rows.map(_toCommission);
  } catch (e) {
    console.error("[Commission] getAll error:", e.message);
    return [];
  }
}

function _toCommission(row) {
  return {
    id              : row.id,
    businessId      : row.business_id,
    orderId         : row.order_id,
    promoSource     : row.promo_source,
    commissionAmount: Number(row.commission_amount),
    breakdown       : row.breakdown || [],
    status          : row.status,
    createdAt       : row.created_at || 0,
  };
}

module.exports = { calculate, record, getMonthly, getMonthlySummary, getAll, PROMO_SOURCES };
