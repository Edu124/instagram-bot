// ── Smart AI Bargaining Engine ────────────────────────────────────────────────
// Handles price negotiation in any Indian language
// Business sets BARGAIN_MAX_DISCOUNT env var (default 10%)
// Max 2 counter-offer rounds before final answer
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DISCOUNT_PCT = parseInt(process.env.BARGAIN_MAX_DISCOUNT || "10");
const MAX_ROUNDS       = 2;

// ── Bargaining detection patterns ─────────────────────────────────────────────
// English + Hinglish + transliterated Indian language keywords
const BARGAIN_PATTERNS = [
  // English negotiation
  /\b(cheaper|discount|less|reduce|negotiate|too expensive|costly|bring.*down|lower.*price|final price|last price|best price|how about|what about|deal)\b/i,
  // Hinglish / Hindi transliteration
  /\b(sasta|saste|kam kar|thoda kam|discount do|price kam|zyada hai|mehnga|mujhe.*kam|bhai.*kam|yaar.*kam|dedo|doge|milega.*kam|last.*offer|final.*offer|pakka|done)\b/i,
  // Price offer with ₹ symbol or "rs"
  /(?:₹|rs\.?|inr)\s*\d{2,5}/i,
  // "X mein doge / X pe do / X do"
  /\d{2,5}\s*(?:mein|me|pe|par|do|dedo|doge|chahiye|lene do)/i,
  // "Can you do X / I'll pay X"
  /(?:can you do|i.ll pay|i can pay|will pay|pay only)\s*(?:₹|rs\.?)?\s*\d{2,5}/i,
];

// ── Extract the price a customer is offering ─────────────────────────────────
function extractOfferedPrice(message) {
  // Try ₹ or rs prefix first
  let match = message.match(/(?:₹|rs\.?|inr)\s*(\d{2,5})/i);
  if (match) return parseInt(match[1]);

  // Try "500 mein" / "500 do" patterns
  match = message.match(/(\d{3,5})\s*(?:mein|me|pe|par|do|dedo|doge|chahiye)/i);
  if (match) return parseInt(match[1]);

  // Try "pay X" / "i'll pay X"
  match = message.match(/(?:pay|paid|paying)\s*(?:₹|rs\.?)?\s*(\d{3,5})/i);
  if (match) return parseInt(match[1]);

  // Standalone number that looks like a price (300-9999)
  match = message.match(/\b(\d{3,4})\b/);
  if (match) return parseInt(match[1]);

  return null;
}

// ── Detect if message is a bargaining attempt ─────────────────────────────────
function isBargaining(message) {
  return BARGAIN_PATTERNS.some(p => p.test(message));
}

// ── Calculate counter-offer ───────────────────────────────────────────────────
// Returns: { type: "no_bargain"|"accept"|"counter", price, isLast? }
function getCounterOffer(originalPrice, offeredPrice, round = 1) {
  const floorPrice = Math.ceil(originalPrice * (1 - MAX_DISCOUNT_PCT / 100));
  const midPrice   = Math.ceil((originalPrice + floorPrice) / 2);

  // No bargain — they're offering full price or above
  if (!offeredPrice || offeredPrice >= originalPrice) {
    return { type: "no_bargain", price: originalPrice };
  }

  // Accept — their offer is within our max discount
  if (offeredPrice >= floorPrice) {
    return { type: "accept", price: offeredPrice };
  }

  // Counter round 1: meet them halfway
  if (round === 1) {
    return { type: "counter", price: midPrice, isLast: false };
  }

  // Counter round 2: our absolute floor (final answer)
  return { type: "counter", price: floorPrice, isLast: true };
}

// ── Full bargain reply builder ─────────────────────────────────────────────────
// Returns { handled, accepted?, finalPrice?, discount?, message, isLast? }
function getBargainReply(item, offeredPrice, round, lang = "english") {
  const result = getCounterOffer(item.price, offeredPrice, round);

  if (result.type === "no_bargain") {
    return { handled: false };
  }

  if (result.type === "accept") {
    return {
      handled   : true,
      accepted  : true,
      finalPrice: result.price,
      discount  : item.price - result.price,
      message   : buildAcceptMsg(item, result.price, lang),
    };
  }

  // Counter offer
  return {
    handled   : true,
    accepted  : false,
    finalPrice: result.price,
    discount  : item.price - result.price,
    isLast    : result.isLast,
    message   : buildCounterMsg(item, result.price, result.isLast, lang),
  };
}

