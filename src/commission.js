// ── Commission Engine ──────────────────────────────────────────────────────────
// Calculates and tracks Selly's 5% commission on promo-driven orders.
//
// Commission applies when ALL of these are true:
//   1. The order was triggered by a promotion (flash_sale | new_arrival |
//      abandoned_cart | referral)
//   2. At least one item in the cart has price > ₹1,000
//
// Commission = 5% × sum(item.price for items where item.price > ₹1,000)
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");
const { COMMISSION_PCT, COMMISSION_MIN } = require("./subscriptions");

// Promotion sources that trigger commission
const PROMO_SOURCES = new Set(["flash_sale", "new_arrival", "abandoned_cart", "referral"]);

let commissions = []; // array of commission records

// ── Calculate commission for an order ────────────────────────────────────────
// Returns { eligible, commissionAmount, breakdown }
function calculate(cart = [], promoSource = null) {
  // Not a promo-driven order → no commission
  if (!promoSource || !PROMO_SOURCES.has(promoSource)) {
    return { eligible: false, commissionAmount: 0, breakdown: [] };
  }

  const breakdown = cart
    .filter(item => (item.price || 0) > COMMISSION_MIN)
    .map(item => ({
      itemName       : item.name,
      itemPrice      : item.price,
      commissionRate : COMMISSION_PCT,
      commissionAmount: Math.round(item.price * COMMISSION_PCT),
    }));

  const commissionAmount = breakdown.reduce((s, b) => s + b.commissionAmount, 0);

  return {
    eligible        : breakdown.length > 0,
    commissionAmount,
    breakdown,
    promoSource,
  };
}

// ── Record commission for a completed order ───────────────────────────────────
function record(businessId, orderId, cart, promoSource) {
  const result = calculate(cart, promoSource);
  if (!result.eligible) return null;

  const entry = {
    id             : Date.now().toString(),
    businessId,
    orderId,
    promoSource,
    commissionAmount: result.commissionAmount,
    breakdown      : result.breakdown,
    status         : "pending",   // pending | invoiced | paid
    createdAt      : Date.now(),
  };

  commissions.push(entry);
  persist();
  return entry;
}

// ── Get all commissions for a business in the current month ───────────────────
function getMonthly(businessId) {
  const now       = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  return commissions.filter(c =>
    c.businessId === businessId &&
    c.createdAt  >= monthStart
  );
}

// ── Get billing summary for a business ───────────────────────────────────────
// Returns what they owe this month
function getMonthlySummary(businessId, monthlyFee = 3000) {
  const monthly   = getMonthly(businessId);
  const totalComm = monthly.reduce((s, c) => s + c.commissionAmount, 0);

  return {
    businessId,
    period          : new Date().toLocaleString("en-IN", { month: "long", year: "numeric" }),
    subscriptionFee : monthlyFee,
    commissions     : monthly,
    totalCommission : totalComm,
    totalDue        : monthlyFee + totalComm,
    breakdown       : monthly.map(c => ({
      orderId     : c.orderId,
      promoSource : c.promoSource,
      amount      : c.commissionAmount,
      date        : new Date(c.createdAt).toLocaleDateString("en-IN"),
    })),
  };
}

// ── Admin: get all commissions across all businesses ─────────────────────────
function getAll({ businessId, month } = {}) {
  let result = [...commissions];
  if (businessId) result = result.filter(c => c.businessId === businessId);
  if (month) {
    const [y, m]  = month.split("-").map(Number);
    const start   = new Date(y, m - 1, 1).getTime();
    const end     = new Date(y, m, 0, 23, 59, 59).getTime();
    result = result.filter(c => c.createdAt >= start && c.createdAt <= end);
  }
  return result;
}

// ── Persist / Load ────────────────────────────────────────────────────────────
function persist() {
  const filePath = path.join(__dirname, "../data/commissions.json");
  const dir      = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(commissions, null, 2));
  } catch (e) {
    console.error("[Commission] Persist error:", e.message);
  }
}

function load() {
  const filePath = path.join(__dirname, "../data/commissions.json");
  try {
    commissions = JSON.parse(fs.readFileSync(filePath, "utf8"));
    console.log(`[Commission] Loaded ${commissions.length} commission records`);
  } catch {
    console.log("[Commission] No commissions file, starting fresh");
  }
}

load();

module.exports = { calculate, record, getMonthly, getMonthlySummary, getAll, PROMO_SOURCES };
