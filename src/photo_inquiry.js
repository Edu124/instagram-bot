// ── Photo Inquiry System ───────────────────────────────────────────────────────
// Customer sends image → bot creates inquiry → owner replies → bot DMs customer
// ─────────────────────────────────────────────────────────────────────────────
const db = require("./db");

async function create(customerId, imageUrl, customerName = "") {
  const id = `pi_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const { rows } = await db.query(
      `INSERT INTO photo_inquiries
         (id, customer_id, customer_name, image_url, status, created_at)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
      [id, customerId, customerName, imageUrl, Date.now()]
    );
    return rows[0] || null;
  } catch (e) {
    console.error("[PhotoInquiry] create error:", e.message);
    return null;
  }
}

async function reply(inquiryId, ownerReply, productId = null) {
  try {
    const { rows } = await db.query(
      `UPDATE photo_inquiries
       SET status='replied', owner_reply=$1, product_id=$2, replied_at=$3
       WHERE id=$4 RETURNING *`,
      [ownerReply, productId, Date.now(), inquiryId]
    );
    return rows[0] || null;
  } catch (e) {
    console.error("[PhotoInquiry] reply error:", e.message);
    return null;
  }
}

async function getPending() {
  try {
    const { rows } = await db.query(
      `SELECT * FROM photo_inquiries WHERE status='pending' ORDER BY created_at DESC`
    );
    return rows;
  } catch (e) {
    return [];
  }
}

async function getAll({ limit = 50 } = {}) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM photo_inquiries ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  } catch (e) {
    return [];
  }
}

module.exports = { create, reply, getPending, getAll };