// ── Message builders (language-aware) ────────────────────────────────────────
function buildAcceptMsg(item, price, lang) {
  const msgs = {
    hindi:
      `✅ *Deal pakka!* 🤝\n` +
      `*${item.name}* aapko milega sirf *₹${price}* mein!\n\n` +
      `Reply *confirm* karein order place karne ke liye 👇`,

    hinglish:
      `✅ *Deal ho gaya bhai!* 🤝\n` +
      `*${item.name}* — *₹${price}* mein yours!\n\n` +
      `Reply *confirm* to place your order 👇`,

    marathi:
      `✅ *Deal झाली!* 🤝\n` +
      `*${item.name}* फक्त *₹${price}* मध्ये मिळेल!\n\n` +
      `Order साठी *confirm* reply करा 👇`,

    tamil:
      `✅ *ஒப்பந்தம் ஆயிற்று!* 🤝\n` +
      `*${item.name}* வெறும் *₹${price}*-ல் கிடைக்கும்!\n\n` +
      `Order செய்ய *confirm* என்று reply செய்யுங்கள் 👇`,

    telugu:
      `✅ *డీల్ అయింది!* 🤝\n` +
      `*${item.name}* కేవలం *₹${price}*-కి దొరుకుతుంది!\n\n` +
      `Order చేయడానికి *confirm* reply చేయండి 👇`,

    english:
      `✅ *It's a deal!* 🤝\n` +
      `*${item.name}* is yours for *₹${price}*!\n\n` +
      `Reply *confirm* to place your order 👇`,
  };
  return msgs[lang] || msgs.english;
}

function buildCounterMsg(item, price, isLast, lang) {
  const msgs = {
    hindi: isLast
      ? `🙏 Yaar, yeh mera *last offer* hai — *₹${price}*\n` +
        `Isse kam hona bilkul possible nahi. Deal karo? 🤝`
      : `Seedha ${item.price} nahi kar sakta 😅\n` +
        `Lekin *₹${price}* mein de sakta hoon — deal? 😊`,

    hinglish: isLast
      ? `Bhai *last offer* — *₹${price}*! 🙏\n` +
        `Isse zyada discount possible hi nahi. Done? 🤝`
      : `Bhai, thoda adjust karta hoon — *₹${price}* le lo yaar! 😊\n` +
        `Achha deal hai! Accept karo? 👍`,

    marathi: isLast
      ? `हे माझं *शेवटचं offer* — *₹${price}*! 🙏\n` +
        `यापेक्षा कमी शक्य नाही. Deal करायची का? 🤝`
      : `*₹${price}* मध्ये देतो — हे चांगलं आहे! 😊\n` +
        `Accept करणार का? 👍`,

    english: isLast
      ? `That's my *final offer* — *₹${price}*! 🙏\n` +
        `Can't go any lower than this. Deal? 🤝`
      : `Let me meet you halfway — *₹${price}*! 😊\n` +
        `That's a great deal! Accept? 👍`,
  };
  return msgs[lang] || msgs.english;
}

// ── "Too low" rejection message ───────────────────────────────────────────────
function getTooLowReply(item, lang = "english") {
  const floor = Math.ceil(item.price * (1 - MAX_DISCOUNT_PCT / 100));
  const msgs  = {
    hindi   : `Bhai itna possible nahi 😅 Minimum *₹${floor}* se niche nahi ho sakta.`,
    hinglish: `Yaar itna nahi ho sakta 😅 *₹${floor}* se kam possible hi nahi!`,
    english : `Sorry, that's too low! Best I can do is *₹${floor}*. Deal?`,
  };
  return msgs[lang] || msgs.english;
}

module.exports = {
  isBargaining,
  extractOfferedPrice,
  getCounterOffer,
  getBargainReply,
  getTooLowReply,
  MAX_DISCOUNT_PCT,
  MAX_ROUNDS,
};
