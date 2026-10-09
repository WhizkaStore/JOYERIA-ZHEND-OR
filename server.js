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
    `SELECT id, name, description, price, weight, status, image,
            discount_type, discount_value, discount_active, discount_start, discount_end
     FROM products WHERE published = 1 ORDER BY id ASC`
  ),
  productPublicById: db.prepare(
    `SELECT id, name, description, price, weight, status, image,
            discount_type, discount_value, discount_active, discount_start, discount_end
     FROM products WHERE published = 1 AND id = ?`
  ),
  productsAll: db.prepare(
    `SELECT id, name, description, price, weight, status, published, image,
            discount_type, discount_value, discount_active, discount_start, discount_end,
            created_at, updated_at
     FROM products ORDER BY id DESC`
  ),
  productById: db.prepare('SELECT * FROM products WHERE id = ?'),
  insertProduct: db.prepare(`
    INSERT INTO products (name, description, price, weight, status, published, image,
      discount_type, discount_value, discount_active, discount_start, discount_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateProduct: db.prepare(`
    UPDATE products
    SET name = ?, description = ?, price = ?, weight = ?, status = ?, published = ?, image = ?,
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
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?')
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
  const products = stmts.productsPublic.all().map((p) => pricing.serializeProduct(p));
  sendJson(res, 200, { products });
});

route('GET', '/api/products/:id', (req, res, params) => {
  const id = Number.parseInt(params.id, 10);
  const product = Number.isFinite(id) ? stmts.productPublicById.get(id) : undefined;
  if (!product) return sendJson(res, 404, { error: 'Producto no encontrado.' });
  sendJson(res, 200, { product: pricing.serializeProduct(product) });
});

route('GET', '/api/settings', (req, res) => {
  sendJson(res, 200, { settings: getPublicSettings() });
});

// Cotización de un pedido calculada en el servidor (fuente de verdad del precio).
route('POST', '/api/order/quote', async (req, res) => {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const id = Number.parseInt(body.product_id, 10);
  const product = Number.isFinite(id) ? stmts.productPublicById.get(id) : undefined;
  if (!product) {
    return sendJson(res, 404, { error: 'El producto no está disponible.' });
  }
  if (product.status === 'out_of_stock') {
    return sendJson(res, 409, { error: 'Esta pieza está agotada por el momento.' });
  }
  const settings = getSettings();
  sendJson(res, 200, { quote: pricing.computeQuote(product, body.quantity, settings.shipping_cost) });
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
    const pub = pricing.serializeProduct(p);
    return {
      ...p,
      final_price: pub.final_price,
      has_discount: pub.has_discount,
      discount_label: pub.discount_label
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
    merged.name, merged.description, merged.price, merged.weight, merged.status, merged.published, image,
    merged.discount_type, merged.discount_value, merged.discount_active, merged.discount_start, merged.discount_end,
    now, now
  );
  const product = stmts.productById.get(Number(result.lastInsertRowid));
  sendJson(res, 201, { product: pricing.serializeProduct(product), raw: product });
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
    merged.name, merged.description, merged.price, merged.weight, merged.status, merged.published, merged.image,
    merged.discount_type, merged.discount_value, merged.discount_active, merged.discount_start, merged.discount_end,
    new Date().toISOString(), id
  );
  const product = stmts.productById.get(id);
  sendJson(res, 200, { product: pricing.serializeProduct(product), raw: product });
});

route('DELETE', '/api/admin/products/:id', (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const id = Number.parseInt(params.id, 10);
  const existing = Number.isFinite(id) ? stmts.productById.get(id) : undefined;
  if (!existing) return sendJson(res, 404, { error: 'Producto no encontrado.' });
  if (existing.image) removeImage(existing.image);
  stmts.deleteProduct.run(id);
  sendJson(res, 200, { ok: true });
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
