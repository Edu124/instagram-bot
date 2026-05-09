// ── Product Catalog — Supabase backed ────────────────────────────────────────
const { supabaseAdmin } = require("./supabase");

const DEFAULT_BID = process.env.BUSINESS_ID || "default";

// ── Add single product ────────────────────────────────────────────────────────
async function addProduct(product, businessId = DEFAULT_BID) {
  const row = {
    id             : Date.now().toString(),
    business_id    : businessId,
    name           : product.name          || "",
    price          : Number(product.price) || 0,
    category       : product.category      || "general",
    colors         : product.colors        || [],
    sizes          : product.sizes         || [],
    has_sizes      : (product.sizes || []).length > 0,
    material       : product.material      || "",
    description    : product.description   || "",
    image_url      : product.imageUrl      || "",
    insta_post_url : product.instaPostUrl  || "",
    rating         : product.rating        || null,
    in_stock       : product.inStock !== false,
    tags           : product.tags          || [],
  };

  try {
    const { data, error } = await supabaseAdmin
      .from("catalog")
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return _toProduct(data);
  } catch (e) {
    console.error("[Catalog] addProduct error:", e.message);
    return _toProduct(row);
  }
}

// ── Get all products ──────────────────────────────────────────────────────────
async function getAll(businessId = DEFAULT_BID) {
  try {
    const { data, error } = await supabaseAdmin
      .from("catalog")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data || []).map(_toProduct);
  } catch (e) {
    console.error("[Catalog] getAll error:", e.message);
    return [];
  }
}

// ── Get single product ────────────────────────────────────────────────────────
async function get(productId, businessId = DEFAULT_BID) {
  try {
    const { data, error } = await supabaseAdmin
      .from("catalog")
      .select("*")
      .eq("id", String(productId))
      .eq("business_id", businessId)
      .single();
    if (error) return null;
    return _toProduct(data);
  } catch (e) {
    console.error("[Catalog] get error:", e.message);
    return null;
  }
}

// ── Search products ───────────────────────────────────────────────────────────
async function search(intent = {}, businessId = DEFAULT_BID) {
  const all = await getAll(businessId);
  let results = all.filter(p => p.inStock);

  if (intent.product) {
    const raw       = intent.product.toLowerCase();
    const originals = raw.split(" ").filter(k => k.length > 1);
    const keywords  = originals.map(kw => {
      if (kw.endsWith("ies")) return kw.slice(0, -3) + "y";
      if (kw.endsWith("es"))  return kw.slice(0, -2);
      if (kw.endsWith("s"))   return kw.slice(0, -1);
      return kw;
    });

    // Score-based matching: at least 1 keyword must match, more matches = higher rank.
    // This handles partial course names like "Algebra" matching "Algebra Standard 9th",
    // and "9th math" matching "Mathematics Standard 9th" (both words appear somewhere).
    const scored = results.map(p => {
      const searchable = [p.name, p.category, p.description, ...(p.tags || [])].join(" ").toLowerCase();
      let score = 0;
      keywords.forEach((stem, i) => {
        if (searchable.includes(stem) || searchable.includes(originals[i] || stem)) score++;
      });
      return { p, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

    results = scored.map(x => x.p);
  }

  if (intent.color)    { const c = intent.color.toLowerCase();    results = results.filter(p => !p.colors?.length  || p.colors.some(x  => x.toLowerCase().includes(c))); }
  if (intent.size)     { const s = intent.size.toUpperCase();     results = results.filter(p => !p.sizes?.length   || p.sizes.includes(s)); }
  if (intent.material) { const m = intent.material.toLowerCase(); results = results.filter(p => !p.material        || p.material.toLowerCase().includes(m)); }

  if (intent.maxPrice) {
    const priced = results.filter(p => p.price > 0 && p.price <= intent.maxPrice);
    if (!priced.length) {
      const closest = results.filter(p => p.price > 0).sort((a, b) => a.price - b.price).slice(0, 3);
      return { results: closest, noExactMatch: true, searchedMax: intent.maxPrice };
    }
    results = priced;
  }
  if (intent.minPrice)  results = results.filter(p => !p.price || p.price === 0 || p.price >= intent.minPrice);
  if (intent.category)  results = results.filter(p => p.category.toLowerCase().includes(intent.category.toLowerCase()));

  results.sort((a, b) => {
    if (!a.price && b.price) return 1;
    if (a.price && !b.price) return -1;
    if (b.rating && a.rating) return b.rating - a.rating;
    return a.price - b.price;
  });

  return { results, noExactMatch: false };
}

// ── Update product ────────────────────────────────────────────────────────────
async function update(productId, changes, businessId = DEFAULT_BID) {
  const updates = {};
  if (changes.name        !== undefined) updates.name          = changes.name;
  if (changes.price       !== undefined) updates.price         = changes.price;
  if (changes.category    !== undefined) updates.category      = changes.category;
  if (changes.colors      !== undefined) updates.colors        = changes.colors;
  if (changes.sizes       !== undefined) { updates.sizes = changes.sizes; updates.has_sizes = changes.sizes.length > 0; }
  if (changes.material    !== undefined) updates.material      = changes.material;
  if (changes.description !== undefined) updates.description   = changes.description;
  if (changes.imageUrl    !== undefined) updates.image_url     = changes.imageUrl;
  if (changes.inStock     !== undefined) updates.in_stock      = changes.inStock;
  if (changes.tags        !== undefined) updates.tags          = changes.tags;

  if (!Object.keys(updates).length) return get(productId, businessId);

  try {
    const { data, error } = await supabaseAdmin
      .from("catalog")
      .update(updates)
      .eq("id", String(productId))
      .eq("business_id", businessId)
      .select()
      .single();
    if (error) throw error;
    return _toProduct(data);
  } catch (e) {
    console.error("[Catalog] update error:", e.message);
    return null;
  }
}

// ── Toggle stock ──────────────────────────────────────────────────────────────
async function toggleStock(productId, inStock, businessId = DEFAULT_BID) {
  try {
    const { data, error } = await supabaseAdmin
      .from("catalog")
      .update({ in_stock: inStock })
      .eq("id", String(productId))
      .eq("business_id", businessId)
      .select()
      .single();
    if (error) throw error;
    return _toProduct(data);
  } catch (e) {
    console.error("[Catalog] toggleStock error:", e.message);
    return null;
  }
}

// ── Delete product ────────────────────────────────────────────────────────────
async function deleteProduct(productId, businessId = DEFAULT_BID) {
  try {
    const { error } = await supabaseAdmin
      .from("catalog")
      .delete()
      .eq("id", String(productId))
      .eq("business_id", businessId);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("[Catalog] deleteProduct error:", e.message);
    return false;
  }
}

// ── Map DB row → app product shape ───────────────────────────────────────────
function _toProduct(row) {
  return {
    id           : row.id,
    name         : row.name,
    price        : Number(row.price),
    category     : row.category,
    colors       : row.colors       || [],
    sizes        : row.sizes        || [],
    hasSizes     : row.has_sizes,
    material     : row.material     || "",
    description  : row.description  || "",
    imageUrl     : row.image_url    || "",
    instaPostUrl : row.insta_post_url || "",
    rating       : row.rating != null ? Number(row.rating) : null,
    inStock      : row.in_stock,
    tags         : row.tags         || [],
    createdAt    : row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

module.exports = { addProduct, getAll, get, search, update, toggleStock, deleteProduct };
