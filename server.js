'use strict';

/**
 * ZHEND'OR Joyería — servidor (Node puro, sin dependencias).
 * Sirve el frontend estático, la API pública y la API de administración protegida.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { initDb, verifyPassword } = require('./db');
const pricing = require('./pricing');

/* ------------------------------------------------------------------ */
/* Entorno y rutas                                                    */
/* ------------------------------------------------------------------ */

const BASE_DIR = __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, 'public');

function loadEnv(file) {
  const env = {};
  try {
    const content = fs.readFileSync(file, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch {
    /* el archivo .env es opcional */
  }
  return env;
}

const env = { ...loadEnv(path.join(BASE_DIR, '.env')), ...process.env };

const PORT = Number.parseInt(env.PORT || '3000', 10) || 3000;
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || 'Cambiar123*';
const ADMIN_USER = (env.ADMIN_USER || env.ADMIN_EMAIL || 'admin').trim();
const SESSION_DAYS = Number.parseInt(env.SESSION_DAYS || '7', 10) || 7;
// Cookie `Secure` debe activarse en producción (HTTPS). Detrás de HTTPS local
// puede dejarse en "false" para permitir sesiones en http://localhost.
const COOKIE_SECURE = String(env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
const COOKIE_NAME = 'zhendor_session';
const MAX_BODY = 12 * 1024 * 1024; // 12 MB (imágenes en base64)
// Directorio de datos configurable (útil para pruebas o despliegues alternos)
const DATA_DIR = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(BASE_DIR, 'data');
// Imágenes bajo DATA_DIR para que base + archivos vivan en el mismo volumen
const UPLOADS_DIR = env.UPLOADS_DIR ? path.resolve(env.UPLOADS_DIR) : path.join(DATA_DIR, 'uploads');
const PRODUCTS_DIR = path.join(UPLOADS_DIR, 'products');

for (const dir of [DATA_DIR, UPLOADS_DIR, PRODUCTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* Base de datos                                                      */
/* ------------------------------------------------------------------ */

const db = new DatabaseSync(path.join(DATA_DIR, 'zhendor.db'));
initDb(db, { adminPassword: ADMIN_PASSWORD, adminUser: ADMIN_USER });

const stmts = {
  productsPublic: db.prepare(
    `SELECT id, name, description, price, weight, status, image, category,
            discount_type, discount_value, discount_active, discount_start, discount_end
     FROM products WHERE published = 1 ORDER BY id ASC`
  ),
  productPublicById: db.prepare(
    `SELECT id, name, description, price, weight, status, image, category,
            discount_type, discount_value, discount_active, discount_start, discount_end
     FROM products WHERE published = 1 AND id = ?`
  ),
  productsAll: db.prepare(
    `SELECT id, name, description, price, weight, status, published, image, category,
            discount_type, discount_value, discount_active, discount_start, discount_end,
            created_at, updated_at
     FROM products ORDER BY id DESC`
  ),
  productById: db.prepare('SELECT * FROM products WHERE id = ?'),
  insertProduct: db.prepare(`
    INSERT INTO products (name, description, price, weight, status, published, category, image,
      discount_type, discount_value, discount_active, discount_start, discount_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateProduct: db.prepare(`
    UPDATE products
    SET name = ?, description = ?, price = ?, weight = ?, status = ?, published = ?, category = ?, image = ?,
        discount_type = ?, discount_value = ?, discount_active = ?, discount_start = ?, discount_end = ?,
        updated_at = ?
    WHERE id = ?`),
  deleteProduct: db.prepare('DELETE FROM products WHERE id = ?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  adminUser: db.prepare('SELECT username, password_hash FROM admin_user WHERE id = 1'),
  createSession: db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)'),
  session: db.prepare('SELECT created_at FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  /* --- Categorías --- */
  categoriesAll: db.prepare('SELECT slug, name, sort_order FROM categories ORDER BY sort_order, name'),
  categoryBySlug: db.prepare('SELECT * FROM categories WHERE slug = ?'),
  categoryExists: db.prepare('SELECT 1 FROM categories WHERE slug = ?'),
  categoryCountFor: db.prepare('SELECT COUNT(*) AS c FROM products WHERE category = ?'),
  insertCategory: db.prepare('INSERT INTO categories (slug, name, sort_order) VALUES (?, ?, ?)'),
  updateCategory: db.prepare('UPDATE categories SET name = ?, sort_order = ? WHERE slug = ?'),
  deleteCategory: db.prepare('DELETE FROM categories WHERE slug = ?'),
  /* --- Variantes --- */
  variantGroups: db.prepare('SELECT * FROM variant_groups WHERE product_id = ? ORDER BY sort_order, id'),
  variantOptions: db.prepare('SELECT * FROM variant_options WHERE group_id = ? ORDER BY sort_order, id'),
  insertVariantGroup: db.prepare(
    'INSERT INTO variant_groups (product_id, name, required, sort_order) VALUES (?, ?, ?, ?)'
  ),
  insertVariantOption: db.prepare(
    'INSERT INTO variant_options (group_id, label, color, available, sort_order) VALUES (?, ?, ?, ?, ?)'
  ),
  deleteVariantGroups: db.prepare('DELETE FROM variant_groups WHERE product_id = ?'),
  deleteVariantOptionsForGroup: db.prepare('DELETE FROM variant_options WHERE group_id = ?'),
  allVariantGroups: db.prepare('SELECT * FROM variant_groups ORDER BY product_id, sort_order, id'),
  allVariantOptions: db.prepare('SELECT * FROM variant_options ORDER BY group_id, sort_order, id')
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

function getPublicSettings() {
  const s = getSettings();
  return {
    brand_name: s.brand_name,
    tagline: s.tagline,
    slogan: s.slogan,
    hero_phrase: s.hero_phrase,
    whatsapp: s.whatsapp,
    contact_email: s.contact_email,
    contact_phone: s.contact_phone,
    address: s.address,
    description: s.description,
    footer_text: s.footer_text,
    shipping_cost: s.shipping_cost,
    logo: s.logo
  };
}

/* ------------------------------------------------------------------ */
/* Categorías y variantes                                             */
/* ------------------------------------------------------------------ */

function categoryName(slug) {
  if (!slug) return '';
  const row = stmts.categoryBySlug.get(slug);
  return row ? row.name : slug;
}

function getCategories() {
  return stmts.categoriesAll.all();
}

function getVariants(productId) {
  const groups = stmts.variantGroups.all(productId);
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    required: Number(g.required) === 1,
    sort_order: g.sort_order,
    options: stmts.variantOptions.all(g.id).map((o) => ({
      id: o.id,
      label: o.label,
      color: o.color || '',
      available: Number(o.available) === 1,
      sort_order: o.sort_order
    }))
  }));
}

// Producto con categoría y variantes incluidas (para público y admin).
function attachProduct(row) {
  const pub = pricing.serializeProduct(row);
  pub.category = row.category || '';
  pub.category_name = categoryName(pub.category);
  pub.variants = getVariants(row.id);
  return pub;
}

function slugify(value) {
  const s = cleanStr(String(value ?? ''), 60)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s;
}

// Reemplaza todas las variantes de un producto de forma transaccional.
function replaceVariants(productId, groupsInput) {
  const groups = Array.isArray(groupsInput) ? groupsInput : [];
  db.exec('BEGIN');
  try {
    const existing = stmts.variantGroups.all(productId);
    for (const g of existing) stmts.deleteVariantOptionsForGroup.run(g.id);
    stmts.deleteVariantGroups.run(productId);

    let groupOrder = 0;
    for (const g of groups) {
      const name = cleanStr(g.name, 80);
      if (!name) continue;
      const required = g.required === true || g.required === 1 || g.required === 'true' ? 1 : 0;
      const grp = stmts.insertVariantGroup.run(productId, name, required, groupOrder++);
      const groupId = Number(grp.lastInsertRowid);
      const options = Array.isArray(g.options) ? g.options : [];
      let optionOrder = 0;
      for (const o of options) {
        const label = cleanStr(o.label, 80);
        if (!label) continue;
        const color = cleanStr(o.color, 20);
        const available = o.available === false || o.available === 0 || o.available === 'false' ? 0 : 1;
        stmts.insertVariantOption.run(groupId, label, color, available, optionOrder++);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Valida las selecciones de variantes contra un producto y devuelve las
// selecciones normalizadas (fuente de verdad para el pedido).
function buildSelections(product, rawSelections) {
  const groups = getVariants(product.id);
  const errors = [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const picked = new Map();

  for (const sel of rawSelections || []) {
    if (!sel) continue;
    const gid = Number(sel.group_id);
    const oid = Number(sel.option_id);
    if (!Number.isFinite(gid) || !Number.isFinite(oid)) {
      errors.push('La configuración del producto no es válida.');
      continue;
    }
    const group = byId.get(gid);
    if (!group) {
      errors.push('La configuración del producto no es válida.');
      continue;
    }
    const option = group.options.find((o) => o.id === oid);
    if (!option) {
      errors.push(`La opción de "${group.name}" ya no está disponible. Actualiza tu selección.`);
      continue;
    }
    if (!option.available) {
      errors.push(`La opción "${option.label}" de ${group.name} está agotada.`);
      continue;
    }
    picked.set(gid, option);
  }

  for (const group of groups) {
    if (group.required && !picked.has(group.id)) {
      errors.push(`Selecciona ${group.name} para poder continuar.`);
    }
  }

  const selections = groups
    .filter((g) => picked.has(g.id))
    .map((g) => {
      const opt = picked.get(g.id);
      return {
        group_id: g.id,
        group_name: g.name,
        option_id: opt.id,
        option_label: opt.label,
        color: opt.color || ''
      };
    });
  return { errors, selections };
}

function parseShippingValue(shippingCost) {
  if (shippingCost === null || shippingCost === undefined || String(shippingCost).trim() === '') {
    return null;
  }
  return Math.max(0, pricing.toInt(shippingCost));
}

/* ------------------------------------------------------------------ */
/* Utilidades HTTP                                                    */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('El cuerpo de la solicitud es demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('El cuerpo no es JSON válido.');
  }
}

/* ------------------------------------------------------------------ */
/* Autenticación de administrador                                     */
/* ------------------------------------------------------------------ */

const loginAttempts = new Map(); // ip -> { count, resetAt }

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (record.count >= 8) return false;
  record.count += 1;
  return true;
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function sessionToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return parseCookies(req)[COOKIE_NAME] || '';
}

function sessionCookie(token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  stmts.createSession.run(token, new Date().toISOString());
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const row = stmts.session.get(token);
  if (!row) return false;
  const expires = new Date(row.created_at).getTime() + SESSION_DAYS * 24 * 3600 * 1000;
  if (Date.now() > expires) {
    stmts.deleteSession.run(token);
    return false;
  }
  return true;
}

function isAuthenticated(req) {
  return validateSession(sessionToken(req));
}

function requireAdmin(req, res) {
  if (!isAuthenticated(req)) {
    sendJson(res, 401, { error: 'No autorizado. Inicia sesión en el panel de administración.' });
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Imágenes                                                          */
/* ------------------------------------------------------------------ */

function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return null;
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  return { ext, buf };
}

function saveImage(dataUrl, subDir) {
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) return null;
  const dir = subDir === 'logo' ? UPLOADS_DIR : PRODUCTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${decoded.ext}`;
  const target = path.join(dir, filename);
  fs.writeFileSync(target, decoded.buf);
  return `/uploads/${subDir === 'logo' ? '' : 'products/'}${filename}`;
}

function removeImage(imagePath) {
  if (!imagePath || !imagePath.startsWith('/uploads/')) return;
  const full = path.join(UPLOADS_DIR, imagePath.slice('/uploads/'.length));
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch {
    /* no es crítico */
  }
}

/* ------------------------------------------------------------------ */
/* Validación de entrada                                              */
/* ------------------------------------------------------------------ */

const cleanStr = (value, max) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

// Convierte precios escritos en español (p. ej. "113.900") a enteros,
// descartando separadores de miles y decimales que romperían parseInt.
const copInt = (value) => {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  const n = digits === '' ? NaN : Number.parseInt(digits, 10);
  return Number.isFinite(n) ? n : NaN;
};

function normalizeDate(value, errors, label) {
  const s = cleanStr(value, 20);
  if (s === '') return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    errors.push(`La fecha de ${label} del descuento no es válida (usa AAAA-MM-DD).`);
    return '';
  }
  return s;
}

function validateProductInput(data, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || data.name !== undefined) {
    const name = cleanStr(data.name, 120);
    if (name.length < 2) errors.push('El nombre debe tener al menos 2 caracteres.');
    out.name = name;
  }
  if (!partial || data.description !== undefined) {
    out.description = cleanStr(data.description, 2000);
  }
  if (!partial || data.price !== undefined) {
    const price = copInt(data.price);
    if (!Number.isFinite(price) || price < 1 || price > 999999999) {
      errors.push('El precio debe ser un número entero positivo (ej. 113900 o 113.900).');
    }
    out.price = price;
  }
  if (!partial || data.weight !== undefined) {
    out.weight = cleanStr(data.weight, 80);
  }
  if (!partial || data.category !== undefined) {
    const category = cleanStr(data.category, 60);
    if (category && !stmts.categoryBySlug.get(category)) {
      errors.push('La categoría seleccionada no existe.');
    }
    out.category = category;
  }
  if (!partial || data.status !== undefined) {
    const status = cleanStr(data.status, 20);
    if (!['available', 'out_of_stock'].includes(status)) {
      errors.push('Estado no válido.');
    }
    out.status = status;
  }
  if (!partial || data.published !== undefined) {
    const published = data.published === true || data.published === 1 || data.published === 'true';
    out.published = published ? 1 : 0;
  }

  /* --- Descuentos --- */
  if (!partial || data.discount_type !== undefined) {
    const type = data.discount_type === undefined ? 'none' : cleanStr(data.discount_type, 10);
    if (!['none', 'percent', 'fixed'].includes(type)) {
      errors.push('Tipo de descuento no válido.');
    }
    out.discount_type = type;
  }
  if (!partial || data.discount_value !== undefined) {
    const raw = data.discount_value;
    const value = raw === undefined || raw === null || raw === '' ? 0 : copInt(raw);
    if (!Number.isFinite(value) || value < 0) {
      errors.push('El valor del descuento debe ser un número positivo.');
    }
    out.discount_value = Number.isFinite(value) ? value : 0;
  }
  if (!partial || data.discount_active !== undefined) {
    const active = data.discount_active === true || data.discount_active === 1 || data.discount_active === 'true';
    out.discount_active = active ? 1 : 0;
  }
  if (!partial || data.discount_start !== undefined) {
    out.discount_start = normalizeDate(data.discount_start, errors, 'inicio');
  }
  if (!partial || data.discount_end !== undefined) {
    out.discount_end = normalizeDate(data.discount_end, errors, 'fin');
  }

  return { errors, out };
}

// Reglas que dependen del precio final ya fusionado.
function validateDiscountRules(product) {
  const errors = [];
  const type = product.discount_type || 'none';
  const value = Number.parseInt(product.discount_value, 10) || 0;
  const price = Number.parseInt(product.price, 10) || 0;

  if (type === 'percent' && value > 100) {
    errors.push('El porcentaje de descuento no puede superar el 100 %.');
  }
  if (type === 'fixed' && value > price) {
    errors.push('El descuento fijo no puede ser mayor que el precio.');
  }
  if (type !== 'none' && product.discount_start && product.discount_end &&
      product.discount_start > product.discount_end) {
    errors.push('La fecha de inicio del descuento no puede ser posterior a la de fin.');
  }
  if (Number(product.discount_active) && type !== 'none') {
    const final = pricing.finalPrice(product);
    if (final < 0) errors.push('El descuento no puede dar un precio final negativo.');
  }
  return errors;
}

function validateSettingsInput(data) {
  const errors = [];
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined;

  if (has('brand_name')) {
    const brandName = cleanStr(data.brand_name, 60);
    if (brandName.length < 1) errors.push('El nombre comercial es obligatorio.');
    out.brand_name = brandName;
  }

  if (has('tagline')) out.tagline = cleanStr(data.tagline, 60);
  if (has('slogan')) out.slogan = cleanStr(data.slogan, 60);
  if (has('hero_phrase')) out.hero_phrase = cleanStr(data.hero_phrase, 300);
  if (has('description')) out.description = cleanStr(data.description, 5000);
  if (has('footer_text')) out.footer_text = cleanStr(data.footer_text, 300);

  if (has('whatsapp')) {
    const whatsapp = cleanStr(data.whatsapp, 20).replace(/[^\d]/g, '');
    if (whatsapp && (whatsapp.length < 8 || whatsapp.length > 15)) {
      errors.push('El número de WhatsApp debe tener entre 8 y 15 dígitos (con prefijo internacional, ej. 57...).');
    }
    out.whatsapp = whatsapp;
  }

  if (has('contact_email')) {
    const email = cleanStr(data.contact_email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('El correo de contacto no es válido.');
    }
    out.contact_email = email;
  }

  if (has('contact_phone')) out.contact_phone = cleanStr(data.contact_phone, 40);
  if (has('address')) out.address = cleanStr(data.address, 200);

  if (has('shipping_cost')) {
    const shipRaw = String(data.shipping_cost ?? '').trim();
    if (shipRaw === '') {
      out.shipping_cost = '';
    } else {
      const ship = copInt(shipRaw);
      if (!Number.isFinite(ship) || ship < 0 || ship > 10000000) {
        errors.push('El costo de envío no es válido (deja vacío para "por confirmar").');
      }
      out.shipping_cost = String(ship);
    }
  }

  if (has('logo')) {
    if (data.logo === '' || data.logo === null) {
      out.logo = ''; // cadena vacía = quitar el logotipo
    } else if (typeof data.logo === 'string' && data.logo.startsWith('data:image/')) {
      out.logo = data.logo;
    } else {
      errors.push('El logotipo debe ser una imagen (PNG, JPG o WebP).');
    }
  }

  return { errors, out };
}

/* ------------------------------------------------------------------ */
/* Placeholder elegante (fallback de imágenes)                        */
/* ------------------------------------------------------------------ */

function placeholderSvg(text) {
  const safe = cleanStr(text, 40) || 'ZHEND’OR';
  const initial = (safe[0] || 'Z').toUpperCase();
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1125" viewBox="0 0 900 1125">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F5EED9"/>
      <stop offset="1" stop-color="#E9DDBA"/>
    </linearGradient>
  </defs>
  <rect width="900" height="1125" fill="url(#g)"/>
  <circle cx="450" cy="470" r="150" fill="none" stroke="#D8BE69" stroke-width="1.5" opacity="0.55"/>
  <circle cx="450" cy="470" r="120" fill="none" stroke="#D8BE69" stroke-width="1" opacity="0.4"/>
  <text x="450" y="500" font-family="Georgia, 'Times New Roman', serif" font-size="150" fill="#B8933D" text-anchor="middle" opacity="0.85">${esc(initial)}</text>
  <text x="450" y="700" font-family="Georgia, serif" font-size="34" letter-spacing="8" fill="#8a7a5a" text-anchor="middle">${esc(safe)}</text>
  <text x="450" y="745" font-family="Georgia, serif" font-size="20" letter-spacing="10" fill="#a3906a" text-anchor="middle">JEWELRY</text>
</svg>`;
}

/* ------------------------------------------------------------------ */
/* Router                                                             */
/* ------------------------------------------------------------------ */

const routes = [];

function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)')) + '$'
  );
  routes.push({ method, regex, keys, handler });
}

/* --- API pública --- */

route('GET', '/api/products', (req, res) => {
  const products = stmts.productsPublic.all().map((p) => attachProduct(p));
  sendJson(res, 200, { products });
});

route('GET', '/api/products/:id', (req, res, params) => {
  const id = Number.parseInt(params.id, 10);
  const product = Number.isFinite(id) ? stmts.productPublicById.get(id) : undefined;
  if (!product) return sendJson(res, 404, { error: 'Producto no encontrado.' });
  sendJson(res, 200, { product: attachProduct(product) });
});

route('GET', '/api/categories', (req, res) => {
  sendJson(res, 200, { categories: getCategories() });
});

route('GET', '/api/settings', (req, res) => {
  sendJson(res, 200, { settings: getPublicSettings() });
});

// Cotización de un pedido calculada en el servidor (fuente de verdad del precio).
// Acepta un solo producto (product_id + quantity, formato clásico) o varios
// (items: [{product_id, quantity, variant_selections}]).
route('POST', '/api/order/quote', async (req, res) => {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const shippingCost = getSettings().shipping_cost;

  // --- Modo clásico: un solo producto ---
  if (!Array.isArray(body.items)) {
    const id = pricing.toInt(body.product_id);
    const product = Number.isFinite(id) ? stmts.productPublicById.get(id) : undefined;
    if (!product) {
      return sendJson(res, 404, { error: 'El producto no está disponible.' });
    }
    if (product.status === 'out_of_stock') {
      return sendJson(res, 409, { error: 'Esta pieza está agotada por el momento.' });
    }
    const { errors, selections } = buildSelections(product, body.variant_selections);
    if (errors.length) {
      return sendJson(res, 400, { error: errors[0], errors });
    }
    const quote = pricing.computeQuote(product, body.quantity, shippingCost);
    quote.variants = selections;
    return sendJson(res, 200, { quote });
  }

  // --- Modo carrito: varios productos ---
  if (!body.items.length) {
    return sendJson(res, 400, { error: 'El carrito está vacío.' });
  }
  const items = [];
  for (const it of body.items) {
    const pid = pricing.toInt(it && it.product_id);
    const product = Number.isFinite(pid) ? stmts.productPublicById.get(pid) : undefined;
    if (!product) {
      return sendJson(res, 409, { error: 'Uno de los productos ya no está disponible. Revisa tu carrito.' });
    }
    if (product.status === 'out_of_stock') {
      return sendJson(res, 409, { error: `"${product.name}" está agotado por el momento. Revisa tu carrito.` });
    }
    const { errors, selections } = buildSelections(product, it.variant_selections);
    if (errors.length) {
      return sendJson(res, 400, { error: errors[0], errors, product_id: pid });
    }
    const line = pricing.computeQuote(product, it.quantity, shippingCost);
    line.product_id = product.id;
    line.name = product.name;
    line.image = product.image || '';
    line.category = product.category || '';
    line.category_name = categoryName(line.category);
    line.variants = selections;
    items.push(line);
  }

  const subtotal = items.reduce((sum, it) => sum + it.subtotal, 0);
  const discountAmount = items.reduce((sum, it) => sum + it.discount_amount, 0);
  const shipping = parseShippingValue(shippingCost);
  const quote = {
    items,
    subtotal,
    discount_amount: discountAmount,
    shipping,
    total: shipping === null ? null : subtotal + shipping
  };
  sendJson(res, 200, { quote });
});

/* --- API de administración (protegida) --- */

route('POST', '/api/admin/login', async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!checkLoginRateLimit(ip)) {
    return sendJson(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const username = cleanStr(body.username ?? body.user ?? body.email, 120);
  const password = typeof body.password === 'string' ? body.password : '';

  const row = stmts.adminUser.get();
  const storedHash = (row && row.password_hash) || 'x:y';

  // Se verifica siempre (aunque el usuario no exista) para no filtrar por tiempo.
  const passwordOk = verifyPassword(password, storedHash);
  const userOk =
    !!row &&
    !!username &&
    String(row.username || '').toLowerCase() === username.toLowerCase();
  const ok = !!row && username !== '' && password !== '' && userOk && passwordOk;

  if (!ok) {
    return sendJson(res, 401, { error: 'Usuario o contraseña incorrectos.' });
  }

  clearLoginAttempts(ip);
  const token = createSession();
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 24 * 3600));
  sendJson(res, 200, { token, user: row.username });
});

route('POST', '/api/admin/logout', (req, res) => {
  const token = sessionToken(req);
  if (token) stmts.deleteSession.run(token);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/admin/me', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const row = stmts.adminUser.get();
  sendJson(res, 200, { ok: true, user: row ? row.username : null });
});

route('GET', '/api/admin/products', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const products = stmts.productsAll.all().map((p) => {
    const attached = attachProduct(p);
    return {
      ...attached,
      published: p.published,
      discount_type: p.discount_type,
      discount_value: p.discount_value,
      discount_active: p.discount_active,
      discount_start: p.discount_start,
      discount_end: p.discount_end,
      created_at: p.created_at,
      updated_at: p.updated_at
    };
  });
  sendJson(res, 200, { products });
});

route('POST', '/api/admin/products', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const { errors, out } = validateProductInput(body);

  const merged = {
    name: out.name,
    description: out.description ?? '',
    price: out.price,
    weight: out.weight ?? '',
    category: out.category ?? '',
    status: out.status,
    published: out.published,
    discount_type: out.discount_type ?? 'none',
    discount_value: out.discount_value ?? 0,
    discount_active: out.discount_active ?? 0,
    discount_start: out.discount_start ?? '',
    discount_end: out.discount_end ?? ''
  };
  errors.push(...validateDiscountRules(merged));
  if (errors.length) return sendJson(res, 400, { errors });

  let image = '';
  if (body.image) {
    const saved = saveImage(body.image, 'products');
    if (!saved) return sendJson(res, 400, { errors: ['La imagen debe ser PNG, JPG o WebP y pesar menos de 8 MB.'] });
    image = saved;
  }

  const now = new Date().toISOString();
  const result = stmts.insertProduct.run(
    merged.name, merged.description, merged.price, merged.weight, merged.status, merged.published, merged.category, image,
    merged.discount_type, merged.discount_value, merged.discount_active, merged.discount_start, merged.discount_end,
    now, now
  );
  const product = stmts.productById.get(Number(result.lastInsertRowid));
  if (Array.isArray(body.variants) && body.variants.length) {
    replaceVariants(product.id, body.variants);
  }
  sendJson(res, 201, { product: attachProduct(product), raw: product });
});

route('PUT', '/api/admin/products/:id', async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(params.id, 10);
  const existing = Number.isFinite(id) ? stmts.productById.get(id) : undefined;
  if (!existing) return sendJson(res, 404, { error: 'Producto no encontrado.' });

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const { errors, out } = validateProductInput(body, { partial: true });

  let image = existing.image;
  if (body.image !== undefined && body.image !== null && body.image !== '') {
    const saved = saveImage(body.image, 'products');
    if (!saved) return sendJson(res, 400, { errors: ['La imagen debe ser PNG, JPG o WebP y pesar menos de 8 MB.'] });
    if (image) removeImage(image);
    image = saved;
  }

  const pick = (key, fallback) => (out[key] !== undefined ? out[key] : fallback);
  const merged = {
    name: pick('name', existing.name),
    description: pick('description', existing.description),
    price: pick('price', existing.price),
    weight: pick('weight', existing.weight),
    category: pick('category', existing.category),
    status: pick('status', existing.status),
    published: pick('published', existing.published),
    image,
    discount_type: pick('discount_type', existing.discount_type),
    discount_value: pick('discount_value', existing.discount_value),
    discount_active: pick('discount_active', existing.discount_active),
    discount_start: pick('discount_start', existing.discount_start),
    discount_end: pick('discount_end', existing.discount_end)
  };

  errors.push(...validateDiscountRules(merged));
  if (errors.length) {
    if (image !== existing.image && body.image) removeImage(image);
    return sendJson(res, 400, { errors });
  }

  stmts.updateProduct.run(
    merged.name, merged.description, merged.price, merged.weight, merged.status, merged.published, merged.category, merged.image,
    merged.discount_type, merged.discount_value, merged.discount_active, merged.discount_start, merged.discount_end,
    new Date().toISOString(), id
  );
  if (Array.isArray(body.variants)) {
    replaceVariants(id, body.variants);
  }
  const product = stmts.productById.get(id);
  sendJson(res, 200, { product: attachProduct(product), raw: product });
});

route('DELETE', '/api/admin/products/:id', (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(params.id, 10);
  const existing = Number.isFinite(id) ? stmts.productById.get(id) : undefined;
  if (!existing) return sendJson(res, 404, { error: 'Producto no encontrado.' });
  if (existing.image) removeImage(existing.image);
  const groups = stmts.variantGroups.all(id);
  for (const g of groups) stmts.deleteVariantOptionsForGroup.run(g.id);
  stmts.deleteVariantGroups.run(id);
  stmts.deleteProduct.run(id);
  sendJson(res, 200, { ok: true });
});

/* --- Gestión de categorías (protegida) --- */

route('GET', '/api/admin/categories', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const categories = getCategories().map((c) => ({
    ...c,
    product_count: stmts.categoryCountFor.get(c.slug).c
  }));
  sendJson(res, 200, { categories });
});

route('POST', '/api/admin/categories', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const name = cleanStr(body.name, 60);
  if (name.length < 2) return sendJson(res, 400, { error: 'El nombre debe tener al menos 2 caracteres.' });
  let slug = slugify(name);
  if (!slug) return sendJson(res, 400, { error: 'El nombre de la categoría no es válido.' });
  if (stmts.categoryBySlug.get(slug)) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }
  stmts.insertCategory.run(slug, name, 0);
  sendJson(res, 201, { category: { slug, name, sort_order: 0 } });
});

route('PUT', '/api/admin/categories/:slug', async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const slug = params.slug;
  const existing = stmts.categoryBySlug.get(slug);
  if (!existing) return sendJson(res, 404, { error: 'Categoría no encontrada.' });
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const name = body.name === undefined ? existing.name : cleanStr(body.name, 60);
  if (name.length < 2) return sendJson(res, 400, { error: 'El nombre debe tener al menos 2 caracteres.' });
  const sortOrder =
    body.sort_order === undefined ? existing.sort_order : Math.max(0, pricing.toInt(body.sort_order));
  stmts.updateCategory.run(name, sortOrder, slug);
  sendJson(res, 200, { category: { slug, name, sort_order: sortOrder } });
});

route('DELETE', '/api/admin/categories/:slug', (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const slug = params.slug;
  const existing = stmts.categoryBySlug.get(slug);
  if (!existing) return sendJson(res, 404, { error: 'Categoría no encontrada.' });
  const count = stmts.categoryCountFor.get(slug).c;
  if (count > 0) {
    return sendJson(res, 409, { error: 'No se puede eliminar una categoría que tiene productos. Reasigna los productos primero.' });
  }
  stmts.deleteCategory.run(slug);
  sendJson(res, 200, { ok: true });
});

/* --- Variantes de producto (protegida) --- */

route('PUT', '/api/admin/products/:id/variants', async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(params.id, 10);
  const existing = Number.isFinite(id) ? stmts.productById.get(id) : undefined;
  if (!existing) return sendJson(res, 404, { error: 'Producto no encontrado.' });
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  try {
    replaceVariants(id, body.groups);
  } catch (error) {
    console.error('[Variantes]', error);
    return sendJson(res, 500, { error: 'No se pudieron guardar las variantes.' });
  }
  sendJson(res, 200, { variants: getVariants(id) });
});

/* --- Paleta de colores del editor de productos (protegida) --- */

function normalizeHex(value) {
  let hex = String(value || '').trim().toLowerCase();
  if (!hex) return null;
  if (hex[0] !== '#') hex = '#' + hex;
  if (/^#([0-9a-f]{3})$/.test(hex)) {
    hex = '#' + hex.slice(1).split('').map((d) => d + d).join('');
  }
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

function parsePalette() {
  let parsed = [];
  try {
    parsed = JSON.parse(getSettings().color_palette || '[]');
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c) => c && typeof c.label === 'string' && normalizeHex(c.hex))
    .map((c) => ({ label: cleanStr(c.label, 40) || c.hex, hex: normalizeHex(c.hex) }));
}

route('GET', '/api/admin/palette', (req, res) => {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { colors: parsePalette() });
});

route('PUT', '/api/admin/palette', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const colors = Array.isArray(body.colors) ? body.colors : [];
  if (colors.length > 400) {
    return sendJson(res, 400, { error: 'Demasiados colores en la paleta.' });
  }
  const seen = new Set();
  const out = [];
  for (const c of colors) {
    const hex = c && c.hex ? normalizeHex(c.hex) : null;
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push({ label: cleanStr(c.label, 40) || hex, hex });
  }
  stmts.setSetting.run('color_palette', JSON.stringify(out));
  sendJson(res, 200, { colors: out });
});

route('GET', '/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { settings: getPublicSettings() });
});

route('PUT', '/api/admin/settings', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const { errors, out } = validateSettingsInput(body);
  if (errors.length) return sendJson(res, 400, { errors });

  const previous = getSettings();

  if (out.logo !== undefined) {
    if (out.logo === '') {
      if (previous.logo && previous.logo.startsWith('/uploads/')) removeImage(previous.logo);
      out.logo = '';
    } else {
      const saved = saveImage(out.logo, 'logo');
      if (!saved) {
        return sendJson(res, 400, { errors: ['El logotipo debe ser PNG, JPG o WebP y pesar menos de 8 MB.'] });
      }
      if (previous.logo && previous.logo.startsWith('/uploads/')) removeImage(previous.logo);
      out.logo = saved;
    }
  } else {
    delete out.logo;
  }

  for (const [key, value] of Object.entries(out)) {
    stmts.setSetting.run(key, String(value));
  }
  sendJson(res, 200, { settings: getPublicSettings() });
});

/* --- Respaldo y restauración (protegida) --- */

function collectImageData(images, imagePath) {
  if (!imagePath || !imagePath.startsWith('/uploads/') || imagePath.includes('..')) return;
  if (images[imagePath]) return;
  const full = path.join(UPLOADS_DIR, imagePath.slice('/uploads/'.length));
  try {
    const data = fs.readFileSync(full);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    images[imagePath] = `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    /* el archivo ya no existe; se conserva la ruta */
  }
}

route('GET', '/api/admin/backup', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const products = db.prepare('SELECT * FROM products ORDER BY id').all();
  const settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  const images = {};
  for (const p of products) collectImageData(images, p.image);
  const logo = settings.find((s) => s.key === 'logo');
  if (logo) collectImageData(images, logo.value);
  const payload = {
    app: 'zhendor-joyeria',
    schema: 2,
    generated_at: new Date().toISOString(),
    settings,
    categories: getCategories(),
    products,
    admin_user: db.prepare('SELECT username, password_hash FROM admin_user WHERE id = 1').get(),
    variants: {
      groups: stmts.allVariantGroups.all(),
      options: stmts.allVariantOptions.all()
    },
    images
  };
  sendJson(res, 200, payload);
});

route('POST', '/api/admin/restore', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  if (!body || body.app !== 'zhendor-joyeria' || !Array.isArray(body.products)) {
    return sendJson(res, 400, { error: 'El archivo de respaldo no es válido.' });
  }

  db.exec('BEGIN');
  try {
    // 1) Restaurar archivos de imagen que falten (misma ruta relativa)
    if (body.images && typeof body.images === 'object') {
      for (const [imagePath, dataUrl] of Object.entries(body.images)) {
        if (!/^\/uploads\/[^/].+/.test(imagePath) || imagePath.includes('..')) continue;
        if (typeof dataUrl !== 'string') continue;
        const full = path.join(UPLOADS_DIR, imagePath.slice('/uploads/'.length));
        const decoded = decodeDataUrl(dataUrl);
        if (!decoded) continue;
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, decoded.buf);
      }
    }

    // 2) Ajustes
    db.prepare('DELETE FROM settings').run();
    const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const row of body.settings || []) {
      if (row && row.key) insertSetting.run(String(row.key), String(row.value ?? ''));
    }

    // 3) Categorías
    db.prepare('DELETE FROM categories').run();
    const insertCategoryRow = db.prepare('INSERT INTO categories (slug, name, sort_order) VALUES (?, ?, ?)');
    for (const c of body.categories || []) {
      if (c && c.slug && c.name) {
        insertCategoryRow.run(String(c.slug), String(c.name), pricing.toInt(c.sort_order));
      }
    }

    // 4) Productos (con sus ids originales, sin perder datos)
    const groupsBefore = stmts.allVariantGroups.all();
    const deleteOpt = db.prepare('DELETE FROM variant_options WHERE group_id = ?');
    for (const g of groupsBefore) deleteOpt.run(g.id);
    db.prepare('DELETE FROM variant_groups').run();
    db.prepare('DELETE FROM products').run();

    const insertProductRow = db.prepare(`
      INSERT INTO products (id, name, description, price, weight, status, published, category, image,
        discount_type, discount_value, discount_active, discount_start, discount_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of body.products || []) {
      if (!p || typeof p.name !== 'string' || !p.name.trim()) continue;
      const id = pricing.toInt(p.id) || null;
      insertProductRow.run(
        id,
        String(p.name).slice(0, 120),
        String(p.description ?? '').slice(0, 2000),
        Math.max(0, pricing.toInt(p.price)),
        String(p.weight ?? '').slice(0, 80),
        p.status === 'out_of_stock' ? 'out_of_stock' : 'available',
        p.published === false || p.published === 0 || p.published === '0' ? 0 : 1,
        String(p.category ?? '').slice(0, 60),
        typeof p.image === 'string' ? p.image.slice(0, 500) : '',
        p.discount_type === 'percent' || p.discount_type === 'fixed' ? p.discount_type : 'none',
        Math.max(0, pricing.toInt(p.discount_value)),
        p.discount_active === false || p.discount_active === 0 || p.discount_active === '0' ? 0 : 1,
        String(p.discount_start ?? ''),
        String(p.discount_end ?? ''),
        String(p.created_at ?? new Date().toISOString()),
        String(p.updated_at ?? new Date().toISOString())
      );
    }

    // 5) Variantes (mapeando los ids de grupo al nuevo esquema)
    const groupIdMap = new Map();
    for (const g of body.variants && body.variants.groups ? body.variants.groups : []) {
      if (!g || !g.product_id || !g.name) continue;
      const inserted = stmts.insertVariantGroup.run(
        pricing.toInt(g.product_id),
        String(g.name).slice(0, 80),
        g.required === true || g.required === 1 || g.required === 'true' ? 1 : 0,
        pricing.toInt(g.sort_order)
      );
      groupIdMap.set(pricing.toInt(g.id), Number(inserted.lastInsertRowid));
    }
    const insertOptionRow = db.prepare(
      'INSERT INTO variant_options (group_id, label, color, available, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    for (const o of body.variants && body.variants.options ? body.variants.options : []) {
      if (!o || !o.group_id || !o.label) continue;
      const newGroupId = groupIdMap.get(pricing.toInt(o.group_id));
      if (newGroupId === undefined) continue;
      insertOptionRow.run(
        newGroupId,
        String(o.label).slice(0, 80),
        String(o.color ?? '').slice(0, 20),
        o.available === false || o.available === 0 || o.available === 'false' ? 0 : 1,
        pricing.toInt(o.sort_order)
      );
    }

    // 6) Usuario administrador (no se restaura la sesión actual)
    if (body.admin_user && typeof body.admin_user.password_hash === 'string') {
      db.prepare('UPDATE admin_user SET username = ?, password_hash = ? WHERE id = 1').run(
        String(body.admin_user.username || 'admin').slice(0, 120),
        String(body.admin_user.password_hash)
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('[Restaurar]', error);
    return sendJson(res, 500, { error: 'No se pudo restaurar el respaldo. Intenta de nuevo.' });
  }
  sendJson(res, 200, { ok: true });
});

/* ------------------------------------------------------------------ */
/* Archivos estáticos                                                 */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let relative = pathname.replace(/^\/+/, '');
  try {
    relative = decodeURIComponent(relative);
  } catch {
    return sendJson(res, 400, { error: 'URL no válida.' });
  }
  relative = relative.replace(/\/+$/, '');

  if (relative === '') {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), { cache: false });
  }
  // Rutas administrativas: protegidas en el servidor (no solo en el navegador).
  if (relative === 'admin' || relative === 'admin.html') {
    if (!isAuthenticated(req)) return redirect(res, '/login');
    return sendFile(res, path.join(PUBLIC_DIR, 'admin.html'), { cache: false });
  }
  if (relative === 'login' || relative === 'login.html') {
    if (isAuthenticated(req)) return redirect(res, '/admin');
    return sendFile(res, path.join(PUBLIC_DIR, 'login.html'), { cache: false });
  }

  let root;
  if (relative.startsWith('uploads/')) {
    root = UPLOADS_DIR;
    relative = relative.slice('uploads/'.length);
  } else {
    root = PUBLIC_DIR;
  }

  if (!relative || relative.includes('..') || relative.startsWith('/') || relative.startsWith('\\')) {
    return sendJson(res, 403, { error: 'Acceso denegado.' });
  }

  const full = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    return sendJson(res, 403, { error: 'Acceso denegado.' });
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return sendJson(res, 404, { error: 'No encontrado.' });
  }
  sendFile(res, full, { cache: true });
}

function sendFile(res, filePath, { cache }) {
  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(res, 404, { error: 'No encontrado.' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/* ------------------------------------------------------------------ */
/* Servidor                                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/placeholder') {
    const text = url.searchParams.get('name') || '';
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return res.end(placeholderSvg(text));
  }

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      r.keys.forEach((key, i) => (params[key] = match[i + 1]));
      try {
        return await r.handler(req, res, params);
      } catch (err) {
        console.error('[API error]', err);
        return sendJson(res, 500, { error: 'Error interno del servidor.' });
      }
    }
    return sendJson(res, 404, { error: 'Ruta no encontrada.' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Método no permitido.' });
  }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ZHEND’OR Joyería — servidor iniciado');
  console.log(`  Tienda:    http://localhost:${PORT}`);
  console.log(`  Panel:     http://localhost:${PORT}/admin`);
  console.log(`  Login:     http://localhost:${PORT}/login`);
  console.log(`  Usuario:   ${ADMIN_USER}`);
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD === 'Cambiar123*') {
    console.log('  ⚠  Contraseña por defecto activa: Cambiar123*  (cámbiala en .env o con npm run set-admin)');
  }
  console.log('');
});
