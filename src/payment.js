// ── Payment Module — Razorpay Payment Links ────────────────────────────────────
// Creates payment links and verifies payment status
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");

const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID     || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

// Track payment links (in production: use DB)
const paymentLinks = new Map();

// ── Create Razorpay payment link ──────────────────────────────────────────────
async function createLink({ amount, customerName, mobile, description }) {
  if (!RAZORPAY_KEY_ID) {
    // Mock for development
    const mockId  = `mock_${Date.now()}`;
    const mockUrl = `https://rzp.io/mock/${mockId}`;
    paymentLinks.set(mockId, { status: "created", amount, mockId });
    console.log(`[Payment MOCK] Link: ${mockUrl} for ₹${amount}`);
    return { id: mockId, url: mockUrl, amount };
  }

  const body = JSON.stringify({
    amount      : amount * 100,             // Razorpay uses paise
    currency    : "INR",
    description,
    customer    : {
      name : customerName,
      contact: `+91${mobile}`,
    },
    notify: { sms: true, email: false },
    reminder_enable: true,
    expire_by: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
    callback_url   : `${process.env.SERVER_URL}/webhook/payment`,
    callback_method: "get",
  });

  return new Promise((resolve, reject) => {
    const auth    = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const options = {
      hostname: "api.razorpay.com",
      path    : "/v1/payment_links",
      method  : "POST",
      headers : {
        "Authorization": `Basic ${auth}`,
        "Content-Type" : "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.short_url) {
            paymentLinks.set(parsed.id, parsed);
            resolve({ id: parsed.id, url: parsed.short_url, amount });
          } else {
            console.error("[Razorpay]", parsed);
            reject(new Error("Failed to create payment link"));
          }
        } catch (err) { reject(err); }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Verify if payment is completed ───────────────────────────────────────────
async function verify(orderId) {
  if (!RAZORPAY_KEY_ID) {
    // In mock mode, simulate 50% chance of payment (for testing)
    // In real usage: check your actual payment status
    console.log(`[Payment MOCK] Simulating payment check for order ${orderId}`);
    return true;
  }

  // In production: check Razorpay API for payment status
  // You'd store the payment_link_id with the order and check its status
  return false;
}

// ── Handle Razorpay callback (payment success webhook) ───────────────────────
function handleCallback(req, res) {
  const { razorpay_payment_id, razorpay_payment_link_id, razorpay_payment_link_status } = req.query;

  if (razorpay_payment_link_status === "paid") {
    // Update order status — emit event for server to handle
    console.log(`[Payment] Link ${razorpay_payment_link_id} paid — payment ${razorpay_payment_id}`);
    // TODO: emit event to update order + notify customer
  }

  res.redirect(`${process.env.SUCCESS_URL || "/"}`);
}

module.exports = { createLink, verify, handleCallback };
