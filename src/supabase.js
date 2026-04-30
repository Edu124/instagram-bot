// ── Supabase Admin Client (Railway server-side) ───────────────────────────────
// Uses service role key — bypasses RLS so the bot can read/write any business
// SUPABASE_SERVICE_KEY must be set in Railway environment variables
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL         = "https://ekughxkikjzkimadyyuk.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!SUPABASE_SERVICE_KEY) {
  console.warn("[Supabase] WARNING: SUPABASE_SERVICE_KEY not set — bot DB writes will fail");
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabaseAdmin };
