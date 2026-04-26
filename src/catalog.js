// ── Product Catalog ────────────────────────────────────────────────────────────
// Stores and searches products for a business
// In production: use PostgreSQL / Supabase
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

// In-memory store (replace with DB in production)
let products = [];

// ── Load catalog from JSON file ───────────────────────────────────────────────
function load(businessId) {
  const filePath = path.join(__dirname, `../data/catalog_${businessId}.json`);
  try {
    const data = fs.readFileSync(filePath, "utf8");
    products   = JSON.parse(data);
    console.log(`[Catalog] Loaded ${products.length} products for business ${businessId}`);
  } catch {
    console.log(`[Catalog] No catalog file found for ${businessId}, using empty`);
    products = [];
  }
}

// ── Save catalog ──────────────────────────────────────────────────────────────
function save(businessId, data) {
  const dir      = path.join(__dirname, "../data");
  const filePath = path.join(dir, `catalog_${businessId}.json`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  products = data;
}

// ── Add single product ────────────────────────────────────────────────────────
function addProduct(product) {
  const newProduct = {
    id           : Date.now().toString(),
    name         : product.name         || "",
    price        : Number(product.price) || 0,
    category     : product.category     || "general",
    colors       : product.colors       || [],
    sizes        : product.sizes        || [],
    hasSizes     : (product.sizes || []).length > 0,
    material     : product.material     || "",
    description  : product.description  || "",
    imageUrl     : product.imageUrl     || "",
    instaPostUrl : product.instaPostUrl || "",   // Instagram post link
    rating       : product.rating       || null,
    inStock      : product.inStock      !== false,
    tags         : product.tags         || [],
    createdAt    : Date.now(),
  };
  products.push(newProduct);
  _persist();
  return newProduct;
}

// ── Search products ───────────────────────────────────────────────────────────
// Intent structure (from AI):
// { product, color, size, material, maxPrice, minPrice, category, rawQuery }
function search(intent = {}) {
  let results = products.filter(p => p.inStock);

  // Filter by product name / keywords
  // Supports plural/singular: "candles" matches "candle", "jeans" matches "jean"
  if (intent.product) {
    const raw      = intent.product.toLowerCase();
    const keywords = raw.split(" ").filter(k => k.length > 1).map(kw => {
      // Build a regex that matches the word regardless of trailing s/es/ies
      if (kw.endsWith("ies")) return kw.slice(0, -3) + "y";  // accessories → accessory
      if (kw.endsWith("es"))  return kw.slice(0, -2);         // dresses → dress
      if (kw.endsWith("s"))   return kw.slice(0, -1);         // candles → candle
      return kw;
    });

    results = results.filter(p => {
      const searchable = [p.name, p.category, p.description, ...(p.tags || [])]
        .join(" ").toLowerCase();
      // A keyword matches if the searchable text contains it OR the original plural form
      return keywords.every((stem, i) => {
        const original = intent.product.toLowerCase().split(" ").filter(k => k.length > 1)[i];
        return searchable.includes(stem) || searchable.includes(original);
      });
    });
  }

  // Filter by color
  if (intent.color) {
    const color = intent.color.toLowerCase();
    results = results.filter(p =>
      !p.colors?.length || p.colors.some(c => c.toLowerCase().includes(color))
    );
  }

  // Filter by size availability
  if (intent.size) {
    const size = intent.size.toUpperCase();
    results = results.filter(p =>
      !p.sizes?.length || p.sizes.includes(size)
    );
  }

  // Filter by material
  if (intent.material) {
    const mat = intent.material.toLowerCase();
    results = results.filter(p =>
      !p.material || p.material.toLowerCase().includes(mat)
    );
  }

  // Filter by price range
  // Only apply price filter to products that HAVE a price (price > 0)
  // Products with no price / price = 0 = "contact for price" — excluded from price searches
  if (intent.maxPrice) {
    const priced   = results.filter(p => p.price > 0 && p.price <= intent.maxPrice);
    const unpriced = results.filter(p => !p.price || p.price === 0);

    // If no products found in price range, suggest closest ones
    if (!priced.length) {
      const closest = results
        .filter(p => p.price > 0)
        .sort((a, b) => a.price - b.price)
        .slice(0, 3);
      return { results: closest, noExactMatch: true, searchedMax: intent.maxPrice };
    }

    results = priced;
  }
  if (intent.minPrice) {
    results = results.filter(p => !p.price || p.price === 0 || p.price >= intent.minPrice);
  }

  // Filter by category
  if (intent.category) {
    results = results.filter(p =>
      p.category.toLowerCase().includes(intent.category.toLowerCase())
    );
  }

  // Sort: priced products by rating, then "contact for price" at end
  results.sort((a, b) => {
    // No price → go to bottom
    if (!a.price && b.price) return 1;
    if (a.price && !b.price) return -1;
    // Both priced → sort by rating desc, then price asc
    if (intent.maxPrice) return a.price - b.price;
    if (b.rating && a.rating) return b.rating - a.rating;
    return a.price - b.price;
  });

  return { results, noExactMatch: false };
}

// ── Get cheapest products in category ─────────────────────────────────────────
function getCheapest(category, limit = 3) {
  return products
    .filter(p => p.inStock && p.price > 0 &&
      (!category || p.category.toLowerCase().includes(category.toLowerCase())))
    .sort((a, b) => a.price - b.price)
    .slice(0, limit);
}

// ── Get single product ────────────────────────────────────────────────────────
function get(productId) {
  return products.find(p => p.id === productId) || null;
}

// ── Get all products ──────────────────────────────────────────────────────────
function getAll() {
  return products;
}

// ── Import from CSV string ────────────────────────────────────────────────────
function importCSV(csvText) {
  const lines  = csvText.trim().split("\n");
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const imported = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    const row  = {};
    header.forEach((h, idx) => row[h] = cols[idx] || "");

    imported.push(addProduct({
      name       : row["name"] || row["product name"],
      price      : parseFloat(row["price"]) || 0,
      category   : row["category"],
      colors     : (row["colors"] || "").split(";").map(c => c.trim()).filter(Boolean),
      sizes      : (row["sizes"] || "").split(";").map(s => s.trim()).filter(Boolean),
      material   : row["material"],
      description: row["description"],
      imageUrl   : row["image url"] || row["image"],
      rating     : parseFloat(row["rating"]) || null,
      tags       : (row["tags"] || "").split(";").map(t => t.trim()).filter(Boolean),
    }));
  }

  return imported;
}

