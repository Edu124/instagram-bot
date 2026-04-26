// ── Product Catalog — Supabase backed ─────────────────────────────────────────
const supabase = require("./db");

const DEFAULT_BID = process.env.BUSINESS_ID || "default";

// ── Add single product ────────────────────────────────────────────────────────
async function addProduct(product, businessId = DEFAULT_BID) {
  const row = {
    id            : Date.now().toString(),
    business_id   : businessId,
    name          : product.name          || "",
    price         : Number(product.price) || 0,
    category      : product.category      || "general",
    colors        : product.colors        || [],
    sizes         : product.sizes         || [],
    has_sizes     : (product.sizes || []).length > 0,
    material      : product.material      || "",
    description   : product.description   || "",
    image_url     : product.imageUrl      || "",
    insta_post_url: product.instaPostUrl  || "",
    rating        : product.rating        || null,
    in_stock      : product.inStock       !== false,
    tags          : product.tags          || [],
  };

  const { data, error } = await supabase.from("catalog").insert(row).select().single();
  if (error) { console.error("[Catalog] addProduct error:", error.message); return _toProduct(row); }
  return _toProduct(data);
}

// ── Get all products ──────────────────────────────────────────────────────────
async function getAll(businessId = DEFAULT_BID) {
  const { data, error } = await supabase
    .from("catalog").select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });
  if (error) { console.error("[Catalog] getAll error:", error.message); return []; }
  return (data || []).map(_toProduct);
}

// ── Get single product ────────────────────────────────────────────────────────
async function get(productId, businessId = DEFAULT_BID) {
  const { data } = await supabase
    .from("catalog").select("*")
    .eq("id", String(productId))
    .eq("business_id", businessId)
    .single();
  return data ? _toProduct(data) : null;
}

// ── Search products ───────────────────────────────────────────────────────────
async function search(intent = {}, businessId = DEFAULT_BID) {
  const all = await getAll(businessId);
  let results = all.filter(p => p.inStock);

  if (intent.product) {
    const raw      = intent.product.toLowerCase();
    const keywords = raw.split(" ").filter(k => k.length > 1).map(kw => {
      if (kw.endsWith("ies")) return kw.slice(0, -3) + "y";
      if (kw.endsWith("es"))  return kw.slice(0, -2);
      if (kw.endsWith("s"))   return kw.slice(0, -1);
      return kw;
    });
    results = results.filter(p => {
      const searchable = [p.name, p.category, p.description, ...(p.tags || [])].join(" ").toLowerCase();
      return keywords.every((stem, i) => {
        const original = intent.product.toLowerCase().split(" ").filter(k => k.length > 1)[i];
        return searchable.includes(stem) || searchable.includes(original);
      });
    });
  }

  if (intent.color) {
    const color = intent.color.toLowerCase();
    results = results.filter(p => !p.colors?.length || p.colors.some(c => c.toLowerCase().includes(color)));
  }
  if (intent.size) {
    const size = intent.size.toUpperCase();
    results = results.filter(p => !p.sizes?.length || p.sizes.includes(size));
  }
  if (intent.material) {
    const mat = intent.material.toLowerCase();
    results = results.filter(p => !p.material || p.material.toLowerCase().includes(mat));
  }
  if (intent.maxPrice) {
    const priced   = results.filter(p => p.price > 0 && p.price <= intent.maxPrice);
    const unpriced = results.filter(p => !p.price || p.price === 0);
    if (!priced.length) {
      const closest = results.filter(p => p.price > 0).sort((a, b) => a.price - b.price).slice(0, 3);
      return { results: closest, noExactMatch: true, searchedMax: intent.maxPrice };
    }
    results = priced;
  }
  if (intent.minPrice) {
    results = results.filter(p => !p.price || p.price === 0 || p.price >= intent.minPrice);
  }
  if (intent.category) {
    results = results.filter(p => p.category.toLowerCase().includes(intent.category.toLowerCase()));
  }

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
  const dbChanges = {};
  if (changes.name        !== undefined) dbChanges.name         = changes.name;
  if (changes.price       !== undefined) dbChanges.price        = changes.price;
  if (changes.category    !== undefined) dbChanges.category     = changes.category;
  if (changes.colors      !== undefined) dbChanges.colors       = changes.colors;
  if (changes.sizes       !== undefined) { dbChanges.sizes = changes.sizes; dbChanges.has_sizes = changes.sizes.length > 0; }
  if (changes.material    !== undefined) dbChanges.material     = changes.material;
  if (changes.description !== undefined) dbChanges.description  = changes.description;
  if (changes.imageUrl    !== undefined) dbChanges.image_url    = changes.imageUrl;
  if (changes.inStock     !== undefined) dbChanges.in_stock     = changes.inStock;
  if (changes.tags        !== undefined) dbChanges.tags         = changes.tags;

  const { data, error } = await supabase
    .from("catalog").update(dbChanges)
    .eq("id", String(productId)).eq("business_id", businessId)
    .select().single();
  if (error) { console.error("[Catalog] update error:", error.message); return null; }
  return _toProduct(data);
}

// ── Toggle stock ──────────────────────────────────────────────────────────────
async function toggleStock(productId, inStock, businessId = DEFAULT_BID) {
  const { data, error } = await supabase
    .from("catalog").update({ in_stock: inStock })
    .eq("id", String(productId)).eq("business_id", businessId)
    .select().single();
  if (error) { console.error("[Catalog] toggleStock error:", error.message); return null; }
  return _toProduct(data);
}

// ── Delete product ────────────────────────────────────────────────────────────
async function deleteProduct(productId, businessId = DEFAULT_BID) {
  const { error } = await supabase
    .from("catalog").delete()
    .eq("id", String(productId)).eq("business_id", businessId);
  if (error) { console.error("[Catalog] deleteProduct error:", error.message); return false; }
  return true;
}

// ── Map DB row → app product shape ───────────────────────────────────────────
function _toProduct(row) {
  return {
    id           : row.id,
    name         : row.name,
    price        : row.price,
    category     : row.category,
    colors       : row.colors       || [],
    sizes        : row.sizes        || [],
    hasSizes     : row.has_sizes,
    material     : row.material     || "",
    description  : row.description  || "",
    imageUrl     : row.image_url    || "",
    instaPostUrl : row.insta_post_url || "",
    rating       : row.rating,
    inStock      : row.in_stock,
    tags         : row.tags         || [],
    createdAt    : new Date(row.created_at).getTime(),
  };
}

module.exports = { addProduct, getAll, get, search, update, toggleStock, deleteProduct };
