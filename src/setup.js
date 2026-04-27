// ── Database Setup — auto-creates tables on startup ────────────────────────────
const db = require("./db");

async function setup() {
  console.log("[Setup] Ensuring database tables exist...");

  // ── catalog ──────────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS catalog (
      id             TEXT PRIMARY KEY,
      business_id    TEXT NOT NULL DEFAULT 'default',
      name           TEXT NOT NULL DEFAULT '',
      price          NUMERIC NOT NULL DEFAULT 0,
      category       TEXT NOT NULL DEFAULT 'general',
      colors         JSONB NOT NULL DEFAULT '[]',
      sizes          JSONB NOT NULL DEFAULT '[]',
      has_sizes      BOOLEAN NOT NULL DEFAULT false,
      material       TEXT NOT NULL DEFAULT '',
      description    TEXT NOT NULL DEFAULT '',
      image_url      TEXT NOT NULL DEFAULT '',
      insta_post_url TEXT NOT NULL DEFAULT '',
      rating         NUMERIC,
      in_stock       BOOLEAN NOT NULL DEFAULT true,
      tags           JSONB NOT NULL DEFAULT '[]',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS catalog_bid_idx ON catalog(business_id)`);

  // ── orders ───────────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,
      business_id     TEXT NOT NULL DEFAULT 'default',
      customer_id     TEXT,
      name            TEXT NOT NULL DEFAULT '',
      cart            JSONB NOT NULL DEFAULT '[]',
      address         TEXT NOT NULL DEFAULT '',
      mobile          TEXT NOT NULL DEFAULT '',
      bill            JSONB NOT NULL DEFAULT '{}',
      pay_link        TEXT,
      payment_mode    TEXT NOT NULL DEFAULT 'cod',
      status          TEXT NOT NULL DEFAULT 'pending_payment',
      status_dates    JSONB NOT NULL DEFAULT '{}',
      tracking_number TEXT,
      tracking_url    TEXT,
      source          TEXT NOT NULL DEFAULT 'whatsapp',
      promo_source    TEXT,
      commission      NUMERIC NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS orders_bid_idx ON orders(business_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS orders_cid_idx ON orders(customer_id)`);

  // ── bot_customers ─────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_customers (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL DEFAULT 'Unknown',
      first_name        TEXT NOT NULL DEFAULT '',
      last_name         TEXT NOT NULL DEFAULT '',
      mobile            TEXT,
      source            TEXT NOT NULL DEFAULT 'instagram_bot',
      referred_by       TEXT,
      referral_code     TEXT,
      referral_count    INTEGER NOT NULL DEFAULT 0,
      referral_earnings NUMERIC NOT NULL DEFAULT 0,
      total_orders      INTEGER NOT NULL DEFAULT 0,
      total_spend       NUMERIC NOT NULL DEFAULT 0,
      first_seen_at     BIGINT NOT NULL DEFAULT 0,
      last_active_at    BIGINT NOT NULL DEFAULT 0,
      order_ids         JSONB NOT NULL DEFAULT '[]',
      tags              JSONB NOT NULL DEFAULT '[]',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS customers_ref_idx ON bot_customers(referral_code)`);

  console.log("[Setup] All tables ready ✓");
}

module.exports = { setup };