// ── Toggle stock status ───────────────────────────────────────────────────────
function toggleStock(productId, inStock) {
  const product = products.find(p => p.id === String(productId));
  if (!product) return null;
  product.inStock   = inStock !== undefined ? Boolean(inStock) : !product.inStock;
  product.updatedAt = Date.now();
  _persist();
  return product;
}

// ── Delete product ────────────────────────────────────────────────────────────
function deleteProduct(productId) {
  const idx = products.findIndex(p => p.id === String(productId));
  if (idx === -1) return false;
  products.splice(idx, 1);
  _persist();
  return true;
}

// ── Update product fields ─────────────────────────────────────────────────────
function update(productId, changes) {
  const product = products.find(p => p.id === String(productId));
  if (!product) return null;
  Object.assign(product, changes, { updatedAt: Date.now() });
  if (changes.sizes !== undefined) product.hasSizes = product.sizes.length > 0;
  _persist();
  return product;
}

// ── Internal: persist current in-memory catalog ───────────────────────────────
function _persist() {
  const dir      = path.join(__dirname, "../data");
  const filePath = path.join(dir, "catalog_default.json");
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(products, null, 2));
  } catch (err) {
    console.error("[Catalog] Persist error:", err.message);
  }
}

// ── Load default demo catalog ─────────────────────────────────────────────────
function loadDemo() {
  products = [
    { id:"1", name:"Slim Fit Jeans",    price:799, category:"jeans",   colors:["Blue","Black"],  sizes:["28","30","32","34","36"], hasSizes:true,  material:"denim",  rating:4.3, imageUrl:"", inStock:true, tags:["jeans","denim","casual"] },
    { id:"2", name:"Bootcut Jeans",     price:649, category:"jeans",   colors:["Dark Blue"],      sizes:["28","30","32","34"],      hasSizes:true,  material:"denim",  rating:4.1, imageUrl:"", inStock:true, tags:["jeans","bootcut"] },
    { id:"3", name:"Ripped Jeans",      price:899, category:"jeans",   colors:["Light Blue"],     sizes:["28","30","32"],           hasSizes:true,  material:"denim",  rating:4.6, imageUrl:"", inStock:true, tags:["jeans","ripped","trendy"] },
    { id:"4", name:"Cotton Kurti",      price:549, category:"kurti",   colors:["White","Pink"],   sizes:["S","M","L","XL"],         hasSizes:true,  material:"cotton", rating:4.5, imageUrl:"", inStock:true, tags:["kurti","ethnic","women"] },
    { id:"5", name:"Graphic T-Shirt",   price:349, category:"tshirt",  colors:["Black","White"],  sizes:["S","M","L","XL","XXL"],   hasSizes:true,  material:"cotton", rating:4.2, imageUrl:"", inStock:true, tags:["tshirt","casual","men"] },
    { id:"6", name:"Floral Saree",      price:1299,category:"saree",   colors:["Red","Green"],    sizes:["Free Size"],              hasSizes:false, material:"silk",   rating:4.7, imageUrl:"", inStock:true, tags:["saree","ethnic","women"] },
    { id:"7", name:"Formal Shirt",      price:899, category:"shirt",   colors:["White","Blue"],   sizes:["S","M","L","XL"],         hasSizes:true,  material:"cotton", rating:4.4, imageUrl:"", inStock:true, tags:["shirt","formal","men"] },
    { id:"8", name:"Track Pants",       price:499, category:"pants",   colors:["Black","Grey"],   sizes:["S","M","L","XL","XXL"],   hasSizes:true,  material:"polyester",rating:4.0,imageUrl:"",inStock:true, tags:["trackpants","sports","casual"] },
  ];
}

// ── Load persisted catalog on startup (start empty if no file) ────────────────
function _loadOrDemo() {
  const filePath = path.join(__dirname, "../data/catalog_default.json");
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (saved && saved.length) {
      products = saved;
      console.log(`[Catalog] Loaded ${products.length} products from disk`);
      return;
    }
  } catch {}
  products = [];
  console.log("[Catalog] Starting with empty catalog");
}

_loadOrDemo();

module.exports = { load, save, addProduct, search, get, getAll, importCSV, loadDemo, toggleStock, deleteProduct, update };
