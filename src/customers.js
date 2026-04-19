// ── Customer Base Tracker ──────────────────────────────────────────────────────
// Tracks every customer who came through the bot separately
// Gives full visibility: source, spend, orders, referrals, last active
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

let customers = new Map(); // customerId → customer object

// ── Register or update customer ───────────────────────────────────────────────
function touch(customerId, data = {}) {
  const existing = customers.get(customerId);

  if (!existing) {
    // New customer — register them
    const customer = {
      id           : customerId,
      name         : data.name        || data.first_name || "Unknown",
      firstName    : data.first_name  || "",
      lastName     : data.last_name   || "",
      mobile       : data.mobile      || null,
      source       : "instagram_bot",          // always bot — this tracker is bot-only
      referredBy   : data.referredBy  || null, // referral code used
      referralCode : generateReferralCode(data.first_name || customerId),
      referralCount: 0,                        // how many customers they referred
      referralEarnings: 0,                     // total ₹ earned from referrals
      totalOrders  : 0,
      totalSpend   : 0,
      firstSeenAt  : Date.now(),
      lastActiveAt : Date.now(),
      orderIds     : [],
      tags         : [],                       // e.g. "vip", "frequent", "inactive"
    };
    customers.set(customerId, customer);
    persist();
    return customer;
  }

  // Existing customer — update last active + any new data
  const updated = {
    ...existing,
    lastActiveAt: Date.now(),
    ...(data.mobile && !existing.mobile ? { mobile: data.mobile } : {}),
    ...(data.name   && existing.name === "Unknown" ? { name: data.name } : {}),
  };
  customers.set(customerId, updated);
  return updated;
}

// ── Record a completed order ──────────────────────────────────────────────────
function recordOrder(customerId, order) {
  const customer = customers.get(customerId);
  if (!customer) return;

  customer.totalOrders   += 1;
  customer.totalSpend    += order.bill?.total || 0;
  customer.lastActiveAt   = Date.now();
  customer.orderIds       = [...(customer.orderIds || []), order.id];
  customer.mobile         = customer.mobile || order.mobile;

  // Auto-tag VIP customers (3+ orders or ₹3000+ spend)
  if (customer.totalOrders >= 3 || customer.totalSpend >= 3000) {
    if (!customer.tags.includes("vip")) customer.tags.push("vip");
  }
  // Tag frequent buyers (5+ orders)
  if (customer.totalOrders >= 5) {
    if (!customer.tags.includes("frequent")) customer.tags.push("frequent");
  }

  customers.set(customerId, customer);

  // Credit referral earnings to referrer
  if (customer.referredBy) {
    creditReferral(customer.referredBy, order.bill?.total || 0);
  }

  persist();
}

// ── Credit referral commission ────────────────────────────────────────────────
function creditReferral(referralCode, orderAmount) {
  const commission = Math.round(orderAmount * 0.05); // 5% commission
  for (const [id, c] of customers) {
    if (c.referralCode === referralCode) {
      c.referralCount    += 1;
      c.referralEarnings += commission;
      if (!c.tags.includes("referrer")) c.tags.push("referrer");
      customers.set(id, c);
      persist();
      return { customerId: id, commission };
    }
  }
  return null;
}

// ── Get single customer ───────────────────────────────────────────────────────
function get(customerId) {
  return customers.get(customerId) || null;
}

// ── Get all customers ─────────────────────────────────────────────────────────
function getAll({ tag, sortBy = "lastActiveAt", page = 1, limit = 20 } = {}) {
  let list = Array.from(customers.values());

  if (tag) list = list.filter(c => c.tags.includes(tag));

  list.sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0));

  return {
    customers: list.slice((page - 1) * limit, page * limit),
    total    : list.length,
    page,
  };
}

// ── Find customer by referral code ────────────────────────────────────────────
function getByReferralCode(code) {
  for (const [, c] of customers) {
    if (c.referralCode === code) return c;
  }
  return null;
}

// ── Dashboard stats ───────────────────────────────────────────────────────────
function getStats() {
  const list    = Array.from(customers.values());
  const now     = Date.now();
  const day     = 24 * 60 * 60 * 1000;
  const week    = 7 * day;
  const month   = 30 * day;

  return {
    // Volume
    total        : list.length,
    newToday     : list.filter(c => now - c.firstSeenAt < day).length,
    newThisWeek  : list.filter(c => now - c.firstSeenAt < week).length,
    newThisMonth : list.filter(c => now - c.firstSeenAt < month).length,
    activeToday  : list.filter(c => now - c.lastActiveAt < day).length,

    // Revenue from bot customers only
    totalRevenue : list.reduce((s, c) => s + c.totalSpend, 0),
    avgOrderValue: list.length
      ? Math.round(list.reduce((s, c) => s + c.totalSpend, 0) / list.length)
      : 0,

    // Referral engine stats
    referralCustomers : list.filter(c => c.referredBy).length,
    totalReferrals    : list.reduce((s, c) => s + c.referralCount, 0),
    topReferrers      : list
      .filter(c => c.referralCount > 0)
      .sort((a, b) => b.referralCount - a.referralCount)
      .slice(0, 5)
      .map(c => ({ name: c.name, code: c.referralCode, referrals: c.referralCount, earnings: c.referralEarnings })),

    // Segments
    vipCount      : list.filter(c => c.tags.includes("vip")).length,
    frequentCount : list.filter(c => c.tags.includes("frequent")).length,

    // Source breakdown (always bot here, but ready for multi-channel)
    bySource: list.reduce((acc, c) => {
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

// ── Persist / Load ────────────────────────────────────────────────────────────
function persist() {
  const dir      = path.join(__dirname, "../data");
  const filePath = path.join(dir, "customers.json");
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const arr = Array.from(customers.values());
    fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
  } catch (err) {
    console.error("[Customers] Persist error:", err.message);
  }
}

function loadFromFile() {
  const filePath = path.join(__dirname, "../data/customers.json");
  try {
    const arr = JSON.parse(fs.readFileSync(filePath, "utf8"));
    arr.forEach(c => customers.set(c.id, c));
    console.log(`[Customers] Loaded ${customers.size} bot customers`);
  } catch {
    console.log("[Customers] No customers file found, starting fresh");
  }
}

loadFromFile();

module.exports = { touch, recordOrder, creditReferral, get, getAll, getByReferralCode, getStats };
