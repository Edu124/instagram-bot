// ── Wishlist + Restock Alerts ──────────────────────────────────────────────────
const db = require("./db");

async function add(customerId, productId, productName) {
  const id = `wl_${customerId}_${productId}`.slice(0, 120);
  try {
    await db.query(
      `INSERT INTO wishlists (id, customer_id, product_id, product_name, added_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (customer_id, product_id) DO NOTHING`,
      [id, customerId, productId, productName || "", Date.now()]
    );
    return true;
  } catch (e) {
    console.error("[Wishlist] add error:", e.message);
    return false;
  }
}

async function remove(customerId, productId) {
  try {
    await db.query(
      `DELETE FROM wishlists WHERE customer_id=$1 AND product_id=$2`,
      [customerId, productId]
    );
  } catch (e) {
    console.error("[Wishlist] remove error:", e.message);
  }
}

async function getByCustomer(customerId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM wishlists WHERE customer_id=$1 ORDER BY added_at DESC`,
      [customerId]
    );
    return rows;
  } catch (e) {
    return [];
  }
}

// Returns customers waiting for restock (notified=false only)
async function getByProduct(productId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM wishlists WHERE product_id=$1 AND notified=false`,
      [productId]
    );
    return rows;
  } catch (e) {
    return [];
  }
}

async function markNotified(customerId, productId) {
  try {
    await db.query(
      `UPDATE wishlists SET notified=true WHERE customer_id=$1 AND product_id=$2`,
      [customerId, productId]
    );
  } catch (e) {
    console.error("[Wishlist] markNotified error:", e.message);
  }
}

module.exports = { add, remove, getByCustomer, getByProduct, markNotified };
