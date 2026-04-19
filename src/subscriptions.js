// ── Subscription Manager ───────────────────────────────────────────────────────
// Tracks each business's subscription status.
// Model:
//   ₹3,000 / month flat fee
//   + 5% commission on promo-driven orders where any item price > ₹1,000
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

const MONTHLY_FEE    = 3000;   // ₹3,000/month
const COMMISSION_PCT = 0.05;   // 5%
const COMMISSION_MIN = 1000;   // only on items above ₹1,000
const TRIAL_DAYS     = 14;     // free trial period

let subscriptions = new Map(); // businessId → subscription object

// ── Create or get subscription ────────────────────────────────────────────────
function getOrCreate(businessId) {
  if (subscriptions.has(businessId)) return subscriptions.get(businessId);

  const now  = Date.now();
  const sub  = {
    businessId,
    status       : "trial",              // trial | active | expired | suspended
    plan         : "starter",            // starter (only plan for now)
    monthlyFee   : MONTHLY_FEE,
    trialStarted : now,
    trialEnds    : now + TRIAL_DAYS * 24 * 60 * 60 * 1000,
    currentPeriodStart: now,
    currentPeriodEnd  : now + 30 * 24 * 60 * 60 * 1000,
    paidUntil    : now + TRIAL_DAYS * 24 * 60 * 60 * 1000,
    createdAt    : now,
    updatedAt    : now,
    paymentHistory: [],
  };

  subscriptions.set(businessId, sub);
  persist();
  return sub;
}

// ── Check if subscription is active (trial or paid) ───────────────────────────
function isActive(businessId) {
  const sub = getOrCreate(businessId);
  const now = Date.now();

  if (sub.status === "trial")  return now < sub.trialEnds;
  if (sub.status === "active") return now < sub.paidUntil;
  return false;
}

// ── Days remaining on current period ──────────────────────────────────────────
function daysRemaining(businessId) {
  const sub    = getOrCreate(businessId);
  const now    = Date.now();
  const target = sub.status === "trial" ? sub.trialEnds : sub.paidUntil;
  return Math.max(0, Math.ceil((target - now) / (24 * 60 * 60 * 1000)));
}

// ── Record a payment ──────────────────────────────────────────────────────────
function recordPayment(businessId, { amount, paymentId, method = "razorpay" }) {
  const sub = getOrCreate(businessId);
  const now = Date.now();

  // Extend by 30 days from now (or from current end, whichever is later)
  const base = Math.max(sub.paidUntil || 0, now);
  sub.paidUntil = base + 30 * 24 * 60 * 60 * 1000;
  sub.status    = "active";
  sub.updatedAt = now;

  sub.paymentHistory.push({
    amount,
    paymentId,
    method,
    paidAt: now,
    periodEnd: sub.paidUntil,
  });

  subscriptions.set(businessId, sub);
  persist();
  return sub;
}

// ── Mark as expired ───────────────────────────────────────────────────────────
function expire(businessId) {
  const sub = getOrCreate(businessId);
  sub.status    = "expired";
  sub.updatedAt = Date.now();
  subscriptions.set(businessId, sub);
  persist();
}

// ── Get full subscription object ──────────────────────────────────────────────
function get(businessId) {
  return getOrCreate(businessId);
}

// ── Get all subscriptions (admin view) ────────────────────────────────────────
function getAll() {
  return Array.from(subscriptions.values());
}

// ── Auto-expire check (run periodically) ─────────────────────────────────────
function runExpiryCheck() {
  const now = Date.now();
  for (const [id, sub] of subscriptions) {
    if (sub.status === "trial"  && now > sub.trialEnds)  expire(id);
    if (sub.status === "active" && now > sub.paidUntil)  expire(id);
  }
}

// ── Persist ───────────────────────────────────────────────────────────────────
function persist() {
  const dir      = path.join(__dirname, "../data");
  const filePath = path.join(dir, "subscriptions.json");
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(Array.from(subscriptions.values()), null, 2));
  } catch (e) {
    console.error("[Subscriptions] Persist error:", e.message);
  }
}

function load() {
  const filePath = path.join(__dirname, "../data/subscriptions.json");
  try {
    const arr = JSON.parse(fs.readFileSync(filePath, "utf8"));
    arr.forEach(s => subscriptions.set(s.businessId, s));
    console.log(`[Subscriptions] Loaded ${subscriptions.size} business subscriptions`);
  } catch {
    console.log("[Subscriptions] No subscriptions file, starting fresh");
  }
}

load();
// Check for expired subscriptions every hour
setInterval(runExpiryCheck, 60 * 60 * 1000);

module.exports = {
  getOrCreate, get, getAll, isActive, daysRemaining,
  recordPayment, expire, runExpiryCheck,
  MONTHLY_FEE, COMMISSION_PCT, COMMISSION_MIN,
};
