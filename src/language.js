// ── Language Detection & Multilingual Support ─────────────────────────────────
// Detects Indian languages from Unicode ranges + common keywords
// Provides per-language AI prompt instructions for Claude
// ─────────────────────────────────────────────────────────────────────────────

const LANGUAGES = {
  hindi    : { code: "hi", name: "Hindi",     greet: "नमस्ते",       flag: "🇮🇳" },
  hinglish : { code: "hi", name: "Hinglish",  greet: "Namaste!",     flag: "🇮🇳" },
  marathi  : { code: "mr", name: "Marathi",   greet: "नमस्कार",      flag: "🇮🇳" },
  gujarati : { code: "gu", name: "Gujarati",  greet: "નમસ્તે",       flag: "🇮🇳" },
  tamil    : { code: "ta", name: "Tamil",     greet: "வணக்கம்",      flag: "🇮🇳" },
  telugu   : { code: "te", name: "Telugu",    greet: "నమస్కారం",     flag: "🇮🇳" },
  kannada  : { code: "kn", name: "Kannada",   greet: "ನಮಸ್ಕಾರ",     flag: "🇮🇳" },
  bengali  : { code: "bn", name: "Bengali",   greet: "নমস্কার",      flag: "🇮🇳" },
  malayalam: { code: "ml", name: "Malayalam", greet: "നമസ്കാരം",     flag: "🇮🇳" },
  punjabi  : { code: "pa", name: "Punjabi",   greet: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ", flag: "🇮🇳" },
  english  : { code: "en", name: "English",   greet: "Hello",        flag: "🌐"  },
};

// ── Detect language from message text ────────────────────────────────────────
function detectLanguage(text) {
  if (!text) return "english";

  // Devanagari (Hindi / Marathi) — most common Indian script online
  if (/[\u0900-\u097F]/.test(text)) {
    // Marathi-specific common words
    const marathiWords = /\b(आहे|मला|नाही|कसे|काय|मी|तुम्ही|आम्ही|हे|ते|करा|सांगा|द्या|घ्या|आणि|किंवा)\b/;
    if (marathiWords.test(text)) return "marathi";
    return "hindi";
  }

  // Gujarati script (\u0A80-\u0AFF)
  if (/[\u0A80-\u0AFF]/.test(text)) return "gujarati";

  // Tamil script (\u0B80-\u0BFF)
  if (/[\u0B80-\u0BFF]/.test(text)) return "tamil";

  // Telugu script (\u0C00-\u0C7F)
  if (/[\u0C00-\u0C7F]/.test(text)) return "telugu";

  // Kannada script (\u0C80-\u0CFF)
  if (/[\u0C80-\u0CFF]/.test(text)) return "kannada";

  // Bengali script (\u0980-\u09FF)
  if (/[\u0980-\u09FF]/.test(text)) return "bengali";

  // Malayalam script (\u0D00-\u0D7F)
  if (/[\u0D00-\u0D7F]/.test(text)) return "malayalam";

  // Punjabi / Gurmukhi (\u0A00-\u0A7F)
  if (/[\u0A00-\u0A7F]/.test(text)) return "punjabi";

  // Hinglish — Hindi words written in Latin script
  const hinglishKeywords = [
    "hai", "hain", "kya", "nahi", "nhi", "bhai", "yaar", "acha", "achha",
    "theek", "thik", "chahiye", "mujhe", "tumhara", "mera", "tera", "haan",
    "han", "karo", "bolo", "dena", "lena", "kitna", "kab", "kahan", "kaisa",
    "dekhao", "batao", "milega", "doge", "loge", "zyada", "thoda", "sasta",
    "mehnga", "accha", "bilkul", "zaroor", "abhi", "baad",
  ];
  const lower         = text.toLowerCase();
  const hinglishCount = hinglishKeywords.filter(w => lower.split(/\W+/).includes(w)).length;
  if (hinglishCount >= 2) return "hinglish";

  return "english";
}

// ── Get the system-prompt instruction for a given language ────────────────────
function getLanguageInstruction(lang) {
  const map = {
    hindi:
      "IMPORTANT: The customer is writing in Hindi (Devanagari). " +
      "You MUST reply in Hindi using Devanagari script. " +
      "Use a warm, casual tone. Short sentences. Emojis ok.",

    hinglish:
      "IMPORTANT: The customer is writing in Hinglish (Hindi+English mix, Latin script). " +
      "You MUST reply in Hinglish — casual, friendly, like a dost/friend. " +
      "Examples: 'bhai', 'yaar', 'bilkul', 'zaroor', 'ek second'. " +
      "Keep it conversational. Do NOT switch to formal English.",

    marathi:
      "IMPORTANT: The customer is writing in Marathi. " +
      "You MUST reply in Marathi using Devanagari script. " +
      "Casual, friendly Marathi tone.",

    gujarati:
      "IMPORTANT: The customer is writing in Gujarati. " +
      "You MUST reply in Gujarati using Gujarati script. Friendly tone.",

    tamil:
      "IMPORTANT: The customer is writing in Tamil. " +
      "You MUST reply in Tamil using Tamil script. Friendly tone.",

    telugu:
      "IMPORTANT: The customer is writing in Telugu. " +
      "You MUST reply in Telugu using Telugu script. Friendly tone.",

    kannada:
      "IMPORTANT: The customer is writing in Kannada. " +
      "You MUST reply in Kannada using Kannada script. Friendly tone.",

    bengali:
      "IMPORTANT: The customer is writing in Bengali. " +
      "You MUST reply in Bengali using Bengali script. Friendly tone.",

    malayalam:
      "IMPORTANT: The customer is writing in Malayalam. " +
      "You MUST reply in Malayalam using Malayalam script. Friendly tone.",

    punjabi:
      "IMPORTANT: The customer is writing in Punjabi. " +
      "You MUST reply in Punjabi using Gurmukhi script. Friendly tone.",

    english:
      "Reply in clear, friendly English. Keep messages short and WhatsApp-friendly.",
  };
  return map[lang] || map.english;
}

// ── Check if customer is requesting a language change ────────────────────────
function getRequestedLanguage(text) {
  const lower = text.toLowerCase();

  if (lower.includes("hindi")     || lower.includes("हिंदी"))       return "hindi";
  if (lower.includes("hinglish"))                                     return "hinglish";
  if (lower.includes("marathi")   || lower.includes("मराठी"))        return "marathi";
  if (lower.includes("gujarati")  || lower.includes("ગુજરાતી"))     return "gujarati";
  if (lower.includes("english"))                                      return "english";
  if (lower.includes("tamil")     || lower.includes("தமிழ்"))        return "tamil";
  if (lower.includes("telugu")    || lower.includes("తెలుగు"))       return "telugu";
  if (lower.includes("kannada")   || lower.includes("ಕನ್ನಡ"))       return "kannada";
  if (lower.includes("bengali")   || lower.includes("বাংলা"))        return "bengali";
  if (lower.includes("malayalam") || lower.includes("മലയാളം"))       return "malayalam";
  if (lower.includes("punjabi")   || lower.includes("ਪੰਜਾਬੀ"))      return "punjabi";

  return null;
}

// ── Language-change detection helper ─────────────────────────────────────────
function isLanguageChangeRequest(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("change language") ||
    lower.includes("switch language") ||
    lower.includes("speak in")        ||
    lower.includes("reply in")        ||
    lower.includes("में बात करो")      ||
    lower.includes("mein baat karo")  ||
    getRequestedLanguage(text) !== null
  );
}

// ── Greeting in detected language ─────────────────────────────────────────────
function getGreeting(lang, name) {
  const greetings = {
    hindi    : `नमस्ते ${name}! 🙏`,
    hinglish : `Hey ${name}! 👋 Kya haal hai?`,
    marathi  : `नमस्कार ${name}! 🙏`,
    gujarati : `નમસ્તે ${name}! 🙏`,
    tamil    : `வணக்கம் ${name}! 🙏`,
    telugu   : `నమస్కారం ${name}! 🙏`,
    kannada  : `ನಮಸ್ಕಾರ ${name}! 🙏`,
    bengali  : `নমস্কার ${name}! 🙏`,
    malayalam: `നമസ്കാരം ${name}! 🙏`,
    punjabi  : `ਸਤ ਸ੍ਰੀ ਅਕਾਲ ${name}! 🙏`,
    english  : `Hello ${name}! 👋`,
  };
  return greetings[lang] || greetings.english;
}

module.exports = {
  LANGUAGES,
  detectLanguage,
  getLanguageInstruction,
  getRequestedLanguage,
  isLanguageChangeRequest,
  getGreeting,
};
