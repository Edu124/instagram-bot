// ── Customer Base Tracker — Supabase backed ───────────────────────────────────
// Tracks every customer who came through the bot
// Gives full visibility: source, spend, orders, referrals, last active
// ─────────────────────────────────────────────────────────────────────────────
const supabase = require("./db");

// ── Register or update customer ───────────────────────────────────────────────
async function touch(customerId, data = {}) {
  const { data: existing } = await supabase
    .from("bot_customers").select("*").eq("id", customerId).maybeSingle();

  if (!existing) {
    const customer = {
      id               : customerId,
      name             : data.name        || data.first_name || "Unknown",
      first_name       : data.first_name  || "",
      last_name        : data.last_name   || "",
      mobile           : data.mobile      || null,
      source           : "instagram_bot",
      referred_by      : data.referredBy  || null,
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
    const { data: row, error } = await supabase
      .from("bot_customers").insert(customer).select().single();
    if (error) { console.error("[Customers] touch (new) error:", error.message); return _toCustomer(customer); }
    return _toCustomer(row);
  }

  // Existing customer — update last active + any new data
  const updates = { last_active_at: Date.now() };
  if (data.mobile && !existing.mobile)                    updates.mobile = data.mobile;
  if (data.name   && existing.name === "Unknown")         updates.name   = data.name;

  const { data: updated, error } = await supabase
    .from("bot_customers").update(updates).eq("id", customerId).select().single();
  if (error) { console.error("[Customers] touch (update) error:", error.message); return _toCustomer(existing); }
  return _toCustomer(updated);
}

// ── Record a completed order ──────────────────────────────────────────────────
async function recordOrder(customerId, order) {
  const { data: existing } = await supabase
    .from("bot_customers").select("*").eq("id", customerId).maybeSingle();
  if (!existing) return;

  const totalOrders = (existing.total_orders  || 0) + 1;
  const totalSpend  = (existing.total_spend   || 0) + (order.bill?.total || 0);
  const orderIds    = [...(existing.order_ids || []), order.id];
  const tags        = [...(existing.tags      || [])];

  // Auto-tag VIP (3+ orders or ₹3000+ spend)
  if (totalOrders >= 3 || totalSpend >= 3000) {
    if (!tags.includes("vip")) tags.push("vip");
  }
  // Tag frequent buyers (5+ orders)
  if (totalOrders >= 5) {
    if (!tags.includes("frequent")) tags.push("frequent");
  }

  await supabase.from("bot_customers").update({
    total_orders  : totalOrders,
    total_spend   : totalSpend,
    last_active_at: Date.now(),
    order_ids     : orderIds,
    mobile        : existing.mobile || order.mobile || null,
    tags,
  }).eq("id", customerId);

  // Credit referral earnings to referrer
  if (existing.referred_by) {
    await creditReferral(existing.referred_by, order.bill?.total || 0);
  }
}

// ── Credit referral commission ────────────────────────────────────────────────
async function creditReferral(referralCode, orderAmount) {
  const commission = Math.round(orderAmount * 0.05); // 5% commission
  const { data: referrer } = await supabase
    .from("bot_customers").select("*")
    .eq("referral_code", referralCode).maybeSingle();
  if (!referrer) return null;

  const tags = [...(referrer.tags || [])];
  if (!tags.includes("referrer")) tags.push("referrer");

  await supabase.from("bot_customers").update({
    referral_count   : (referrer.referral_count    || 0) + 1,
    referral_earnings: (referrer.referral_earnings || 0) + commission,
    tags,
  }).eq("id", referrer.id);

  return { customerId: referrer.id, commission };
}

// ── Get single customer ───────────────────────────────────────────────────────
async function get(customerId) {
  const { data } = await supabase
    .from("bot_customers").select("*").eq("id", customerId).maybeSingle();
  return data ? _toCustomer(data) : null;
}

// ── Get all customers ─────────────────────────────────────────────────────────
async function getAll({ tag, sortBy = "last_active_at", page = 1, limit = 20 } = {}) {
  const { data, error, count } = await supabase
    .from("bot_customers")
    .select("*", { count: "exact" })
    .order(sortBy, { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (error) { console.error("[Customers] getAll error:", error.message); return { customers: [], total: 0, page }; }

  let list = (data || []).map(_toCustomer);
  if (tag) list = list.filter(c => c.tags.includes(tag));

  return { customers: list, total: count || 0, page };
}

// ── Find customer by referral code ────────────────────────────────────────────
async function getByReferralCode(code) {
  const { data } = await supabase
    .from("bot_customers").select("*").eq("referral_code", code).maybeSingle();
  return data ? _toCustomer(data) : null;
}

// ── Dashboard stats ───────────────────────────────────────────────────────────
async function getStats() {
  const { data: all, error } = await supabase
    .from("bot_customers").select("*");
  if (error) { console.error("[Customers] getStats error:", error.message); return { total:0 }; }

  const list  = (all || []).map(_toCustomer);
  const now   = Date.now();
  const day   = 24 * 60 * 60 * 1000;
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
    bySource         : list.reduce((acc, c) => {
      acc[c.source] = (acc[c.source] || 0) + 1;
      return acc;
    }, {}),
  };
}

// ── Generate referral code from name ─────────────────────────────────────────
function generateReferralCode(nameOrId) {
  const base   = String(nameOrId).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `${base}${suffix}`;
}

// ── Map DB row → app customer shape ──────────────────────────────────────────
function _toCustomer(row) {
  return {
    id               : row.id,
    name             : row.name             || "Unknown",
    firstName        : row.first_name       || "",
    lastName         : row.last_name        || "",
    mobile           : row.mobile           || null,
    source           : row.source           || "instagram_bot",
    referredBy       : row.referred_by      || null,
    referralCode     : row.referral_code    || "",
    referralCount    : row.referral_count   || 0,
    referralEarnings : row.referral_earnings || 0,
    totalOrders      : row.total_orders     || 0,
    totalSpend       : row.total_spend      || 0,
    firstSeenAt      : row.first_seen_at    || 0,
    lastActiveAt     : row.last_active_at   || 0,
    orderIds         : row.order_ids        || [],
    tags             : row.tags             || [],
    createdAt        : row.created_at ? new Date(row.created_at).getTime() : 0,
  };
}

module.exports = { touch, recordOrder, creditReferral, get, getAll, getByReferralCode, getStats };
