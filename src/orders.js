// ── Order Manager ──────────────────────────────────────────────────────────────
// Creates, updates and retrieves orders
// In production: use PostgreSQL / Supabase
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

let orders  = [];
let counter = 1000;

// ── Create order ──────────────────────────────────────────────────────────────
function create(data) {
  const order = {
    id          : ++counter,
    customerId  : data.customerId,
    name        : data.name,
    cart        : data.cart        || [],
    address     : data.address     || "",
    mobile      : data.mobile      || "",
    bill        : data.bill        || {},
    payLink     : data.payLink     || null,
    status      : data.status      || "pending_payment",
    statusDates : { [data.status || "pending_payment"]: new Date().toLocaleDateString("en-IN") },
    trackingNumber: null,
    trackingUrl   : null,
    source      : "instagram",
    promoSource : data.promoSource || null,   // flash_sale | new_arrival | abandoned_cart | referral | null
    commission  : data.commission  || 0,      // ₹ Selly commission on this order
    createdAt   : Date.now(),
    updatedAt   : Date.now(),
  };

  orders.push(order);
  persist();
  return order;
}

// ── Get order by ID ───────────────────────────────────────────────────────────
function get(orderId) {
  return orders.find(o => o.id === Number(orderId)) || null;
}

// ── Get all orders for a customer ─────────────────────────────────────────────
function getByCustomer(customerId) {
  return orders
    .filter(o => o.customerId === customerId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ── Get all orders (for business dashboard) ───────────────────────────────────
function getAll({ status, page = 1, limit = 20 } = {}) {
  let result = [...orders].sort((a, b) => b.createdAt - a.createdAt);
  if (status) result = result.filter(o => o.status === status);
  return {
    orders: result.slice((page - 1) * limit, page * limit),
    total : result.length,
    page,
  };
}

// ── Update order status ───────────────────────────────────────────────────────
// Status flow: pending_payment → confirmed → packed → shipped → out_for_delivery → delivered
function updateStatus(orderId, status, extra = {}) {
  const order = get(orderId);
  if (!order) return null;

  order.status = status;
  order.statusDates = {
    ...order.statusDates,
    [status]: new Date().toLocaleDateString("en-IN"),
  };

  if (extra.trackingNumber) order.trackingNumber = extra.trackingNumber;
  if (extra.trackingUrl)    order.trackingUrl    = extra.trackingUrl;
  order.updatedAt = Date.now();

  persist();
  return order;
}

// ── Update tracking info ──────────────────────────────────────────────────────
function updateTracking(orderId, trackingNumber, trackingUrl) {
  return updateStatus(orderId, "shipped", { trackingNumber, trackingUrl });
}

// ── Get stats for dashboard ───────────────────────────────────────────────────
function getStats() {
  const today = new Date().toDateString();

  return {
    total         : orders.length,
    pending       : orders.filter(o => o.status === "pending_payment").length,
    confirmed     : orders.filter(o => o.status === "confirmed").length,
    shipped       : orders.filter(o => o.status === "shipped").length,
    delivered     : orders.filter(o => o.status === "delivered").length,
    todayRevenue  : orders
      .filter(o => new Date(o.createdAt).toDateString() === today && o.status !== "pending_payment")
      .reduce((sum, o) => sum + (o.bill?.total || 0), 0),
    totalRevenue  : orders
      .filter(o => o.status !== "pending_payment" && o.status !== "cancelled")
      .reduce((sum, o) => sum + (o.bill?.total || 0), 0),
  };
}

// ── Persist to file (replace with DB in production) ──────────────────────────
function persist() {
  const dir      = path.join(__dirname, "../data");
  const filePath = path.join(dir, "orders.json");
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(orders, null, 2));
  } catch (err) {
    console.error("[Orders] Persist error:", err.message);
  }
}

// ── Load from file on startup ─────────────────────────────────────────────────
function loadFromFile() {
  const filePath = path.join(__dirname, "../data/orders.json");
  try {
    orders  = JSON.parse(fs.readFileSync(filePath, "utf8"));
    counter = Math.max(...orders.map(o => o.id), 1000);
    console.log(`[Orders] Loaded ${orders.length} orders`);
  } catch {
    console.log("[Orders] No orders file found, starting fresh");
  }
}

loadFromFile();

module.exports = { create, get, getByCustomer, getAll, updateStatus, updateTracking, getStats };
