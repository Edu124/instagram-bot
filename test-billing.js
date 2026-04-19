// Billing system tests — run from: D:\offlineai\instagram-bot
const http = require("http");
const { calculate } = require("./src/commission");
let pass = 0, fail = 0;

function api(method, path, body) {
  return new Promise((ok, rej) => {
    const b = body ? JSON.stringify(body) : "";
    const req = http.request({
      host:"localhost", port:3000, path, method,
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(b)}
    }, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { ok(JSON.parse(d)); } catch { ok({ _raw: d.slice(0,40) }); } });
    });
    req.on("error", rej);
    if (b) req.write(b);
    req.end();
  });
}

function check(n, c) {
  if (c) { console.log("  ✅", n); pass++; }
  else   { console.log("  ❌", n); fail++; }
}

(async () => {
  let c, r;

  console.log("── Commission math ──");
  c = calculate([{name:"Silk Saree",price:1500}], "flash_sale");
  check("Flash ₹1500 → ₹75",              c.eligible && c.commissionAmount === 75);
  c = calculate([{name:"Silk Saree",price:1500}], null);
  check("Organic order → ₹0",             !c.eligible);
  c = calculate([{name:"Kurti",price:549}], "flash_sale");
  check("Promo but <₹1000 → ₹0",          !c.eligible);
  c = calculate([{name:"Jeans",price:799},{name:"Lehenga",price:2499}], "new_arrival");
  check("Mixed: only counts ₹2499",        c.commissionAmount === Math.round(2499*0.05));
  check("Breakdown has 1 item",            c.breakdown.length === 1);
  c = calculate([{name:"Candle Set",price:1200}], "abandoned_cart");
  check("Abandoned cart ₹1200 → ₹60",     c.commissionAmount === 60);
  c = calculate([{name:"Kurti",price:549},{name:"Saree",price:1299}], "referral");
  check("Referral: only ₹1299 item",       c.commissionAmount === Math.round(1299*0.05));

  console.log("\n── Subscription API ──");
  r = await api("GET", "/api/billing/subscription", null);
  check("Status = trial or active",        r.status === "trial" || r.status === "active");
  check("isActive = true",                 r.isActive === true);
  check("monthlyFee = ₹3000",             r.monthlyFee === 3000);
  check("daysRemaining > 0",              r.daysRemaining > 0);

  console.log("\n── Commission recording (server-side) ──");
  r = await api("POST", "/api/billing/commissions/record",
    {orderId:8001, cart:[{name:"Silk Saree",price:1500}], promoSource:"flash_sale"});
  check("Flash ₹1500 recorded → ₹75",     r.ok && r.commissionAmount === 75);

  r = await api("POST", "/api/billing/commissions/record",
    {orderId:8002, cart:[{name:"Candle Set",price:1200}], promoSource:"abandoned_cart"});
  check("Abandoned ₹1200 recorded → ₹60", r.ok && r.commissionAmount === 60);

  r = await api("POST", "/api/billing/commissions/record",
    {orderId:8003, cart:[{name:"Cotton Kurti",price:549}], promoSource:"new_arrival"});
  check("Under ₹1000 → not eligible",     !r.eligible && r.commissionAmount === 0);

  console.log("\n── Billing summary ──");
  r = await api("GET", "/api/billing/summary", null);
  check("subscription block present",      !!r.subscription);
  check("billing block present",           !!r.billing);
  check("totalCommission >= ₹135",         r.billing.totalCommission >= 135);
  check("totalDue >= ₹3135",              r.billing.totalDue >= 3135);
  check("period label set",               !!r.billing.period);

  r = await api("GET", "/api/billing/commissions", null);
  check("Commissions list >= 2",           r.commissions.length >= 2);
  check("All entries have orderId",        r.commissions.every(c => c.orderId));

  console.log("\n── Payment recording → renews subscription ──");
  r = await api("POST", "/api/billing/payment",
    {amount:3000, paymentId:"pay_UPI001", method:"upi"});
  check("Payment accepted",               r.ok);
  check("Status = active",               r.subscription.status === "active");
  r = await api("GET", "/api/billing/subscription", null);
  check("isActive after payment",         r.isActive === true);
  check("Status = active after payment",  r.status === "active");

  console.log("\n════════════════════════════════════");
  console.log("  PASS:", pass, "  FAIL:", fail);
  if (fail === 0) console.log("  🎉 ALL BILLING TESTS PASSING!");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
