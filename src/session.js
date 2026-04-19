// ── Session Manager ────────────────────────────────────────────────────────────
// Stores conversation state per customer (in-memory, replace with Redis for prod)
// ─────────────────────────────────────────────────────────────────────────────

const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

function create(customerId, data = {}) {
  const sess = {
    customerId,
    state    : "idle",
    cart     : [],
    name     : data.first_name || "there",
    ...data,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions.set(customerId, sess);
  return sess;
}

function get(customerId) {
  const sess = sessions.get(customerId);
  if (!sess) return null;

  // Auto-expire stale sessions
  if (Date.now() - sess.updatedAt > SESSION_TIMEOUT) {
    sessions.delete(customerId);
    return null;
  }
  return sess;
}

function update(customerId, data) {
  const existing = get(customerId) || create(customerId);
  const updated  = { ...existing, ...data, updatedAt: Date.now() };
  sessions.set(customerId, updated);
  return updated;
}

function reset(customerId) {
  const existing = get(customerId);
  if (existing) {
    sessions.set(customerId, {
      customerId,
      state    : "idle",
      cart     : [],
      name     : existing.name,
      updatedAt: Date.now(),
      createdAt: existing.createdAt,
    });
  }
}

function remove(customerId) {
  sessions.delete(customerId);
}

function all() {
  return Array.from(sessions.values());
}

module.exports = { create, get, update, reset, remove, all };
