'use strict';

/**
 * ZHEND'OR Joyería — cambio de credenciales del administrador.
 *
 * Uso interactivo:
 *   npm run set-admin
 *
 * Uso directo:
 *   npm run set-admin -- --user admin@correo.com --password "NuevaClave123*"
 *
 * Variables de entorno opcionales: ADMIN_USER, ADMIN_PASSWORD, DATA_DIR.
 * El cambio invalida todas las sesiones activas y nunca altera el catálogo.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');
const { initDb, hashPassword } = require('../db');

const BASE_DIR = path.resolve(__dirname, '..');

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
    /* .env opcional */
  }
  return env;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--user' || arg === '-u') out.user = argv[++i];
    else if (arg === '--password' || arg === '-p') out.password = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function validate(user, password) {
  const errors = [];
  if (!user || user.trim().length < 3) errors.push('El usuario debe tener al menos 3 caracteres.');
  if (!password || password.length < 8) errors.push('La contraseña debe tener al menos 8 caracteres.');
  return errors;
}

async function main() {
  const env = { ...loadEnv(path.join(BASE_DIR, '.env')), ...process.env };
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log('\nUso: npm run set-admin -- [--user <usuario>] [--password <clave>]\n');
    return 0;
  }

  let user = args.user || env.ADMIN_USER || '';
  let password = args.password || env.ADMIN_PASSWORD || '';

  console.log('\nZHEND’OR Joyería — credenciales del administrador\n');

  let rl = null;
  if (!user || !password) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!user) user = (await ask(rl, 'Usuario o correo: ')).trim();
    if (!password) password = (await ask(rl, 'Nueva contraseña: ')).trim();
  }

  const errors = validate(user, password);
  if (errors.length) {
    console.error('\nNo se pudo actualizar:\n  • ' + errors.join('\n  • ') + '\n');
    if (rl) rl.close();
    return 1;
  }

  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(BASE_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'zhendor.db');

  const db = new DatabaseSync(dbFile);
  initDb(db, { adminPassword: password, adminUser: user });

  const updated = db
    .prepare('UPDATE admin_user SET username = ?, password_hash = ? WHERE id = 1')
    .run(user, hashPassword(password));
  if (updated.changes === 0) {
    db.prepare('INSERT INTO admin_user (id, username, password_hash) VALUES (1, ?, ?)').run(
      user,
      hashPassword(password)
    );
  }
  db.prepare('DELETE FROM sessions').run();
  db.close();

  if (rl) rl.close();
  console.log(`\n✓ Credenciales actualizadas para "${user}".`);
  console.log('  Se cerraron todas las sesiones activas.');
  console.log('  Reinicia el servidor si está en ejecución.\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('\nError al actualizar las credenciales:', error.message, '\n');
    process.exit(1);
  });
