// ── Railway PostgreSQL client ──────────────────────────────────────────────────
const { Pool } = require("pg");

const pool = new Pool({
  connectionString    : process.env.DATABASE_URL ||
    "postgresql://postgres:peBFQugIlaGIWtmUCmUoTcYbdZXBwdkH@shinkansen.proxy.rlwy.net:37446/railway",
  ssl                 : { rejectUnauthorized: false },
  max                 : 10,
  idleTimeoutMillis   : 30000,   // close idle connections after 30s
  connectionTimeoutMillis: 5000, // fail fast if DB unreachable (5s)
  keepAlive           : true,    // prevent Railway proxy from dropping idle connections
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
  // Don't crash — pool auto-recovers on next query
});

module.exports = { query: (text, params) => pool.query(text, params) };
