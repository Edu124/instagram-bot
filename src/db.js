// ── Supabase client for the bot ───────────────────────────────────────────────
// Uses service role key (bypasses RLS) — bot is a trusted backend, not a browser
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ekughxkikjzkimadyyuk.supabase.co";

// Prefer service role key (full access) → fall back to anon key
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrdWdoeGtpa2p6a2ltYWR5eXVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1ODkxNzQsImV4cCI6MjA5MjE2NTE3NH0.RMROZ2GAcDC6yxY8YjLW3RmyUk2c5G6HnzQry4qA2xs";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

module.exports = supabase;
