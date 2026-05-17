// ── Database Setup — auto-creates all tables on startup ────────────────────────
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
      product_number TEXT NOT NULL DEFAULT '',
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
  // Add batch column for education class grouping (migration for existing tables)
  await db.query(`ALTER TABLE bot_customers ADD COLUMN IF NOT EXISTS batch TEXT NOT NULL DEFAULT ''`);
  await db.query(`CREATE INDEX IF NOT EXISTS customers_batch_idx ON bot_customers(batch)`);

  // ── loyalty_points ────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS loyalty_points (
      customer_id    TEXT PRIMARY KEY,
      points         INTEGER NOT NULL DEFAULT 0,
      total_earned   INTEGER NOT NULL DEFAULT 0,
      total_redeemed INTEGER NOT NULL DEFAULT 0,
      orders_count   INTEGER NOT NULL DEFAULT 0,
      history        JSONB NOT NULL DEFAULT '[]',
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── subscriptions ─────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      business_id          TEXT PRIMARY KEY,
      status               TEXT NOT NULL DEFAULT 'trial',
      plan                 TEXT NOT NULL DEFAULT 'starter',
      monthly_fee          NUMERIC NOT NULL DEFAULT 3000,
      trial_started        BIGINT NOT NULL DEFAULT 0,
      trial_ends           BIGINT NOT NULL DEFAULT 0,
      current_period_start BIGINT NOT NULL DEFAULT 0,
      current_period_end   BIGINT NOT NULL DEFAULT 0,
      paid_until           BIGINT NOT NULL DEFAULT 0,
      created_at           BIGINT NOT NULL DEFAULT 0,
      updated_at           BIGINT NOT NULL DEFAULT 0,
      payment_history      JSONB NOT NULL DEFAULT '[]'
    )
  `);

  // ── commissions ───────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS commissions (
      id                TEXT PRIMARY KEY,
      business_id       TEXT NOT NULL,
      order_id          TEXT,
      promo_source      TEXT,
      commission_amount NUMERIC NOT NULL DEFAULT 0,
      breakdown         JSONB NOT NULL DEFAULT '[]',
      status            TEXT NOT NULL DEFAULT 'pending',
      created_at        BIGINT NOT NULL DEFAULT 0
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS commissions_bid_idx ON commissions(business_id)`);

  // ── festival_broadcasts ───────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS festival_broadcasts (
      festival_name TEXT PRIMARY KEY,
      sent_at       TEXT NOT NULL,
      sent_count    INTEGER NOT NULL DEFAULT 0
    )
  `);

  // ── status_logs ───────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_logs (
      id           TEXT PRIMARY KEY,
      caption      TEXT NOT NULL DEFAULT '',
      product_id   TEXT,
      product_name TEXT,
      image_url    TEXT,
      posted_at    BIGINT NOT NULL DEFAULT 0
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS status_logs_posted_idx ON status_logs(posted_at)`);

  // ── business_settings ─────────────────────────────────────────────────────────
  // NOTE: business_settings lives in Supabase (read/written via supabaseAdmin +
  // the app's supabase_data.js). This Railway-PG copy is kept only so the table
  // exists if anything accidentally queries Railway PG, but the authoritative
  // data is always in Supabase. Schema changes must be applied in Supabase SQL editor.
  await db.query(`
    CREATE TABLE IF NOT EXISTS business_settings (
      business_id          TEXT PRIMARY KEY,
      business_name        TEXT NOT NULL DEFAULT 'My Store',
      business_gst_no      TEXT NOT NULL DEFAULT '',
      business_address     TEXT NOT NULL DEFAULT '',
      gst_enabled          BOOLEAN NOT NULL DEFAULT true,
      gst_rate             NUMERIC NOT NULL DEFAULT 5,
      delivery_charge      NUMERIC NOT NULL DEFAULT 49,
      free_above           NUMERIC NOT NULL DEFAULT 999,
      cod_fee              NUMERIC NOT NULL DEFAULT 30,
      whatsapp_number      TEXT NOT NULL DEFAULT '',
      shiprocket_email     TEXT NOT NULL DEFAULT '',
      shiprocket_password  TEXT NOT NULL DEFAULT '',
      delhivery_api_key    TEXT NOT NULL DEFAULT '',
      industry             TEXT NOT NULL DEFAULT 'product',
      upi_id               TEXT NOT NULL DEFAULT '',
      bank_details         TEXT NOT NULL DEFAULT '',
      greeting_message     TEXT NOT NULL DEFAULT '',
      location_url         TEXT NOT NULL DEFAULT '',
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── wishlists ─────────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS wishlists (
      id           TEXT PRIMARY KEY,
      customer_id  TEXT NOT NULL,
      product_id   TEXT NOT NULL,
      product_name TEXT NOT NULL DEFAULT '',
      added_at     BIGINT NOT NULL DEFAULT 0,
      notified     BOOLEAN NOT NULL DEFAULT false
    )
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS wishlists_cid_pid ON wishlists(customer_id, product_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS wishlists_pid_idx ON wishlists(product_id)`);

  // ── order_otps ────────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_otps (
      order_id                TEXT PRIMARY KEY,
      cod_otp                 TEXT,
      cod_otp_verified        BOOLEAN NOT NULL DEFAULT false,
      delivery_otp            TEXT,
      delivery_otp_verified   BOOLEAN NOT NULL DEFAULT false
    )
  `);

  // ── photo_inquiries ───────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS photo_inquiries (
      id            TEXT PRIMARY KEY,
      customer_id   TEXT NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      image_url     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      owner_reply   TEXT,
      product_id    TEXT,
      created_at    BIGINT NOT NULL DEFAULT 0,
      replied_at    BIGINT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS photo_inquiries_status_idx ON photo_inquiries(status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS photo_inquiries_cid_idx    ON photo_inquiries(customer_id)`);

  // ── customer_queries ──────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS customer_queries (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL DEFAULT 'default',
      customer_id   TEXT NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      message       TEXT NOT NULL DEFAULT '',
      type          TEXT NOT NULL DEFAULT 'query',
      status        TEXT NOT NULL DEFAULT 'pending',
      owner_reply   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      replied_at    TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS queries_bid_idx    ON customer_queries(business_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS queries_status_idx ON customer_queries(status)`);

  // ── class_schedules ───────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS class_schedules (
      id               TEXT PRIMARY KEY,
      business_id      TEXT NOT NULL DEFAULT 'default',
      title            TEXT NOT NULL DEFAULT '',
      course_name      TEXT NOT NULL DEFAULT '',
      course_id        TEXT,
      notify_mode      TEXT NOT NULL DEFAULT 'all',
      scheduled_at     TIMESTAMPTZ NOT NULL,
      reminder_60_sent BOOLEAN NOT NULL DEFAULT false,
      reminder_15_sent BOOLEAN NOT NULL DEFAULT false,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Migrate existing tables — add columns added after initial deploy
  await db.query(`ALTER TABLE class_schedules ADD COLUMN IF NOT EXISTS course_id   TEXT`);
  await db.query(`ALTER TABLE class_schedules ADD COLUMN IF NOT EXISTS notify_mode TEXT NOT NULL DEFAULT 'all'`);
  await db.query(`ALTER TABLE class_schedules ADD COLUMN IF NOT EXISTS batch_name  TEXT NOT NULL DEFAULT ''`);
  await db.query(`CREATE INDEX IF NOT EXISTS schedules_bid_idx ON class_schedules(business_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS schedules_time_idx ON class_schedules(scheduled_at)`);

  // ── order_reviews ─────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_reviews (
      id          TEXT PRIMARY KEY,
      business_id TEXT NOT NULL DEFAULT 'default',
      customer_id TEXT NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      order_id    TEXT,
      rating      INTEGER NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS reviews_bid_idx ON order_reviews(business_id)`);

  // ── whatsapp_numbers ──────────────────────────────────────────────────────────
  // Maps Meta phone_number_id → business_id for multi-tenant routing
  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_numbers (
      phone_number_id  TEXT PRIMARY KEY,
      business_id      TEXT NOT NULL,
      phone_number     TEXT NOT NULL DEFAULT '',
      token            TEXT NOT NULL DEFAULT '',
      active           BOOLEAN NOT NULL DEFAULT true,
      registered_at    BIGINT NOT NULL DEFAULT 0
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS wa_numbers_bid_idx ON whatsapp_numbers(business_id)`);

  // ── Column migrations (safe on existing Railway PG DBs) ──────────────────────
  // NOTE: Also run these in Supabase SQL editor (business_settings is authoritative there):
  //   ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS faq_text         TEXT NOT NULL DEFAULT '';
  //   ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS business_slug    TEXT NOT NULL DEFAULT '';
  //   ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS instagram_handle TEXT NOT NULL DEFAULT '';
  //   ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS city             TEXT NOT NULL DEFAULT '';
  //   ALTER TABLE catalog           ADD COLUMN IF NOT EXISTS stock_count      INTEGER NOT NULL DEFAULT -1;
  await db.query(`ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS faq_text         TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS business_slug    TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS instagram_handle TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS city             TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE catalog            ADD COLUMN IF NOT EXISTS stock_count     INTEGER NOT NULL DEFAULT -1`);

  console.log("[Setup] All tables ready ✓");
}

module.exports = { setup };
