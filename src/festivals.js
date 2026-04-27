// ── Indian Festival Marketing Engine — Railway PostgreSQL backed ───────────────
// Maintains a calendar of Indian festivals for 2026-2027
// Generates campaign messages and tracks broadcast history
// ─────────────────────────────────────────────────────────────────────────────

const db = require("./db");

// ── Festival Calendar (2026 + 2027) ───────────────────────────────────────────
const FESTIVALS = [
  // ── 2026 ─────────────────────────────────────────────────────────────────
  { name: "Makar Sankranti",  date: "2026-01-14", emoji: "🪁",  alert: 5,  tags: ["all"] },
  { name: "Republic Day",     date: "2026-01-26", emoji: "🇮🇳", alert: 3,  tags: ["all"] },
  { name: "Valentine's Day",  date: "2026-02-14", emoji: "❤️",  alert: 7,  tags: ["gifting","couple","fashion"] },
  { name: "Holi",             date: "2026-03-05", emoji: "🎨",  alert: 7,  tags: ["all","colour","ethnic"] },
  { name: "Eid al-Fitr",      date: "2026-03-30", emoji: "🌙",  alert: 7,  tags: ["ethnic","kurta","sherwani"] },
  { name: "Ram Navami",       date: "2026-04-07", emoji: "🙏",  alert: 3,  tags: ["ethnic","all"] },
  { name: "Mother's Day",     date: "2026-05-10", emoji: "💐",  alert: 7,  tags: ["gifting","saree","all"] },
  { name: "Eid al-Adha",      date: "2026-06-06", emoji: "🌙",  alert: 7,  tags: ["ethnic"] },
  { name: "Independence Day", date: "2026-08-15", emoji: "🇮🇳", alert: 5,  tags: ["all"] },
  { name: "Raksha Bandhan",   date: "2026-08-17", emoji: "🧡",  alert: 7,  tags: ["gifting","all"] },
  { name: "Janmashtami",      date: "2026-08-22", emoji: "🦚",  alert: 3,  tags: ["ethnic","all"] },
  { name: "Ganesh Chaturthi", date: "2026-08-23", emoji: "🐘",  alert: 5,  tags: ["ethnic","all"] },
  { name: "Navratri",         date: "2026-09-22", emoji: "💃",  alert: 10, tags: ["lehenga","chaniya","ethnic","dance"] },
  { name: "Dussehra",         date: "2026-10-01", emoji: "🏹",  alert: 5,  tags: ["all","ethnic"] },
  { name: "Diwali",           date: "2026-10-19", emoji: "🪔",  alert: 10, tags: ["all","gifting","ethnic","kurta"] },
  { name: "Bhai Dooj",        date: "2026-10-22", emoji: "🤝",  alert: 5,  tags: ["gifting","all"] },
  { name: "Children's Day",   date: "2026-11-14", emoji: "🎈",  alert: 3,  tags: ["kids","all"] },
  { name: "Christmas",        date: "2026-12-25", emoji: "🎄",  alert: 7,  tags: ["all","gifting"] },
  { name: "New Year's Eve",   date: "2026-12-31", emoji: "🎆",  alert: 5,  tags: ["all","party","western"] },
  // ── 2027 ─────────────────────────────────────────────────────────────────
  { name: "Makar Sankranti",  date: "2027-01-14", emoji: "🪁",  alert: 5,  tags: ["all"] },
  { name: "Republic Day",     date: "2027-01-26", emoji: "🇮🇳", alert: 3,  tags: ["all"] },
  { name: "Valentine's Day",  date: "2027-02-14", emoji: "❤️",  alert: 7,  tags: ["gifting","couple"] },
  { name: "Holi",             date: "2027-03-23", emoji: "🎨",  alert: 7,  tags: ["all","colour"] },
  { name: "Diwali",           date: "2027-11-08", emoji: "🪔",  alert: 10, tags: ["all","gifting"] },
  { name: "Christmas",        date: "2027-12-25", emoji: "🎄",  alert: 7,  tags: ["all","gifting"] },
];

// ── Campaign message templates ────────────────────────────────────────────────
const CAMPAIGN_TEMPLATES = {
  "Holi": (biz, discount) =>
    `🎨 *Holi Hai! ${biz}* 🎨\n\nRang, khushi aur naye kapde — Holi ki hardik shubhkamnayein! 🌈\n\n🎁 *Holi Dhamaka Sale — ${discount}% OFF*\nAaj aur kal sirf! ⏰\n\n👇 Reply *SHOP* to browse our collection`,

  "Diwali": (biz, discount) =>
    `🪔 *Happy Diwali from ${biz}!* 🪔\n\nIs Diwali apne aap ko aur apno ko special feel karao ✨\n\n🎁 *Diwali Dhamaka — Upto ${discount}% OFF*\nOffer sirf aaj raat tak! 🕯️\n\n👇 Reply *SHOP* to order now`,

  "Eid al-Fitr": (biz, discount) =>
    `🌙 *Eid Mubarak! ${biz}* 🌙\n\nNaye kapde, naya jazbah, nayi khushi! 💫\n\n🎁 *Eid Special — ${discount}% OFF* on all ethnic wear\nAaj aur kal! ⭐\n\n👇 Reply *SHOP* to browse`,

  "Navratri": (biz, discount) =>
    `💃 *Navratri Mubarak! ${biz}* 💃\n\n9 din, 9 rang, 9 looks! Is Navratri apna best look pao 🌸\n\n🎁 *Navratri Sale — ${discount}% OFF*\nLehenga, Chaniya Choli, Ethnic wear sab pe!\n\n👇 Reply *SHOP* to explore`,

  "Raksha Bandhan": (biz, discount) =>
    `🧡 *Happy Raksha Bandhan! ${biz}* 🧡\n\nApni behen ko kuch khaas gift karo is Rakhi! 🎁\n\n🎁 *Rakhi Special — ₹${discount} OFF* on orders above ₹599\nAaj tak sirf! ✨\n\n👇 Reply *SHOP* to order`,

  "Valentine's Day": (biz, discount) =>
    `❤️ *Happy Valentine's Day! ${biz}* ❤️\n\nUnhe surprise karo aaj! Kuch special order karo 💝\n\n🎁 *Valentine Special — ${discount}% OFF*\nFree gift wrapping on all orders today! 🎀\n\n👇 Reply *SHOP* to browse`,

  "Mother's Day": (biz, discount) =>
    `💐 *Happy Mother's Day! ${biz}* 💐\n\nMaa ke liye kuch khaas! Unhein feel special karao 🥰\n\n🎁 *Mother's Day Sale — ${discount}% OFF*\nSarees, suits, kurtas aur bahut kuch!\n\n👇 Reply *SHOP* to gift`,

  "Christmas": (biz, discount) =>
    `🎄 *Merry Christmas! ${biz}* 🎄\n\nIs Christmas season mein kuch khaas pehno! ✨🎅\n\n🎁 *Christmas Sale — ${discount}% OFF*\nSab ke liye kuch na kuch! 🎁\n\n👇 Reply *SHOP* to explore`,
};

function genericTemplate(biz, festival, discount) {
  return (
    `${festival.emoji} *${festival.name} Special! ${biz}* ${festival.emoji}\n\n` +
    `Celebrating ${festival.name} with exclusive offers! 🎉\n\n` +
    `🎁 *${festival.name} Sale — ${discount}% OFF*\nLimited time offer!\n\n` +
    `👇 Reply *SHOP* to browse collection`
  );
}

// ── Pure calendar functions (no DB) ──────────────────────────────────────────
function getUpcoming(daysAhead = 10) {
  const now    = new Date();
  const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  return FESTIVALS
    .filter(f => { const d = new Date(f.date); return d >= now && d <= cutoff; })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function getAlertsForToday() {
  const now = new Date();
  return FESTIVALS.filter(f => {
    const fDate     = new Date(f.date);
    const alertDate = new Date(fDate.getTime() - f.alert * 24 * 60 * 60 * 1000);
    return now >= alertDate && now <= fDate;
  });
}

function getCampaignMessage(festivalName, businessName = "our store", discount = 10) {
  const festival  = FESTIVALS.find(f => f.name === festivalName);
  if (!festival) return null;
  const generator = CAMPAIGN_TEMPLATES[festivalName];
  return generator ? generator(businessName, discount) : genericTemplate(businessName, festival, discount);
}

function getFestival(name) {
  return FESTIVALS.find(f => f.name === name) || null;
}

function daysUntil(festivalName) {
  const festival = FESTIVALS.find(f => f.name === festivalName);
  if (!festival) return null;
  return Math.max(0, Math.ceil((new Date(festival.date) - new Date()) / 86400000));
}

// ── Broadcast log (DB-backed) ─────────────────────────────────────────────────
async function logBroadcast(festivalName, sentCount) {
  try {
    await db.query(
      `INSERT INTO festival_broadcasts (festival_name, sent_at, sent_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (festival_name) DO UPDATE SET sent_at=$2, sent_count=$3`,
      [festivalName, new Date().toISOString(), sentCount]
    );
  } catch (e) {
    console.error("[festivals] logBroadcast error:", e.message);
  }
}

async function wasAlreadyBroadcast(festivalName) {
  try {
    const { rows } = await db.query(
      `SELECT sent_at FROM festival_broadcasts WHERE festival_name = $1`,
      [festivalName]
    );
    if (!rows.length) return false;
    const age = Date.now() - new Date(rows[0].sent_at).getTime();
    return age < 30 * 24 * 60 * 60 * 1000; // reset after 30 days
  } catch (e) {
    console.error("[festivals] wasAlreadyBroadcast error:", e.message);
    return false;
  }
}

module.exports = {
  FESTIVALS,
  getUpcoming, getAlertsForToday, getCampaignMessage, getFestival, daysUntil,
  logBroadcast, wasAlreadyBroadcast,
};
