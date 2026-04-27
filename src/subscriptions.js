// ── Subscription Manager — Railway PostgreSQL backed ───────────────────────────
const db = require("./db");

const MONTHLY_FEE    = 3000;
const COMMISSION_PCT = 0.05;
const COMMISSION_MIN = 1000;
const TRIAL_DAYS     = 14;

// ── Create or get subscription ────────────────────────────────────────────────
async function getOrCreate(businessId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM subscriptions WHERE business_id = $1`,
      [businessId]
    );
    if (rows[0]) return _toSub(rows[0]);

    const now = Date.now();
    const sub = {
      business_id          : businessId,
      status               : "trial",
      plan                 : "starter",
      monthly_fee          : MONTHLY_FEE,
      trial_started        : now,
      trial_ends           : now + TRIAL_DAYS * 86400000,
      current_period_start : now,
      current_period_end   : now + 30 * 86400000,
      paid_until           : now + TRIAL_DAYS * 86400000,
      created_at           : now,
      updated_at           : now,
      payment_history      : [],
    };

    const { rows: inserted } = await db.query(
      `INSERT INTO subscriptions
         (business_id, status, plan, monthly_fee, trial_started, trial_ends,
          current_period_start, current_period_end, paid_until, created_at, updated_at, payment_history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        sub.business_id, sub.status, sub.plan, sub.monthly_fee,
        sub.trial_started, sub.trial_ends, sub.current_period_start,
        sub.current_period_end, sub.paid_until, sub.created_at,
        sub.updated_at, JSON.stringify(sub.payment_history),
      ]
    );
    return _toSub(inserted[0] || sub);
  } catch (e) {
    console.error("[Subscriptions] getOrCreate error:", e.message);
    const now = Date.now();
    return { businessId, status: "trial", plan: "starter", monthlyFee: MONTHLY_FEE,
             trialStarted: now, trialEnds: now + TRIAL_DAYS * 86400000,
             paidUntil: now + TRIAL_DAYS * 86400000, paymentHistory: [], createdAt: now, updatedAt: now };
  }
}

// ── Check if active (trial or paid) ──────────────────────────────────────────
async function isActive(businessId) {
  const sub = await getOrCreate(businessId);
  const now = Date.now();
  if (sub.status === "trial")  return now < sub.trialEnds;
  if (sub.status === "active") return now < sub.paidUntil;
  return false;
}

// ── Days remaining ────────────────────────────────────────────────────────────
async function daysRemaining(businessId) {
  const sub    = await getOrCreate(businessId);
  const now    = Date.now();
  const target = sub.status === "trial" ? sub.trialEnds : sub.paidUntil;
  return Math.max(0, Math.ceil((target - now) / 86400000));
}

// ── Record a payment ──────────────────────────────────────────────────────────
async function recordPayment(businessId, { amount, paymentId, method = "razorpay" }) {
  try {
    const sub  = await getOrCreate(businessId);
    const now  = Date.now();
    const base = Math.max(sub.paidUntil || 0, now);
    const newPaidUntil = base + 30 * 86400000;

    const newHistory = [
      ...(sub.paymentHistory || []),
      { amount, paymentId, method, paidAt: now, periodEnd: newPaidUntil },
    ];

    const { rows } = await db.query(
      `UPDATE subscriptions SET status='active', paid_until=$1, updated_at=$2, payment_history=$3
       WHERE business_id=$4 RETURNING *`,
      [newPaidUntil, now, JSON.stringify(newHistory), businessId]
    );
    return _toSub(rows[0]);
  } catch (e) {
    console.error("[Subscriptions] recordPayment error:", e.message);
    return null;
  }
}

// ── Mark as expired ───────────────────────────────────────────────────────────
async function expire(businessId) {
  try {
    await db.query(
      `UPDATE subscriptions SET status='expired', updated_at=$1 WHERE business_id=$2`,
      [Date.now(), businessId]
    );
  } catch (e) {
    console.error("[Subscriptions] expire error:", e.message);
  }
}

// ── Get subscription ──────────────────────────────────────────────────────────
async function get(businessId) {
  return getOrCreate(businessId);
}

// ── Get all subscriptions ─────────────────────────────────────────────────────
async function getAll() {
  try {
    const { rows } = await db.query(`SELECT * FROM subscriptions ORDER BY created_at DESC`);
    return rows.map(_toSub);
  } catch (e) {
    console.error("[Subscriptions] getAll error:", e.message);
    return [];
  }
}

// ── Auto-expire check ─────────────────────────────────────────────────────────
async function runExpiryCheck() {
  const now = Date.now();
  try {
    await db.query(
      `UPDATE subscriptions SET status='expired', updated_at=$1
       WHERE (status='trial' AND trial_ends < $1)
          OR (status='active' AND paid_until < $1)`,
      [now]
    );
  } catch (e) {
    console.error("[Subscriptions] runExpiryCheck error:", e.message);
  }
}

// ── Map DB row → subscription shape ──────────────────────────────────────────
function _toSub(row) {
  return {
    businessId          : row.business_id,
    status              : row.status              || "trial",
    plan                : row.plan                || "starter",
    monthlyFee          : row.monthly_fee         || MONTHLY_FEE,
    trialStarted        : row.trial_started       || 0,
    trialEnds           : row.trial_ends          || 0,
    currentPeriodStart  : row.current_period_start|| 0,
    currentPeriodEnd    : row.current_period_end  || 0,
    paidUntil           : row.paid_until          || 0,
    createdAt           : row.created_at          || 0,
    updatedAt           : row.updated_at          || 0,
    paymentHistory      : row.payment_history     || [],
  };
}

// Start hourly expiry check
setInterval(runExpiryCheck, 60 * 60 * 1000);

module.exports = {
  getOrCreate, get, getAll, isActive, daysRemaining,
  recordPayment, expire, runExpiryCheck,
  MONTHLY_FEE, COMMISSION_PCT, COMMISSION_MIN,
};
