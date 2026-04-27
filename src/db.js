// ── Railway PostgreSQL client ──────────────────────────────────────────────────
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgresql://postgres:peBFQugIlaGIWtmUCmUoTcYbdZXBwdkH@shinkansen.proxy.rlwy.net:37446/railway",
  ssl: { rejectUnauthorized: false },
});

module.exports = { query: (text, params) => pool.query(text, params) };
