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

// ── Check if active (trial, paid, or within grace period) ────────────────────
async function isActive(businessId) {
  const sub = await getOrCreate(businessId);
  const now = Date.now();
  if (sub.status === "trial")     return now < sub.trialEnds;
  if (sub.status === "active")    return now < sub.paidUntil;
  if (sub.status === "grace")     return true;  // grace period = still active, just overdue
  return false;
}

// ── Check if suspended (service must stop) ────────────────────────────────────
async function isSuspended(businessId) {
  const sub = await getOrCreate(businessId);
  return sub.status === "suspended";
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

// ── Auto-expire + grace period + suspension check ────────────────────────────
async function runExpiryCheck() {
  const now            = Date.now();
  const graceCutoff    = now - GRACE_PERIOD_DAYS * 86400000;
  const reminderWindow = 7 * 86400000;   // remind 7 days before due
  const reminderCooldown = 23 * 60 * 60 * 1000; // max 1 reminder per 23h

  try {
    // 1. Trial expired → expired
    await db.query(
      `UPDATE subscriptions SET status='expired', updated_at=$1
       WHERE status='trial' AND trial_ends < $1`, [now]
    );

    // 2. Active but paid_until passed → move to grace (10-day buffer)
    const { rows: newGrace } = await db.query(
      `UPDATE subscriptions SET status='grace', grace_period_start=$1, updated_at=$1
       WHERE status='active' AND paid_until < $1
       RETURNING business_id, monthly_fee`,
      [now]
    );
    for (const r of newGrace) {
      console.log(`[Subscriptions] ${r.business_id} entered grace period — 10 days to pay ₹${r.monthly_fee}`);
      await sendOwnerReminder(r.business_id, "grace_start", r.monthly_fee);
    }

    // 3. Grace period > 10 days → suspend service
    const { rows: suspended } = await db.query(
      `UPDATE subscriptions SET status='suspended', updated_at=$1
       WHERE status='grace' AND grace_period_start > 0 AND grace_period_start < $2
       RETURNING business_id`,
      [now, graceCutoff]
    );
    for (const r of suspended) {
      console.log(`[Subscriptions] ${r.business_id} SUSPENDED — grace period elapsed`);
      await sendOwnerReminder(r.business_id, "suspended", 0);
    }

    // 4. Remind active clients 7 days before due — max once per 23h
    await db.query(
      `UPDATE subscriptions SET last_reminder_sent=$1, updated_at=$1
       WHERE status='active'
         AND paid_until > $1
         AND paid_until < $2
         AND (last_reminder_sent = 0 OR last_reminder_sent < $3)
       RETURNING business_id, monthly_fee, paid_until`,
      [now, now + reminderWindow, now - reminderCooldown]
    ).then(async ({ rows }) => {
      for (const r of rows) {
        const daysLeft = Math.ceil((r.paid_until - now) / 86400000);
        await sendOwnerReminder(r.business_id, "upcoming", r.monthly_fee, daysLeft);
      }
    }).catch(() => {});

    // 5. Remind grace clients every 3 days
    await db.query(
      `UPDATE subscriptions SET last_reminder_sent=$1, updated_at=$1
       WHERE status='grace'
         AND (last_reminder_sent = 0 OR last_reminder_sent < $2)
       RETURNING business_id, monthly_fee, grace_period_start`,
      [now, now - 3 * 86400000]
    ).then(async ({ rows }) => {
      for (const r of rows) {
        const daysInGrace = Math.floor((now - r.grace_period_start) / 86400000);
        const daysLeft    = Math.max(0, GRACE_PERIOD_DAYS - daysInGrace);
        await sendOwnerReminder(r.business_id, "grace_reminder", r.monthly_fee, daysLeft);
      }
    }).catch(() => {});

  } catch (e) {
    console.error("[Subscriptions] runExpiryCheck error:", e.message);
  }
}

// ── Send WhatsApp reminder to business owner ──────────────────────────────────
async function sendOwnerReminder(businessId, type, fee, daysLeft) {
  try {
    const wa          = require("./whatsapp");
    const waNumbers   = require("./wa_numbers");
    const numInfo     = await waNumbers.getByBusinessId(businessId);
    if (!numInfo?.owner_phone) return; // no owner phone on file

    const ownerPhone  = numInfo.owner_phone;
    const phoneId     = numInfo.phone_number_id;
    const token       = numInfo.token;
    const amount      = fee || MONTHLY_FEE;

    let msg = "";
    if (type === "upcoming") {
      msg = `⏰ *Selly Subscription Reminder*\n\nHi! Your Selly subscription of ₹${amount} is due in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}.\n\nPlease pay on time to keep your WhatsApp bot running without interruption.\n\nOpen the Selly app → Plan & Billing → Pay Now`;
    } else if (type === "grace_start") {
      msg = `🔔 *Selly Payment Due*\n\nYour Selly subscription of ₹${amount} is now overdue.\n\n⚠️ You have a *10-day grace period* — your bot will continue working until then.\n\nPlease pay within 10 days to avoid service suspension.\n\nOpen the Selly app → Plan & Billing → Pay Now`;
    } else if (type === "grace_reminder") {
      msg = `⚠️ *Selly Payment Reminder*\n\nYour subscription is overdue. Only *${daysLeft} day${daysLeft !== 1 ? "s" : ""}* left before your WhatsApp bot is paused.\n\nPay ₹${amount} now to avoid interruption.\n\nOpen the Selly app → Plan & Billing → Pay Now`;
    } else if (type === "suspended") {
      msg = `🚫 *Selly Service Suspended*\n\nYour Selly WhatsApp bot has been paused due to non-payment.\n\nYour customers will not receive any responses until payment is made.\n\nPay now to instantly resume service:\nOpen the Selly app → Plan & Billing → Pay Now`;
    }

    if (msg) await wa.send(ownerPhone, msg, phoneId, token);
  } catch (e) {
    console.warn("[Subscriptions] sendOwnerReminder failed:", e.message);
  }
}

// ── Map DB row → subscription shape ──────────────────────────────────────────
function _toSub(row) {
  const now            = Date.now();
  const gracePeriodStart = Number(row.grace_period_start) || 0;
  const daysInGrace    = gracePeriodStart ? Math.floor((now - gracePeriodStart) / 86400000) : 0;
  const graceDaysLeft  = Math.max(0, GRACE_PERIOD_DAYS - daysInGrace);
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
    gracePeriodStart    : gracePeriodStart,
    graceDaysLeft       : graceDaysLeft,
    createdAt           : row.created_at          || 0,
    updatedAt           : row.updated_at          || 0,
    paymentHistory      : row.payment_history     || [],
  };
}

const GRACE_PERIOD_DAYS = 10;

// Run expiry check every 6 hours
setInterval(runExpiryCheck, 6 * 60 * 60 * 1000);

module.exports = {
  getOrCreate, get, getAll, isActive, isSuspended, daysRemaining,
  recordPayment, expire, runExpiryCheck,
  MONTHLY_FEE, COMMISSION_PCT, COMMISSION_MIN, GRACE_PERIOD_DAYS,
};
