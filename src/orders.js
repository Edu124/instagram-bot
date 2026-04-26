// ── Order Manager — Supabase backed ───────────────────────────────────────────
const supabase = require("./db");

const DEFAULT_BID = process.env.BUSINESS_ID || "default";

// ── Create order ──────────────────────────────────────────────────────────────
async function create(data) {
  const row = {
    id             : Date.now().toString(),
    business_id    : DEFAULT_BID,
    customer_id    : data.customerId,
    name           : data.name           || "",
    cart           : data.cart           || [],
    address        : data.address        || "",
    mobile         : data.mobile         || "",
    bill           : data.bill           || {},
    pay_link       : data.payLink        || null,
    payment_mode   : data.paymentMode    || "cod",
    status         : data.status         || "pending_payment",
    status_dates   : { [data.status || "pending_payment"]: new Date().toLocaleDateString("en-IN") },
    tracking_number: null,
    tracking_url   : null,
    source         : "whatsapp",
    promo_source   : data.promoSource    || null,
    commission     : data.commission     || 0,
  };

  const { data: result, error } = await supabase
    .from("orders").insert(row).select().single();
  if (error) { console.error("[Orders] create error:", error.message); return _toOrder(row); }
  return _toOrder(result);
}

// ── Get order by ID ───────────────────────────────────────────────────────────
async function get(orderId) {
  const { data } = await supabase
    .from("orders").select("*")
    .eq("id", String(orderId))
    .maybeSingle();
  return data ? _toOrder(data) : null;
}

// ── Get all orders for a customer ─────────────────────────────────────────────
async function getByCustomer(customerId) {
  const { data, error } = await supabase
    .from("orders").select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });
  if (error) { console.error("[Orders] getByCustomer error:", error.message); return []; }
  return (data || []).map(_toOrder);
}

// ── Get all orders (for business dashboard) ───────────────────────────────────
async function getAll({ status, page = 1, limit = 20 } = {}) {
  let query = supabase
    .from("orders").select("*", { count: "exact" })
    .eq("business_id", DEFAULT_BID)
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) { console.error("[Orders] getAll error:", error.message); return { orders: [], total: 0, page }; }
  return {
    orders: (data || []).map(_toOrder),
    total : count || 0,
    page,
  };
}

// ── Update order status ───────────────────────────────────────────────────────
// Status flow: pending_payment → confirmed → packed → shipped → out_for_delivery → delivered
async function updateStatus(orderId, status, extra = {}) {
  const existing = await get(orderId);
  if (!existing) return null;

  const statusDates = {
    ...(existing.statusDates || {}),
    [status]: new Date().toLocaleDateString("en-IN"),
  };

  const changes = {
    status,
    status_dates: statusDates,
    updated_at  : new Date().toISOString(),
  };
  if (extra.trackingNumber) changes.tracking_number = extra.trackingNumber;
  if (extra.trackingUrl)    changes.tracking_url    = extra.trackingUrl;

  const { data, error } = await supabase
    .from("orders").update(changes)
    .eq("id", String(orderId)).select().single();
  if (error) { console.error("[Orders] updateStatus error:", error.message); return null; }
  return _toOrder(data);
}

// ── Set payment link on an order ──────────────────────────────────────────────
async function updatePayLink(orderId, payLink) {
  const { data, error } = await supabase
    .from("orders").update({ pay_link: payLink })
    .eq("id", String(orderId)).select().single();
  if (error) { console.error("[Orders] updatePayLink error:", error.message); return null; }
  return _toOrder(data);
}

// ── Update tracking info ──────────────────────────────────────────────────────
async function updateTracking(orderId, trackingNumber, trackingUrl) {
  return updateStatus(orderId, "shipped", { trackingNumber, trackingUrl });
}

// ── Get stats for dashboard ───────────────────────────────────────────────────
async function getStats() {
  const today = new Date().toDateString();
  const { data: all, error } = await supabase
    .from("orders").select("*").eq("business_id", DEFAULT_BID);
  if (error) { console.error("[Orders] getStats error:", error.message); return { total:0, pending:0, confirmed:0, shipped:0, delivered:0, todayRevenue:0, totalRevenue:0 }; }

  const rows = (all || []).map(_toOrder);
  return {
    total        : rows.length,
    pending      : rows.filter(o => o.status === "pending_payment").length,
    confirmed    : rows.filter(o => o.status === "confirmed").length,
    shipped      : rows.filter(o => o.status === "shipped").length,
    delivered    : rows.filter(o => o.status === "delivered").length,
    todayRevenue : rows
      .filter(o => new Date(o.createdAt).toDateString() === today && o.status !== "pending_payment")
      .reduce((sum, o) => sum + (o.bill?.total || 0), 0),
    totalRevenue : rows
      .filter(o => o.status !== "pending_payment" && o.status !== "cancelled")
      .reduce((sum, o) => sum + (o.bill?.total || 0), 0),
  };
}

// ── Map DB row → app order shape ──────────────────────────────────────────────
function _toOrder(row) {
  return {
    id             : row.id,
    customerId     : row.customer_id,
    name           : row.name            || "",
    cart           : row.cart            || [],
    address        : row.address         || "",
    mobile         : row.mobile          || "",
    bill           : row.bill            || {},
    payLink        : row.pay_link        || null,
    paymentMode    : row.payment_mode    || "cod",
    status         : row.status          || "pending_payment",
    statusDates    : row.status_dates    || {},
    trackingNumber : row.tracking_number || null,
    trackingUrl    : row.tracking_url    || null,
    source         : row.source          || "whatsapp",
    promoSource    : row.promo_source    || null,
    commission     : row.commission      || 0,
    createdAt      : row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt      : row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

module.exports = { create, get, getByCustomer, getAll, updateStatus, updatePayLink, updateTracking, getStats };
