// ── OTP Engine — COD verification + delivery confirmation ──────────────────────
const db = require("./db");

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ── COD OTP (sent on order placement) ────────────────────────────────────────
async function createCodOTP(orderId) {
  const otp = generateOTP();
  try {
    await db.query(
      `INSERT INTO order_otps (order_id, cod_otp, cod_otp_verified)
       VALUES ($1,$2,false)
       ON CONFLICT (order_id) DO UPDATE SET cod_otp=$2, cod_otp_verified=false`,
      [orderId, otp]
    );
  } catch (e) {
    console.error("[OTP] createCodOTP error:", e.message);
  }
  return otp;
}

async function verifyCodOTP(orderId, otp) {
  try {
    const { rows } = await db.query(
      `SELECT cod_otp, cod_otp_verified FROM order_otps WHERE order_id=$1`,
      [orderId]
    );
    if (!rows[0] || rows[0].cod_otp !== String(otp)) return false;
    await db.query(
      `UPDATE order_otps SET cod_otp_verified=true WHERE order_id=$1`,
      [orderId]
    );
    return true;
  } catch (e) {
    console.error("[OTP] verifyCodOTP error:", e.message);
    return false;
  }
}

// ── Delivery OTP (sent when order goes out_for_delivery) ─────────────────────
async function createDeliveryOTP(orderId) {
  const otp = generateOTP();
  try {
    await db.query(
      `INSERT INTO order_otps (order_id, delivery_otp, delivery_otp_verified)
       VALUES ($1,$2,false)
       ON CONFLICT (order_id) DO UPDATE SET delivery_otp=$2, delivery_otp_verified=false`,
      [orderId, otp]
    );
  } catch (e) {
    console.error("[OTP] createDeliveryOTP error:", e.message);
  }
  return otp;
}

async function verifyDeliveryOTP(orderId, otp) {
  try {
    const { rows } = await db.query(
      `SELECT delivery_otp, delivery_otp_verified FROM order_otps WHERE order_id=$1`,
      [orderId]
    );
    if (!rows[0] || rows[0].delivery_otp !== String(otp)) return false;
    await db.query(
      `UPDATE order_otps SET delivery_otp_verified=true WHERE order_id=$1`,
      [orderId]
    );
    return true;
  } catch (e) {
    console.error("[OTP] verifyDeliveryOTP error:", e.message);
    return false;
  }
}

async function getOTPs(orderId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM order_otps WHERE order_id=$1`,
      [orderId]
    );
    return rows[0] || null;
  } catch (e) {
    return null;
  }
}

module.exports = { createCodOTP, verifyCodOTP, createDeliveryOTP, verifyDeliveryOTP, getOTPs };
