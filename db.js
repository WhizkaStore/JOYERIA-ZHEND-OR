'use strict';

/**
 * ZHEND'OR Joyería — capa de datos (SQLite integrado de Node, sin dependencias).
 * Esquema, valores por defecto y datos iniciales (semilla).
 */

const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  brand_name: 'ZHEND’OR',
  tagline: 'Joyería',
  slogan: 'Tu Historia en oro',
  hero_phrase: 'La belleza eterna, forjada con luz y oro',
  whatsapp: '573105046188',
  contact_email: 'zhendor19@gmail.com',
  contact_phone: '',
  address: '',
  description:
    'En ZHEND’OR Joyería creemos que la verdadera elegancia nace de la atención al detalle. ' +
    'Cada pieza se piensa como un gesto delicado: luz cálida, formas naturales y un acabado ' +
    'dorado que acompaña con discreción los momentos más bonitos de la vida.',
  footer_text: '',
  shipping_cost: '',
  logo: ''
};

const SEED_PRODUCTS = [
  {
    name: 'Anillo Aura Dorado',
    description:
      'Anillo de aro delicado con acabado dorado suave, inspirado en la calidez de la luz de la tarde.',
    price: 1450000,
    weight: 'Aro de 1,5 mm',
    status: 'available',
    published: 1,
    image:
      'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=900&q=80'
  },
  {
    name: 'Collar Gota de Luz',
    description:
      'Collar con colgante en forma de gota, perfecto para lucir una elegancia discreta y natural.',
    price: 1890000,
    weight: '45 cm + 5 cm de extensión',
    status: 'available',
    published: 1,
    image:
      'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=900&q=80'
  },
  {
    name: 'Aretes Susurro',
    description: 'Aretes ligeros con movimiento sutil, compañeros ideales para el día a día.',
    price: 980000,
    weight: 'Diámetro 12 mm',
    status: 'available',
    published: 1,
    image:
      'https://images.unsplash.com/photo-1573408301185-9146fe634ad0?auto=format&fit=crop&w=900&q=80'
  },
  {
    name: 'Pulsera Hoja Dorada',
    description: 'Pulsera con un delicado detalle de hoja, un guiño sutil a la naturaleza.',
    price: 760000,
    weight: '21 cm ajustable',
    status: 'available',
    published: 1,
    image:
      'https://images.unsplash.com/photo-1602173574767-37ac01994b2a?auto=format&fit=crop&w=900&q=80'
  },
  {
    name: 'Anillo Eternidad Botánica',
    description: 'Anillo de diseño botánico con acabado pulido, para regalar y atesorar.',
    price: 2150000,
    weight: 'Aro de 2 mm',
    status: 'available',
    published: 1,
    image:
      'https://images.unsplash.com/photo-1611591437281-460bfbe1220a?auto=format&fit=crop&w=900&q=80'
  },
  {
    name: 'Cadena Sol',
    description: 'Cadena fina con cierre delicado, una compañera versátil para cada momento.',
    price: 1230000,
    weight: '40 cm',
    status: 'out_of_stock',
    published: 1,
    image:
      'https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=900&q=80'
  }
];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// Añade una columna si no existe (migración segura para bases ya creadas).
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function initDb(db, { adminPassword, adminUser }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL,
      weight TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available',
      published INTEGER NOT NULL DEFAULT 1,
      image TEXT NOT NULL DEFAULT '',
      discount_type TEXT NOT NULL DEFAULT 'none',
      discount_value INTEGER NOT NULL DEFAULT 0,
      discount_active INTEGER NOT NULL DEFAULT 0,
      discount_start TEXT NOT NULL DEFAULT '',
      discount_end TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_user (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL DEFAULT 'admin',
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);

  // Migraciones para bases de datos creadas con versiones anteriores
  ensureColumn(db, 'products', 'discount_type', "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(db, 'products', 'discount_value', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'products', 'discount_active', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'products', 'discount_start', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'products', 'discount_end', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'admin_user', 'username', "TEXT NOT NULL DEFAULT 'admin'");

  // Valores por defecto de la marca
  const setSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    setSetting.run(key, String(value));
  }

  // Usuario administrador (primera ejecución)
  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admin_user').get().c;
  if (adminCount === 0) {
    db.prepare('INSERT INTO admin_user (id, username, password_hash) VALUES (1, ?, ?)').run(
      adminUser || 'admin',
      hashPassword(adminPassword)
    );
  }

  // Catálogo inicial (solo si la tabla está vacía)
  const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (productCount === 0) {
    const insert = db.prepare(`
      INSERT INTO products (name, description, price, weight, status, published, image, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const p of SEED_PRODUCTS) {
      insert.run(
        p.name,
        p.description,
        p.price,
        p.weight,
        p.status,
        p.published,
        p.image,
        now,
        now
      );
    }
  }

  // Limpiar sesiones expiradas al iniciar
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(
    new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  );
}

module.exports = { initDb, hashPassword, verifyPassword, DEFAULT_SETTINGS };
