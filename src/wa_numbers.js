// ── WhatsApp Number Registry ───────────────────────────────────────────────────
// Maps Meta phone_number_id → business_id
// One record per client phone number registered under your Meta App
// ─────────────────────────────────────────────────────────────────────────────

const db = require("./db");

// ── Register (or update) a client's number ────────────────────────────────────
async function register(businessId, phoneNumberId, phoneNumber = "", token = "") {
  await db.query(
    `INSERT INTO whatsapp_numbers
       (phone_number_id, business_id, phone_number, token, active, registered_at)
     VALUES ($1, $2, $3, $4, true, $5)
     ON CONFLICT (phone_number_id) DO UPDATE
       SET business_id  = $2,
           phone_number = $3,
           token        = CASE WHEN $4 = '' THEN whatsapp_numbers.token ELSE $4 END,
           active       = true,
           registered_at = $5`,
    [phoneNumberId, businessId, phoneNumber, token, Date.now()]
  );
}

// ── Look up business by incoming phone_number_id ──────────────────────────────
async function getByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const r = await db.query(
    `SELECT * FROM whatsapp_numbers WHERE phone_number_id = $1 AND active = true`,
    [phoneNumberId]
  );
  return r.rows[0] || null;
}

// ── Get the registered number for a business ──────────────────────────────────
async function getByBusinessId(businessId) {
  const r = await db.query(
    `SELECT * FROM whatsapp_numbers WHERE business_id = $1 AND active = true ORDER BY registered_at DESC LIMIT 1`,
    [businessId]
  );
  return r.rows[0] || null;
}

// ── List all registered numbers ───────────────────────────────────────────────
async function getAll() {
  const r = await db.query(
    `SELECT phone_number_id, business_id, phone_number, active, registered_at
     FROM whatsapp_numbers ORDER BY registered_at DESC`
  );
  return r.rows;
}

// ── Deactivate a number ───────────────────────────────────────────────────────
async function deactivate(phoneNumberId) {
  await db.query(
    `UPDATE whatsapp_numbers SET active = false WHERE phone_number_id = $1`,
    [phoneNumberId]
  );
}

module.exports = { register, getByPhoneNumberId, getByBusinessId, getAll, deactivate };
