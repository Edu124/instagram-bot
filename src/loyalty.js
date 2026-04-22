// ── Loyalty Points System ─────────────────────────────────────────────────────
// Earn  : 1 point per ₹1 spent  (2x for Gold tier)
// Bonus : 50 pts first order · 100 pts per referral · 25 pts birthday
// Redeem: 500 pts = ₹50 off (multiples: 1000pts=₹100, 1500pts=₹150 …)
// Tiers : Bronze (0+) · Silver (2000+ earned) · Gold (5000+ earned)
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

const DATA_DIR  = path.join(__dirname, "../data");
const DATA_FILE = path.join(DATA_DIR, "loyalty.json");

const REDEEM_THRESHOLD = 500; // points needed per ₹50 discount
const REDEEM_VALUE     = 50;  // rupees per 500 points

// ── Persistence ───────────────────────────────────────────────────────────────
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {}
  return {};
}

function save(db) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("[loyalty] Save error:", err.message);
  }
}

// ── Tier logic ────────────────────────────────────────────────────────────────
function getTier(totalEarned = 0) {
  if (totalEarned >= 5000) return { name: "Gold",   emoji: "🥇", multiplier: 2,   benefit: "2× points on every order" };
  if (totalEarned >= 2000) return { name: "Silver", emoji: "🥈", multiplier: 1.5, benefit: "1.5× points on every order" };
  return                          { name: "Bronze", emoji: "🥉", multiplier: 1,   benefit: "1 point per ₹1 spent" };
}

// ── Get customer record ───────────────────────────────────────────────────────
function getRecord(customerId) {
  const db = load();
  return db[customerId] || {
    points       : 0,
    totalEarned  : 0,
    totalRedeemed: 0,
    ordersCount  : 0,
    history      : [],
  };
}

// ── Get current points balance ────────────────────────────────────────────────
function getPoints(customerId) {
  return getRecord(customerId).points;
}

// ── Add points ────────────────────────────────────────────────────────────────
// reason: "purchase" | "first_order" | "referral" | "birthday" | "bonus"
function addPoints(customerId, rawAmount, reason = "purchase", orderId = null) {
  const db     = load();
  const record = db[customerId] || {
    points: 0, totalEarned: 0, totalRedeemed: 0, ordersCount: 0, history: [],
  };

  // Apply tier multiplier on purchase points
  const tier   = getTier(record.totalEarned);
  const amount = reason === "purchase"
    ? Math.floor(rawAmount * tier.multiplier)
    : rawAmount;

  record.points       += amount;
  record.totalEarned  += amount;
  if (reason === "purchase") record.ordersCount++;

  record.history.push({
    type   : "earn",
    amount,
    reason,
    orderId : orderId || null,
    date   : new Date().toISOString(),
    balance: record.points,
  });

  // Trim history to last 50 entries
  if (record.history.length > 50) record.history = record.history.slice(-50);

  db[customerId] = record;
  save(db);
  return { record, pointsAdded: amount };
}

// ── Redeem points ─────────────────────────────────────────────────────────────
// Returns { ok, pointsUsed, discountAmount } or { ok: false, reason }
function redeemPoints(customerId, setsToRedeem = 1) {
  const db     = load();
  const record = db[customerId];
  if (!record) return { ok: false, reason: "No loyalty account found" };

  const pointsNeeded    = setsToRedeem * REDEEM_THRESHOLD;
  const discountAmount  = setsToRedeem * REDEEM_VALUE;

  if (record.points < pointsNeeded) {
    return {
      ok    : false,
      reason: `Need ${pointsNeeded} points for ₹${discountAmount} off. You have ${record.points}.`,
    };
  }

  record.points         -= pointsNeeded;
  record.totalRedeemed  += pointsNeeded;

  record.history.push({
    type          : "redeem",
    amount        : -pointsNeeded,
    discountAmount,
    date          : new Date().toISOString(),
    balance       : record.points,
  });

  db[customerId] = record;
  save(db);
  return { ok: true, pointsUsed: pointsNeeded, discountAmount };
}

// ── Calculate how much a customer can redeem ──────────────────────────────────
function getRedeemInfo(customerId) {
  const points       = getPoints(customerId);
  const maxSets      = Math.floor(points / REDEEM_THRESHOLD);
  const maxDiscount  = maxSets * REDEEM_VALUE;
  const nextMilestone = REDEEM_THRESHOLD - (points % REDEEM_THRESHOLD);
  return {
    points,
    maxSets,
    maxDiscount,
    canRedeem     : maxSets > 0,
    nextMilestone : nextMilestone === REDEEM_THRESHOLD ? 0 : nextMilestone,
  };
}

// ── Points to award for an order amount ──────────────────────────────────────
function calcOrderPoints(orderAmount) {
  return Math.floor(orderAmount); // base: 1pt per ₹1 (multiplier applied in addPoints)
}

// ── Check if first order (for bonus) ─────────────────────────────────────────
function isFirstOrder(customerId) {
  return getRecord(customerId).ordersCount === 0;
}

// ── Full summary string for WhatsApp message ─────────────────────────────────
function getSummaryText(customerId, lang = "english") {
  const record = getRecord(customerId);
  const tier   = getTier(record.totalEarned);
  const redeem = getRedeemInfo(customerId);

  const tierLine   = `${tier.emoji} *${tier.name} Member* — ${tier.benefit}`;
  const pointsLine = `⭐ *${record.points} Selly Points*`;
  const redeemLine = redeem.canRedeem
    ? `💸 Redeem: ${redeem.maxSets * REDEEM_THRESHOLD} pts → ₹${redeem.maxDiscount} off`
    : `🎯 ${redeem.nextMilestone} more pts to unlock ₹${REDEEM_VALUE} off`;

  return `${tierLine}\n${pointsLine}\n${redeemLine}`;
}

module.exports = {
  getRecord,
  getPoints,
  addPoints,
  redeemPoints,
  getRedeemInfo,
  calcOrderPoints,
  isFirstOrder,
  getTier,
  getSummaryText,
  REDEEM_THRESHOLD,
  REDEEM_VALUE,
};
