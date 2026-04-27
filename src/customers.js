// ── Customer Base Tracker — Railway PostgreSQL backed ─────────────────────────
const db = require("./db");

// ── Register or update customer ───────────────────────────────────────────────
async function touch(customerId, data = {}) {
  try {
    const { rows: existing } = await db.query(
      `SELECT * FROM bot_customers WHERE id = $1`,
      [customerId]
    );

    if (!existing.length) {
      const customer = {
        id               : customerId,
        name             : data.name       || data.first_name || "Unknown",
        first_name       : data.first_name || "",
        last_name        : data.last_name  || "",
        mobile           : data.mobile     || null,
        source           : "instagram_bot",
        referred_by      : data.referredBy || null,
        referral_code    : generateReferralCode(data.first_name || customerId),
        referral_count   : 0,
        referral_earnings: 0,
        total_orders     : 0,
        total_spend      : 0,
        first_seen_at    : Date.now(),
        last_active_at   : Date.now(),
        order_ids        : [],
        tags             : [],
      };
      const { rows } = await db.query(
        `INSERT INTO bot_customers
           (id, name, first_name, last_name, mobile, source, referred_by,
            referral_code, referral_count, referral_earnings, total_orders,
            total_spend, first_seen_at, last_active_at, order_ids, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          customer.id, customer.name, customer.first_name, customer.last_name,
          customer.mobile, customer.source, customer.referred_by, customer.referral_code,
          customer.referral_count, customer.referral_earnings, customer.total_orders,
          customer.total_spend, customer.first_seen_at, customer.last_active_at,
          JSON.stringify(customer.order_ids), JSON.stringify(customer.tags),
        ]
      );
      return _toCustomer(rows[0] || customer);
    }

    // Existing customer — update last active + any new data
    const cur     = existing[0];
    const updates = [`last_active_at=$1`];
    const vals    = [Date.now()];
    let i = 2;
    if (data.mobile && !cur.mobile)                { updates.push(`mobile=$${i++}`); vals.push(data.mobile); }
    if (data.name   && cur.name === "Unknown")     { updates.push(`name=$${i++}`);   vals.push(data.name); }

    vals.push(customerId);
    const { rows } = await db.query(
      `UPDATE bot_customers SET ${updates.join(", ")} WHERE id=$${i} RETURNING *`,
      vals
    );
    return _toCustomer(rows[0] || cur);
  } catch (e) {
    console.error("[Customers] touch error:", e.message);
    return null;
  }
}

// ── Record a completed order ──────────────────────────────────────────────────
async function recordOrder(customerId, order) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM bot_customers WHERE id = $1`,
      [customerId]
    );
    if (!rows.length) return;
    const existing = rows[0];

    const totalOrders = (existing.total_orders  || 0) + 1;
    const totalSpend  = (existing.total_spend   || 0) + (order.bill?.total || 0);
    const orderIds    = [...(existing.order_ids || []), order.id];
    const tags        = [...(existing.tags      || [])];

    if (totalOrders >= 3 || totalSpend >= 3000) { if (!tags.includes("vip"))      tags.push("vip"); }
    if (totalOrders >= 5)                        { if (!tags.includes("frequent")) tags.push("frequent"); }

    await db.query(
      `UPDATE bot_customers
       SET total_orders=$1, total_spend=$2, last_active_at=$3,
           order_ids=$4, mobile=COALESCE(mobile,$5), tags=$6
       WHERE id=$7`,
      [
        totalOrders, totalSpend, Date.now(),
        JSON.stringify(orderIds),
        order.mobile || existing.mobile || null,
        JSON.stringify(tags),
        customerId,
      ]
    );

    if (existing.referred_by) {
      await creditReferral(existing.referred_by, order.bill?.total || 0);
    }
  } catch (e) {
    console.error("[Customers] recordOrder error:", e.message);
  }
}

// ── Credit referral commission ────────────────────────────────────────────────
async function creditReferral(referralCode, orderAmount) {
  const commission = Math.round(orderAmount * 0.05);
  try {
    const { rows } = await db.query(
      `SELECT * FROM bot_customers WHERE referral_code = $1`,
      [referralCode]
    );
    if (!rows.length) return null;
    const referrer = rows[0];
    const tags = [...(referrer.tags || [])];
    if (!tags.includes("referrer")) tags.push("referrer");

    await db.query(
      `UPDATE bot_customers
       SET referral_count=$1, referral_earnings=$2, tags=$3
       WHERE id=$4`,
      [
        (referrer.referral_count    || 0) + 1,
        (referrer.referral_earnings || 0) + commission,
        JSON.stringify(tags),
        referrer.id,
      ]
    );
    return { customerId: referrer.id, commission };
  } catch (e) {
    console.error("[Customers] creditReferral error:", e.message);
    return null;
  }
}

// ── Get single customer ───────────────────────────────────────────────────────
async function get(customerId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM bot_customers WHERE id = $1`,
      [customerId]
    );
    return rows[0] ? _toCustomer(rows[0]) : null;
  } catch (e) {
    console.error("[Customers] get error:", e.message);
    return null;
  }
}

// ── Get all customers ─────────────────────────────────────────────────────────
async function getAll({ tag, sortBy = "last_active_at", page = 1, limit = 20 } = {}) {
  try {
    const safeCols = ["last_active_at", "total_spend", "total_orders", "created_at", "first_seen_at"];
    const col      = safeCols.includes(sortBy) ? sortBy : "last_active_at";

    const { rows } = await db.query(
      `SELECT * FROM bot_customers ORDER BY ${col} DESC LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit]
    );
    const { rows: cnt } = await db.query(`SELECT COUNT(*)::int AS total FROM bot_customers`);

    let list = rows.map(_toCustomer);
    if (tag) list = list.filter(c => c.tags.includes(tag));

    return { customers: list, total: cnt[0]?.total || 0, page };
  } catch (e) {
    console.error("[Customers] getAll error:", e.message);
    return { customers: [], total: 0, page };
  }
}

