// ── Loyalty Points System — Railway PostgreSQL backed ──────────────────────────
// Earn  : 1 point per ₹1 spent  (2x for Gold tier)
// Bonus : 50 pts first order · 100 pts per referral · 25 pts birthday
// Redeem: 500 pts = ₹50 off (multiples: 1000pts=₹100, 1500pts=₹150 …)
// Tiers : Bronze (0+) · Silver (2000+ earned) · Gold (5000+ earned)
// ─────────────────────────────────────────────────────────────────────────────

const db = require("./db");

const REDEEM_THRESHOLD = 500;
const REDEEM_VALUE     = 50;

// ── Tier logic (pure — no DB) ─────────────────────────────────────────────────
function getTier(totalEarned = 0) {
  if (totalEarned >= 5000) return { name: "Gold",   emoji: "🥇", multiplier: 2,   benefit: "2× points on every order" };
  if (totalEarned >= 2000) return { name: "Silver", emoji: "🥈", multiplier: 1.5, benefit: "1.5× points on every order" };
  return                          { name: "Bronze", emoji: "🥉", multiplier: 1,   benefit: "1 point per ₹1 spent" };
}

// ── Points math (pure — no DB) ────────────────────────────────────────────────
function calcOrderPoints(orderAmount) {
  return Math.floor(orderAmount);
}

// ── Get customer record ───────────────────────────────────────────────────────
async function getRecord(customerId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM loyalty_points WHERE customer_id = $1`,
      [customerId]
    );
    if (rows[0]) return _toRecord(rows[0]);
    return { points: 0, totalEarned: 0, totalRedeemed: 0, ordersCount: 0, history: [] };
  } catch (e) {
    console.error("[loyalty] getRecord error:", e.message);
    return { points: 0, totalEarned: 0, totalRedeemed: 0, ordersCount: 0, history: [] };
  }
}

// ── Get current points balance ────────────────────────────────────────────────
async function getPoints(customerId) {
  return (await getRecord(customerId)).points;
}

// ── Add points ────────────────────────────────────────────────────────────────
async function addPoints(customerId, rawAmount, reason = "purchase", orderId = null) {
  try {
    const record = await getRecord(customerId);
    const tier   = getTier(record.totalEarned);
    const amount = reason === "purchase"
      ? Math.floor(rawAmount * tier.multiplier)
      : rawAmount;

    const newPoints        = record.points      + amount;
    const newTotalEarned   = record.totalEarned + amount;
    const newOrdersCount   = reason === "purchase" ? record.ordersCount + 1 : record.ordersCount;

    const newHistory = [
      ...(record.history || []),
      { type: "earn", amount, reason, orderId: orderId || null, date: new Date().toISOString(), balance: newPoints },
    ].slice(-50);

    await db.query(
      `INSERT INTO loyalty_points (customer_id, points, total_earned, total_redeemed, orders_count, history)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (customer_id) DO UPDATE SET
         points       = $2,
         total_earned = $3,
         orders_count = $4,
         history      = $6,
         updated_at   = NOW()`,
      [customerId, newPoints, newTotalEarned, newOrdersCount,
       record.totalRedeemed, JSON.stringify(newHistory)]
    );

    const updated = { ...record, points: newPoints, totalEarned: newTotalEarned, ordersCount: newOrdersCount, history: newHistory };
    return { record: updated, pointsAdded: amount };
  } catch (e) {
    console.error("[loyalty] addPoints error:", e.message);
    return { record: await getRecord(customerId), pointsAdded: 0 };
  }
}

// ── Redeem points ─────────────────────────────────────────────────────────────
async function redeemPoints(customerId, setsToRedeem = 1) {
  try {
    const record         = await getRecord(customerId);
    const pointsNeeded   = setsToRedeem * REDEEM_THRESHOLD;
    const discountAmount = setsToRedeem * REDEEM_VALUE;

    if (record.points < pointsNeeded) {
      return { ok: false, reason: `Need ${pointsNeeded} points for ₹${discountAmount} off. You have ${record.points}.` };
    }

    const newPoints        = record.points        - pointsNeeded;
    const newTotalRedeemed = record.totalRedeemed + pointsNeeded;
    const newHistory       = [
      ...(record.history || []),
      { type: "redeem", amount: -pointsNeeded, discountAmount, date: new Date().toISOString(), balance: newPoints },
    ].slice(-50);

    await db.query(
      `INSERT INTO loyalty_points (customer_id, points, total_earned, total_redeemed, orders_count, history)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (customer_id) DO UPDATE SET
         points         = $2,
         total_redeemed = $4,
         history        = $6,
         updated_at     = NOW()`,
      [customerId, newPoints, record.totalEarned, newTotalRedeemed,
       record.ordersCount, JSON.stringify(newHistory)]
    );

    return { ok: true, pointsUsed: pointsNeeded, discountAmount };
  } catch (e) {
    console.error("[loyalty] redeemPoints error:", e.message);
    return { ok: false, reason: "Error processing redemption" };
  }
}

// ── Calculate how much a customer can redeem ──────────────────────────────────
async function getRedeemInfo(customerId) {
  const record        = await getRecord(customerId);
  const points        = record.points;
  const maxSets       = Math.floor(points / REDEEM_THRESHOLD);
  const maxDiscount   = maxSets * REDEEM_VALUE;
  const rem           = points % REDEEM_THRESHOLD;
  return {
    points,
    maxSets,
    maxDiscount,
    canRedeem     : maxSets > 0,
    nextMilestone : rem === 0 ? 0 : REDEEM_THRESHOLD - rem,
  };
}

// ── Check if first order ──────────────────────────────────────────────────────
async function isFirstOrder(customerId) {
  return (await getRecord(customerId)).ordersCount === 0;
}

// ── Full summary text ─────────────────────────────────────────────────────────
async function getSummaryText(customerId, lang = "english") {
  const record = await getRecord(customerId);
  const tier   = getTier(record.totalEarned);
  const redeem = await getRedeemInfo(customerId);

  const tierLine   = `${tier.emoji} *${tier.name} Member* — ${tier.benefit}`;
  const pointsLine = `⭐ *${record.points} Selly Points*`;
  const redeemLine = redeem.canRedeem
    ? `💸 Redeem: ${redeem.maxSets * REDEEM_THRESHOLD} pts → ₹${redeem.maxDiscount} off`
    : `🎯 ${redeem.nextMilestone} more pts to unlock ₹${REDEEM_VALUE} off`;

  return `${tierLine}\n${pointsLine}\n${redeemLine}`;
}

// ── Map DB row → record shape ─────────────────────────────────────────────────
function _toRecord(row) {
  return {
    points       : row.points        || 0,
    totalEarned  : row.total_earned  || 0,
    totalRedeemed: row.total_redeemed|| 0,
    ordersCount  : row.orders_count  || 0,
    history      : row.history       || [],
  };
}

module.exports = {
  getRecord, getPoints, addPoints, redeemPoints,
  getRedeemInfo, calcOrderPoints, isFirstOrder,
  getTier, getSummaryText,
  REDEEM_THRESHOLD, REDEEM_VALUE,
};
