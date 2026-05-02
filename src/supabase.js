// ── Supabase Admin Client (Railway server-side) ───────────────────────────────
// Uses service role key — bypasses RLS so the bot can read/write any business
// SUPABASE_SERVICE_KEY must be set in Railway environment variables
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL         = "https://chwwlgcipsqogjvupqwd.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SERVICE_ROLE || "";

// Only initialise if key is present — prevents crash on missing env var
let supabaseAdmin = null;
if (SUPABASE_SERVICE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  console.log("[Supabase] Admin client ready ✓");
} else {
  console.warn("[Supabase] SERVICE_ROLE not set — add it in Railway variables");
}

module.exports = { supabaseAdmin };
