// ── Shiprocket + Delhivery Tracking ───────────────────────────────────────────
// Uses Node 18+ built-in fetch — no extra dependencies needed
// ─────────────────────────────────────────────────────────────────────────────

let _srToken       = null;
let _srTokenExpiry = 0;

// ── Shiprocket ────────────────────────────────────────────────────────────────
async function getShiprocketToken(email, password) {
  if (_srToken && Date.now() < _srTokenExpiry) return _srToken;
  try {
    const res = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ email, password }),
      signal : AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data  = await res.json();
    _srToken       = data.token;
    _srTokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
    return _srToken;
  } catch (e) {
    console.error("[Tracking] Shiprocket login error:", e.message);
    return null;
  }
}

async function trackShiprocket(awb, email, password) {
  if (!email || !password) return null;
  const token = await getShiprocketToken(email, password);
  if (!token) return null;
  try {
    const res = await fetch(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal : AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return null;
    const r  = await res.json();
    const td = r?.tracking_data;
    if (!td) return null;
    const track = td.shipment_track?.[0] || {};
    return {
      awb,
      carrier      : track.courier_name || "Shiprocket",
      status       : td.shipment_status  || "unknown",
      statusText   : track.current_status || td.shipment_status || "",
      estimatedDate: track.etd            || "",
      events       : (td.shipment_track_activities || []).slice(0, 6).map(e => ({
        status  : e.status   || "",
        location: e.location || "",
        date    : e.date     || "",
      })),
    };
  } catch (e) {
    console.error("[Tracking] Shiprocket track error:", e.message);
    return null;
  }
}

// ── Delhivery ─────────────────────────────────────────────────────────────────
async function trackDelhivery(awb, apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://track.delhivery.com/api/v1/packages/json/?waybill=${awb}`,
      {
        headers: { Authorization: `Token ${apiKey}` },
        signal : AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return null;
    const r   = await res.json();
    const pkg = r?.ShipmentData?.[0]?.Shipment;
    if (!pkg) return null;
    return {
      awb,
      carrier      : "Delhivery",
      status       : pkg.Status?.Status    || "unknown",
      statusText   : pkg.Status?.StatusType || pkg.Status?.Status || "",
      estimatedDate: pkg.ExpectedDeliveryDate || "",
      events       : (pkg.Scans || []).slice(0, 6).map(e => ({
        status  : e.ScanDetail?.Scan            || "",
        location: e.ScanDetail?.ScannedLocation || "",
        date    : e.ScanDetail?.ScanDateTime    || "",
      })),
    };
  } catch (e) {
    console.error("[Tracking] Delhivery track error:", e.message);
    return null;
  }
}

// ── Unified tracker ───────────────────────────────────────────────────────────
async function track(awb, carrier, credentials = {}) {
  if (!awb) return null;
  const c = (carrier || "").toLowerCase();
  if (c === "delhivery") return trackDelhivery(awb, credentials.delhiveryApiKey);
  return trackShiprocket(awb, credentials.shiprocketEmail, credentials.shiprocketPassword);
}

// ── Map carrier status → Selly order status ───────────────────────────────────
function mapStatus(carrierStatus = "") {
  const s = carrierStatus.toLowerCase();
  if (s.includes("deliver"))                             return "delivered";
  if (s.includes("out for") || s.includes("out_for"))   return "out_for_delivery";
  if (s.includes("transit") || s.includes("dispatch") || s.includes("ship")) return "shipped";
  if (s.includes("picked") || s.includes("packed"))     return "packed";
  return null;
}

module.exports = { track, trackShiprocket, trackDelhivery, mapStatus };
