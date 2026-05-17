// ── Customer Base Tracker — Supabase backed ───────────────────────────────────
const { supabaseAdmin } = require("./supabase");

const DEFAULT_BID = process.env.BUSINESS_ID || "default";

function generateReferralCode(name = "") {
  return (name.slice(0, 4).toUpperCase() || "REF") + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// ── Register or update customer ───────────────────────────────────────────────
async function touch(customerId, data = {}, businessId = DEFAULT_BID) {
  try {
    const { data: existing } = await supabaseAdmin
      .from("bot_customers")
      .select("*")
      .eq("id", customerId)
      .eq("business_id", businessId)
      .single();

    if (!existing) {
      const customer = {
        id               : customerId,
        business_id      : businessId,
        name             : data.name       || data.first_name || "Unknown",
        first_name       : data.first_name || "",
        last_name        : data.last_name  || "",
        mobile           : data.mobile     || null,
        source           : "whatsapp",
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
      const { data: result } = await supabaseAdmin
        .from("bot_customers")
        .insert(customer)
        .select()
        .single();
      return _toCustomer(result || customer);
    }

    // Existing customer — update last active + any new data
    const updates = { last_active_at: Date.now() };
    if (data.mobile && !existing.mobile) updates.mobile = data.mobile;
    if (data.name   && existing.name === "Unknown") updates.name = data.name;

    const { data: result } = await supabaseAdmin
      .from("bot_customers")
      .update(updates)
      .eq("id", customerId)
      .eq("business_id", businessId)
      .select()
      .single();
    return _toCustomer(result || existing);
  } catch (e) {
    console.error("[Customers] touch error:", e.message);
    return null;
  }
}

// ── Record a completed order ──────────────────────────────────────────────────
async function recordOrder(customerId, order, businessId = DEFAULT_BID) {
  try {
    const { data: existing } = await supabaseAdmin
      .from("bot_customers")
      .select("*")
      .eq("id", customerId)
      .eq("business_id", businessId)
      .single();

    if (!existing) return;

    const totalOrders = (existing.total_orders  || 0) + 1;
    const totalSpend  = (existing.total_spend   || 0) + (order.bill?.total || 0);
    const orderIds    = [...(existing.order_ids || []), order.id];
    const tags        = [...(existing.tags      || [])];

    if (totalOrders >= 3 || totalSpend >= 3000) { if (!tags.includes("vip"))      tags.push("vip"); }
    if (totalOrders >= 5)                        { if (!tags.includes("frequent")) tags.push("frequent"); }

    await supabaseAdmin
      .from("bot_customers")
      .update({
        total_orders  : totalOrders,
        total_spend   : totalSpend,
        last_active_at: Date.now(),
        order_ids     : orderIds,
        mobile        : order.mobile || existing.mobile || null,
        tags,
      })
      .eq("id", customerId)
      .eq("business_id", businessId);

    if (existing.referred_by) {
      await creditReferral(existing.referred_by, order.bill?.total || 0, businessId);
    }
  } catch (e) {
    console.error("[Customers] recordOrder error:", e.message);
  }
}

// ── Credit referral commission ────────────────────────────────────────────────
async function creditReferral(referralCode, orderAmount, businessId = DEFAULT_BID) {
  const commission = Math.round(orderAmount * 0.05);
  try {
    const { data: referrer } = await supabaseAdmin
      .from("bot_customers")
      .select("*")
      .eq("referral_code", referralCode)
      .eq("business_id", businessId)
      .single();
    if (!referrer) return null;

    const tags = [...(referrer.tags || [])];
    if (!tags.includes("referrer")) tags.push("referrer");

    await supabaseAdmin
      .from("bot_customers")
      .update({
        referral_count   : (referrer.referral_count    || 0) + 1,
        referral_earnings: (referrer.referral_earnings || 0) + commission,
        tags,
      })
      .eq("id", referrer.id)
      .eq("business_id", businessId);

    return { customerId: referrer.id, commission };
  } catch (e) {
    console.error("[Customers] creditReferral error:", e.message);
    return null;
  }
}

// ── Get single customer ───────────────────────────────────────────────────────
async function get(customerId, businessId = DEFAULT_BID) {
  try {
    const { data } = await supabaseAdmin
      .from("bot_customers")
      .select("*")
      .eq("id", customerId)
      .eq("business_id", businessId)
      .single();
    return data ? _toCustomer(data) : null;
  } catch (e) {
    console.error("[Customers] get error:", e.message);
    return null;
  }
}

// ── Get all customers ─────────────────────────────────────────────────────────
async function getAll({ tag, sortBy = "last_active_at", page = 1, limit = 20, businessId = DEFAULT_BID } = {}) {
  try {
    const safeCols = ["last_active_at", "total_spend", "total_orders", "first_seen_at"];
    const col      = safeCols.includes(sortBy) ? sortBy : "last_active_at";

    const { data, error, count } = await supabaseAdmin
      .from("bot_customers")
      .select("*", { count: "exact" })
      .eq("business_id", businessId)
      .order(col, { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;
    let list = (data || []).map(_toCustomer);
    if (tag) list = list.filter(c => c.tags.includes(tag));
    return { customers: list, total: count || 0, page };
  } catch (e) {
    console.error("[Customers] getAll error:", e.message);
    return { customers: [], total: 0, page };
  }
}

// ── Find customer by referral code ────────────────────────────────────────────
async function getByReferralCode(code, businessId = DEFAULT_BID) {
  try {
    const { data } = await supabaseAdmin
      .from("bot_customers")
      .select("*")
      .eq("referral_code", code)
      .eq("business_id", businessId)
      .single();
    return data ? _toCustomer(data) : null;
  } catch (e) {
    console.error("[Customers] getByReferralCode error:", e.message);
    return null;
  }
}

// ── Dashboard stats ───────────────────────────────────────────────────────────
async function getStats(businessId = DEFAULT_BID) {
  try {
    const { data } = await supabaseAdmin
      .from("bot_customers")
      .select("*")
      .eq("business_id", businessId);
    const list  = (data || []).map(_toCustomer);
    const now   = Date.now();
    const week  = 7  * 86400000;
    const month = 30 * 86400000;
    return {
      total    : list.length,
      newWeek  : list.filter(c => now - (c.lastActiveAt || 0) < week).length,
      newMonth : list.filter(c => now - (c.lastActiveAt || 0) < month).length,
      vip      : list.filter(c => c.tags.includes("vip")).length,
    };
  } catch (e) {
    console.error("[Customers] getStats error:", e.message);
    return { total: 0, newWeek: 0, newMonth: 0, vip: 0 };
  }
}

// ── Map DB row → customer shape ───────────────────────────────────────────────
function _toCustomer(row) {
  return {
    id               : row.id,
    name             : row.name             || "",
    firstName        : row.first_name       || "",
    lastName         : row.last_name        || "",
    mobile           : row.mobile           || null,
    source           : row.source           || "whatsapp",
    referredBy       : row.referred_by      || null,
    referralCode     : row.referral_code    || "",
    referralCount    : row.referral_count   || 0,
    referralEarnings : row.referral_earnings || 0,
    totalOrders      : row.total_orders     || 0,
    totalSpend       : Number(row.total_spend) || 0,
    firstSeenAt      : row.first_seen_at,
    lastActiveAt     : row.last_active_at,
    orderIds         : row.order_ids        || [],
    tags             : row.tags             || [],
  };
}

// ── Bulk import contacts (phone book / manual CSV) ────────────────────────────
// Single Supabase upsert instead of N sequential SELECT+INSERT calls.
// ignoreDuplicates keeps existing bot customers intact (their order history, tags etc.)
async function bulkImport(contacts, businessId = DEFAULT_BID) {
  const rows = contacts
    .map(({ name, phone }) => {
      const digits = (phone || "").replace(/[^0-9]/g, "");
      // Normalise to WhatsApp ID format: Indian 10-digit numbers get 91 prefix
      // so imported contacts match the IDs the bot assigns when they message in.
      const id = digits.length === 10 ? "91" + digits : digits;
      if (id.length < 10) return null;
      return {
        id,
        business_id      : businessId,
        name             : (name || "").trim() || "Contact",
        source           : "manual_import",
        referral_code    : ((name || "").slice(0, 4).toUpperCase() || "REF") + Math.random().toString(36).slice(2, 6).toUpperCase(),
        referral_count   : 0,
        referral_earnings: 0,
        total_orders     : 0,
        total_spend      : 0,
        first_seen_at    : Date.now(),
        last_active_at   : Date.now(),
        order_ids        : [],
        tags             : [],
      };
    })
    .filter(Boolean);

  const skipped = contacts.length - rows.length;
  if (!rows.length) return { imported: 0, skipped };

  const { error } = await supabaseAdmin
    .from("bot_customers")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });

  if (error) throw new Error(error.message);
  return { imported: rows.length, skipped };
}

module.exports = { touch, recordOrder, creditReferral, get, getAll, getByReferralCode, getStats, bulkImport };
