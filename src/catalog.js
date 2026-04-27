// ── Product Catalog — Railway PostgreSQL backed ────────────────────────────────
const db = require("./db");

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

  try {
    const { rows } = await db.query(
      `INSERT INTO catalog
         (id, business_id, name, price, category, colors, sizes, has_sizes,
          material, description, image_url, insta_post_url, rating, in_stock, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        row.id, row.business_id, row.name, row.price, row.category,
        JSON.stringify(row.colors), JSON.stringify(row.sizes), row.has_sizes,
        row.material, row.description, row.image_url, row.insta_post_url,
        row.rating, row.in_stock, JSON.stringify(row.tags),
      ]
    );
    return _toProduct(rows[0]);
  } catch (e) {
    console.error("[Catalog] addProduct error:", e.message);
    return _toProduct(row);
  }
}

// ── Get all products ──────────────────────────────────────────────────────────
async function getAll(businessId = DEFAULT_BID) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM catalog WHERE business_id = $1 ORDER BY created_at ASC`,
      [businessId]
    );
    return rows.map(_toProduct);
  } catch (e) {
    console.error("[Catalog] getAll error:", e.message);
    return [];
  }
}

// ── Get single product ────────────────────────────────────────────────────────
async function get(productId, businessId = DEFAULT_BID) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM catalog WHERE id = $1 AND business_id = $2`,
      [String(productId), businessId]
    );
    return rows[0] ? _toProduct(rows[0]) : null;
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
    const priced = results.filter(p => p.price > 0 && p.price <= intent.maxPrice);
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
  const sets = [];
  const vals = [];
  let i = 1;

  if (changes.name        !== undefined) { sets.push(`name=$${i++}`);        vals.push(changes.name); }
  if (changes.price       !== undefined) { sets.push(`price=$${i++}`);       vals.push(changes.price); }
  if (changes.category    !== undefined) { sets.push(`category=$${i++}`);    vals.push(changes.category); }
  if (changes.colors      !== undefined) { sets.push(`colors=$${i++}`);      vals.push(JSON.stringify(changes.colors)); }
  if (changes.sizes       !== undefined) {
    sets.push(`sizes=$${i++}`);    vals.push(JSON.stringify(changes.sizes));
    sets.push(`has_sizes=$${i++}`); vals.push(changes.sizes.length > 0);
  }
  if (changes.material    !== undefined) { sets.push(`material=$${i++}`);    vals.push(changes.material); }
  if (changes.description !== undefined) { sets.push(`description=$${i++}`); vals.push(changes.description); }
  if (changes.imageUrl    !== undefined) { sets.push(`image_url=$${i++}`);   vals.push(changes.imageUrl); }
  if (changes.inStock     !== undefined) { sets.push(`in_stock=$${i++}`);    vals.push(changes.inStock); }
  if (changes.tags        !== undefined) { sets.push(`tags=$${i++}`);        vals.push(JSON.stringify(changes.tags)); }

  if (!sets.length) return get(productId, businessId);

  vals.push(String(productId), businessId);
  try {
    const { rows } = await db.query(
      `UPDATE catalog SET ${sets.join(", ")} WHERE id=$${i} AND business_id=$${i + 1} RETURNING *`,
      vals
    );
    return rows[0] ? _toProduct(rows[0]) : null;
  } catch (e) {
    console.error("[Catalog] update error:", e.message);
    return null;
  }
}

// ── Toggle stock ──────────────────────────────────────────────────────────────
async function toggleStock(productId, inStock, businessId = DEFAULT_BID) {
  try {
    const { rows } = await db.query(
      `UPDATE catalog SET in_stock=$1 WHERE id=$2 AND business_id=$3 RETURNING *`,
      [inStock, String(productId), businessId]
    );
    return rows[0] ? _toProduct(rows[0]) : null;
  } catch (e) {
    console.error("[Catalog] toggleStock error:", e.message);
    return null;
  }
}

// ── Delete product ────────────────────────────────────────────────────────────
async function deleteProduct(productId, businessId = DEFAULT_BID) {
  try {
    await db.query(
      `DELETE FROM catalog WHERE id=$1 AND business_id=$2`,
      [String(productId), businessId]
    );
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
    rating       : row.rating       != null ? Number(row.rating) : null,
    inStock      : row.in_stock,
    tags         : row.tags         || [],
    createdAt    : row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

module.exports = { addProduct, getAll, get, search, update, toggleStock, deleteProduct };