// ── Find customer by referral code ────────────────────────────────────────────
async function getByReferralCode(code) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM bot_customers WHERE referral_code = $1`,
      [code]
    );
    return rows[0] ? _toCustomer(rows[0]) : null;
  } catch (e) {
    console.error("[Customers] getByReferralCode error:", e.message);
    return null;
  }
}

// ── Dashboard stats ───────────────────────────────────────────────────────────
async function getStats() {
  try {
    const { rows } = await db.query(`SELECT * FROM bot_customers`);
    const list  = rows.map(_toCustomer);
    const now   = Date.now();
    const day   = 86400000;
    const week  = 7 * day;
    const month = 30 * day;

    return {
      total            : list.length,
      newToday         : list.filter(c => now - c.firstSeenAt  < day).length,
      newThisWeek      : list.filter(c => now - c.firstSeenAt  < week).length,
      newThisMonth     : list.filter(c => now - c.firstSeenAt  < month).length,
      activeToday      : list.filter(c => now - c.lastActiveAt < day).length,
      totalRevenue     : list.reduce((s, c) => s + c.totalSpend, 0),
      avgOrderValue    : list.length
        ? Math.round(list.reduce((s, c) => s + c.totalSpend, 0) / list.length)
        : 0,
      referralCustomers: list.filter(c => c.referredBy).length,
      totalReferrals   : list.reduce((s, c) => s + c.referralCount, 0),
      topReferrers     : list
        .filter(c => c.referralCount > 0)
        .sort((a, b) => b.referralCount - a.referralCount)
        .slice(0, 5)
        .map(c => ({ name: c.name, code: c.referralCode, referrals: c.referralCount, earnings: c.referralEarnings })),
      vipCount         : list.filter(c => c.tags.includes("vip")).length,
      frequentCount    : list.filter(c => c.tags.includes("frequent")).length,
      bySource         : list.reduce((acc, c) => { acc[c.source] = (acc[c.source] || 0) + 1; return acc; }, {}),
    };
  } catch (e) {
    console.error("[Customers] getStats error:", e.message);
    return { total: 0 };
  }
}

// ── Generate referral code ────────────────────────────────────────────────────
function generateReferralCode(nameOrId) {
  const base   = String(nameOrId).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `${base}${suffix}`;
}

// ── Map DB row → app customer shape ──────────────────────────────────────────
function _toCustomer(row) {
  return {
    id               : row.id,
    name             : row.name              || "Unknown",
    firstName        : row.first_name        || "",
    lastName         : row.last_name         || "",
    mobile           : row.mobile            || null,
    source           : row.source            || "instagram_bot",
    referredBy       : row.referred_by       || null,
    referralCode     : row.referral_code     || "",
    referralCount    : row.referral_count    || 0,
    referralEarnings : row.referral_earnings || 0,
    totalOrders      : row.total_orders      || 0,
    totalSpend       : row.total_spend       || 0,
    firstSeenAt      : row.first_seen_at     || 0,
    lastActiveAt     : row.last_active_at    || 0,
    orderIds         : row.order_ids         || [],
    tags             : row.tags              || [],
    createdAt        : row.created_at ? new Date(row.created_at).getTime() : 0,
  };
}

module.exports = { touch, recordOrder, creditReferral, get, getAll, getByReferralCode, getStats };
