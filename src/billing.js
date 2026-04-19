// ── Billing / Invoice Generator ────────────────────────────────────────────────
// Generates GST-compliant invoices — works offline (no server needed)
// ─────────────────────────────────────────────────────────────────────────────

const DELIVERY_CHARGE = 49;
const GST_RATE        = 5; // 5% GST for clothing

// ── Generate bill object ──────────────────────────────────────────────────────
function generate({ cart, address, mobile, name, businessGST, businessName, businessAddress }) {
  const items = cart.map(item => ({
    id      : item.id,
    name    : item.name,
    size    : item.selectedSize || null,
    price   : item.price,
    qty     : item.qty || 1,
    total   : item.price * (item.qty || 1),
  }));

  const subtotal  = items.reduce((sum, i) => sum + i.total, 0);
  const delivery  = subtotal >= 999 ? 0 : DELIVERY_CHARGE; // Free delivery above ₹999
  const gstBase   = subtotal;
  const gst       = Math.round(gstBase * GST_RATE / 100);
  const total     = subtotal + delivery + gst;
  const invoiceNo = `CF${Date.now().toString().slice(-8)}`;

  return {
    invoiceNo,
    date           : new Date().toLocaleDateString("en-IN"),
    time           : new Date().toLocaleTimeString("en-IN"),
    customerName   : name,
    customerMobile : mobile,
    deliveryAddress: address,
    businessName   : businessName   || "CodeForge Commerce",
    businessGST    : businessGST    || "GSTXXXXXXXX",
    businessAddress: businessAddress || "India",
    items,
    subtotal,
    delivery,
    gstRate        : GST_RATE,
    gst,
    total,
    paymentStatus  : "pending",
  };
}

// ── Generate plain text invoice (for DM) ─────────────────────────────────────
function toText(bill) {
  const line = "─".repeat(32);
  const itemLines = bill.items.map(i =>
    `${(i.name + (i.size ? ` (${i.size})` : "")).padEnd(22)}₹${i.total}`
  ).join("\n");

  return [
    `INVOICE #${bill.invoiceNo}`,
    `Date: ${bill.date}  ${bill.time}`,
    line,
    `Bill To: ${bill.customerName}`,
    `Mobile: ${bill.customerMobile}`,
    `Deliver To: ${bill.deliveryAddress}`,
    line,
    itemLines,
    line,
    `Subtotal                ₹${bill.subtotal}`,
    `Delivery                ₹${bill.delivery}`,
    `GST (${bill.gstRate}%)             ₹${bill.gst}`,
    line,
    `TOTAL                   ₹${bill.total}`,
    line,
    `Sold by: ${bill.businessName}`,
    `GST No: ${bill.businessGST}`,
  ].join("\n");
}

// ── Generate HTML invoice (for PDF) ──────────────────────────────────────────
function toHTML(bill) {
  const itemRows = bill.items.map(i => `
    <tr>
      <td>${i.name}${i.size ? ` (${i.size})` : ""}</td>
      <td>${i.qty}</td>
      <td>₹${i.price}</td>
      <td>₹${i.total}</td>
    </tr>
  `).join("");

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <style>
      body { font-family: Arial; font-size: 13px; margin: 30px; color: #222; }
      h1   { color: #6c47ff; font-size: 20px; }
      table{ width: 100%; border-collapse: collapse; margin-top: 16px; }
      th   { background: #6c47ff; color: #fff; padding: 8px; text-align: left; }
      td   { padding: 7px 8px; border-bottom: 1px solid #eee; }
      .tot { font-weight: bold; font-size: 15px; }
      .box { background: #f8f6ff; padding: 12px; border-radius: 8px; margin-top: 12px; }
    </style>
  </head>
  <body>
    <h1>🧾 Invoice #${bill.invoiceNo}</h1>
    <p><b>${bill.businessName}</b> | GST: ${bill.businessGST}</p>
    <p>Date: ${bill.date} ${bill.time}</p>
    <hr/>
    <p><b>Bill To:</b> ${bill.customerName} | ${bill.customerMobile}</p>
    <p><b>Deliver To:</b> ${bill.deliveryAddress}</p>

    <table>
      <thead>
        <tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <div class="box">
      <p>Subtotal: ₹${bill.subtotal}</p>
      <p>Delivery: ₹${bill.delivery}</p>
      <p>GST (${bill.gstRate}%): ₹${bill.gst}</p>
      <p class="tot">TOTAL: ₹${bill.total}</p>
    </div>
    <p style="color:#888;font-size:11px;margin-top:20px">
      This is a computer generated invoice. Powered by CodeForge.
    </p>
  </body>
  </html>`;
}

// ── Offline mode — save bill locally and sync when online ─────────────────────
const pendingBills = [];

function savePending(bill) {
  pendingBills.push({ bill, savedAt: Date.now() });
}

function syncPending(onSyncFn) {
  while (pendingBills.length) {
    const { bill } = pendingBills.shift();
    onSyncFn(bill);
  }
}

module.exports = { generate, toText, toHTML, savePending, syncPending };
