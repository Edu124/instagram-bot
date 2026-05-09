// ── Order Manager — Supabase backed ──────────────────────────────────────────
const { supabaseAdmin } = require("./supabase");

const DEFAULT_BID = process.env.BUSINESS_ID || "default";

// ── Create order ──────────────────────────────────────────────────────────────
async function create(data, businessId = DEFAULT_BID) {
  const row = {
    id             : Date.now().toString(),
    business_id    : businessId,
    customer_id    : data.customerId    || null,
    name           : data.name          || "",
    cart           : data.cart          || [],
    address        : data.address       || "",
    mobile         : data.mobile        || "",
    bill           : data.bill          || {},
    pay_link       : data.payLink       || null,
    payment_mode   : data.paymentMode   || "cod",
    status         : data.status        || "pending_payment",
    status_dates   : { [data.status || "pending_payment"]: new Date().toLocaleDateString("en-IN") },
    tracking_number: null,
    tracking_url   : null,
    source         : "whatsapp",
    promo_source   : data.promoSource   || null,
    commission     : data.commission    || 0,
  };

  try {
    const { data: result, error } = await supabaseAdmin
      .from("orders")
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return _toOrder(result);
  } catch (e) {
    console.error("[Orders] create error:", e.message);
    return _toOrder(row);
  }
}

// ── Get order by ID ───────────────────────────────────────────────────────────
async function get(orderId) {
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("id", String(orderId))
      .single();
    if (error) return null;
    return _toOrder(data);
  } catch (e) {
    console.error("[Orders] get error:", e.message);
    return null;
  }
}

// ── Get all orders for a customer ─────────────────────────────────────────────
async function getByCustomer(customerId) {
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(_toOrder);
  } catch (e) {
    console.error("[Orders] getByCustomer error:", e.message);
    return [];
  }
}

// ── Get all orders (for business dashboard) ───────────────────────────────────
async function getAll({ status, page = 1, limit = 20, businessId = DEFAULT_BID } = {}) {
  try {
    let query = supabaseAdmin
      .from("orders")
      .select("*", { count: "exact" })
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (status) query = query.eq("status", status);

    const { data, error, count } = await query;
    if (error) throw error;
    return { orders: (data || []).map(_toOrder), total: count || 0, page };
  } catch (e) {
    console.error("[Orders] getAll error:", e.message);
    return { orders: [], total: 0, page };
  }
}

// ── Update order status ───────────────────────────────────────────────────────
async function updateStatus(orderId, status, extra = {}) {
  const existing = await get(orderId);
  if (!existing) return null;

  const statusDates = { ...(existing.statusDates || {}), [status]: new Date().toLocaleDateString("en-IN") };
  const updates = { status, status_dates: statusDates, updated_at: new Date().toISOString() };
  if (extra.trackingNumber) updates.tracking_number = extra.trackingNumber;
  if (extra.trackingUrl)    updates.tracking_url    = extra.trackingUrl;

  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .update(updates)
      .eq("id", String(orderId))
      .select()
      .single();
    if (error) throw error;
    return _toOrder(data);
  } catch (e) {
    console.error("[Orders] updateStatus error:", e.message);
    return null;
  }
}

// ── Set payment link on an order ──────────────────────────────────────────────
async function updatePayLink(orderId, payLink) {
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .update({ pay_link: payLink, updated_at: new Date().toISOString() })
      .eq("id", String(orderId))
      .select()
      .single();
    if (error) throw error;
    return _toOrder(data);
  } catch (e) {
    console.error("[Orders] updatePayLink error:", e.message);
    return null;
  }
}

// ── Update tracking info ──────────────────────────────────────────────────────
async function updateTracking(orderId, trackingNumber, trackingUrl) {
  return updateStatus(orderId, "shipped", { trackingNumber, trackingUrl });
}

// ── Get stats for dashboard ───────────────────────────────────────────────────
async function getStats(businessId = DEFAULT_BID) {
  const today = new Date().toDateString();
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("business_id", businessId);
    if (error) throw error;
    const all = (data || []).map(_toOrder);
    return {
      total        : all.length,
      pending      : all.filter(o => o.status === "pending_payment").length,
      confirmed    : all.filter(o => o.status === "confirmed").length,
      shipped      : all.filter(o => o.status === "shipped" || o.status === "in_progress").length,
      delivered    : all.filter(o => o.status === "delivered" || o.status === "completed").length,
      todayRevenue : all
        .filter(o => new Date(o.createdAt).toDateString() === today && o.status !== "pending_payment")
        .reduce((s, o) => s + (o.bill?.total || 0), 0),
      totalRevenue : all
        .filter(o => o.status !== "pending_payment" && o.status !== "cancelled")
        .reduce((s, o) => s + (o.bill?.total || 0), 0),
    };
  } catch (e) {
    console.error("[Orders] getStats error:", e.message);
    return { total: 0, pending: 0, confirmed: 0, shipped: 0, delivered: 0, todayRevenue: 0, totalRevenue: 0 };
  }
}

// ── Map DB row → app order shape ──────────────────────────────────────────────
function _toOrder(row) {
  return {
    id             : row.id,
    businessId     : row.business_id    || "",
    customerId     : row.customer_id,
    name           : row.name           || "",
    cart           : row.cart           || [],
    address        : row.address        || "",
    mobile         : row.mobile         || "",
    bill           : row.bill           || {},
    payLink        : row.pay_link       || null,
    paymentMode    : row.payment_mode   || "cod",
    status         : row.status         || "pending_payment",
    statusDates    : row.status_dates   || {},
    trackingNumber : row.tracking_number || null,
    trackingUrl    : row.tracking_url   || null,
    source         : row.source         || "whatsapp",
    promoSource    : row.promo_source   || null,
    commission     : row.commission     || 0,
    createdAt      : row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt      : row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

module.exports = { create, get, getByCustomer, getAll, updateStatus, updatePayLink, updateTracking, getStats };
