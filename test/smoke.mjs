// Pruebas de humo ZHEND'OR Joyería (sin dependencias).
// Arranca el servidor en un puerto de prueba y valida la API completa.
// Uso: node test/smoke.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'test-secret-123';
const ADMIN_USER = 'zhendor-admin';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zhendor-test-'));

// PNG 1x1 transparente
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDQzS0tAAAAAElFTkSuQmCC';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.error(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/products`);
      if (res.ok) return true;
    } catch {
      /* aún no escucha */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function json(path, options = {}) {
  const res = await fetch(BASE + path, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* sin cuerpo */
  }
  return { status: res.status, body, headers: res.headers };
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD, ADMIN_USER, SESSION_DAYS: '7', DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe']
});

server.stdout.on('data', () => {});
server.stderr.on('data', (d) => {
  const text = d.toString();
  if (!text.includes('ExperimentalWarning') && !text.includes('trace-warnings')) {
    process.stderr.write(text);
  }
});

function shutdown(code) {
  try {
    server.kill();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 200);
}

async function run() {
  if (!await waitForServer()) {
    console.error('El servidor no arrancó a tiempo.');
    return shutdown(1);
  }

  console.log('\nZHEND’OR Joyería — pruebas de humo\n');

  // 1. Catálogo público
  const publicList = await json('/api/products');
  check('GET /api/products responde 200', publicList.status === 200);
  check('Se sembraron productos iniciales', Array.isArray(publicList.body.products) && publicList.body.products.length >= 6,
    `recibidos: ${publicList.body?.products?.length}`);
  check('El catálogo público oculta campos internos (published)',
    publicList.body.products.every((p) => p.published === undefined));

  // 2. Configuración pública
  const settingsPublic = await json('/api/settings');
  check('GET /api/settings responde 200', settingsPublic.status === 200);
  check('Marca por defecto es ZHEND’OR', settingsPublic.body.settings.brand_name === 'ZHEND’OR',
    settingsPublic.body.settings.brand_name);

  // 3. Protección del admin
  const noAuth = await json('/api/admin/products');
  check('Sin token el panel devuelve 401', noAuth.status === 401);

  const badLogin = await json('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: 'incorrecta' })
  });
  check('Login con contraseña incorrecta devuelve 401', badLogin.status === 401);

  const badUser = await json('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'otro', password: ADMIN_PASSWORD })
  });
  check('Login con usuario incorrecto devuelve 401', badUser.status === 401);

  const noUser = await json('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD })
  });
  check('Login sin usuario es rechazado', noUser.status === 401);

  const login = await json('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD })
  });
  check('Login correcto devuelve token', login.status === 200 && typeof login.body.token === 'string');
  const auth = { Authorization: 'Bearer ' + login.body.token };

  const setCookie = login.headers.get('set-cookie') || '';
  check('El login entrega cookie de sesión HttpOnly',
    /zhendor_session=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie));
  const cookie = setCookie.split(';')[0];

  // Protección de la ruta del panel en el servidor
  const adminNoAuth = await fetch(BASE + '/admin', { redirect: 'manual' });
  check('GET /admin sin sesión redirige a /login',
    adminNoAuth.status === 302 && (adminNoAuth.headers.get('location') || '').includes('/login'));
  const adminWithAuth = await fetch(BASE + '/admin', { headers: { Cookie: cookie }, redirect: 'manual' });
  const adminHtml = adminWithAuth.status === 200 ? await adminWithAuth.text() : '';
  check('GET /admin con cookie de sesión sirve el panel',
    adminWithAuth.status === 200 && /Resumen/.test(adminHtml));
  const loginWithAuth = await fetch(BASE + '/login', { headers: { Cookie: cookie }, redirect: 'manual' });
  check('GET /login con sesión redirige al panel',
    loginWithAuth.status === 302 && (loginWithAuth.headers.get('location') || '').includes('/admin'));

  const me = await json('/api/admin/me', { headers: auth });
  check('GET /api/admin/me autorizado', me.status === 200);

  const adminSettings = await json('/api/admin/settings', { headers: auth });
  check('GET /api/admin/settings autorizado responde 200', adminSettings.status === 200 && adminSettings.body.settings);

  // 4. Crear producto con imagen
  const create = await json('/api/admin/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      name: 'Pendiente de prueba',
      description: 'Producto creado por la prueba automática.',
      price: 1234000,
      weight: '1 g',
      status: 'available',
      published: true,
      image: TINY_PNG
    })
  });
  check('POST producto devuelve 201', create.status === 201, JSON.stringify(create.body));
  const productId = create.body?.product?.id;
  check('El producto creado tiene imagen guardada', typeof create.body?.product?.image === 'string' && create.body.product.image.startsWith('/uploads/products/'));

  const imageUrl = create.body?.product?.image;
  if (imageUrl) {
    const imgRes = await fetch(BASE + imageUrl);
    check('La imagen subida se sirve correctamente', imgRes.status === 200 && imgRes.headers.get('content-type')?.includes('image'));
  }

  // 5. Validación de entrada
  const invalid = await json('/api/admin/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'x', price: -5 })
  });
  check('Validación rechaza producto inválido (400)', invalid.status === 400 && Array.isArray(invalid.body.errors));

  // 6. Actualizar precio
  const oldImage = create.body.product.image;
  const update = await json('/api/admin/products/' + productId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ price: 9999000 })
  });
  check('PUT actualiza el precio', update.status === 200 && update.body.product.price === 9999000);
  check('PUT conserva la imagen existente', update.body.product.image === oldImage);

  // 7. Producto publicado aparece en público
  const afterCreate = await json('/api/products');
  check('El producto publicado aparece en el catálogo público',
    afterCreate.body.products.some((p) => p.id === productId));

  // 8. Despublicar -> desaparece del público
  await json('/api/admin/products/' + productId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ published: false })
  });
  const afterUnpublish = await json('/api/products');
  check('El producto despublicado no aparece en público',
    !afterUnpublish.body.products.some((p) => p.id === productId));

  // 9. Disponibilidad (agotado)
  const outStock = await json('/api/admin/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'Agotada', price: 500000, status: 'out_of_stock', published: true })
  });
  const outId = outStock.body.product.id;
  const publicOut = await json('/api/products');
  const outItem = publicOut.body.products.find((p) => p.id === outId);
  check('El producto agotado se muestra con status out_of_stock', outItem && outItem.status === 'out_of_stock');

  // 10. Actualizar ajustes (WhatsApp)
  const settingsUpdate = await json('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      brand_name: 'ZHEND’OR',
      tagline: 'Joyería',
      whatsapp: '573001112233',
      shipping_cost: '35000',
      hero_phrase: 'Frase de prueba',
      description: 'Descripción de prueba',
      footer_text: 'Pie de prueba',
      contact_email: 'hola@zhendor.test',
      contact_phone: '+57 300 111 2233',
      address: 'Bogotá, Colombia'
    })
  });
  check('PUT ajustes guarda WhatsApp', settingsUpdate.status === 200 && settingsUpdate.body.settings.whatsapp === '573001112233');
  check('PUT ajustes guarda envío', settingsUpdate.body.settings.shipping_cost === '35000');

  const publicSettings = await json('/api/settings');
  check('Los ajustes se reflejan en público', publicSettings.body.settings.whatsapp === '573001112233');

  // 10b. Logotipo: subir y quitar
  const logoUp = await json('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ brand_name: 'ZHEND’OR', logo: TINY_PNG })
  });
  check('PUT ajustes sube el logotipo', logoUp.status === 200 && String(logoUp.body.settings.logo || '').startsWith('/uploads/'));

  const logoRemove = await json('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ brand_name: 'ZHEND’OR', logo: '' })
  });
  check('PUT ajustes quita el logotipo', logoRemove.status === 200 && logoRemove.body.settings.logo === '');

  const badWhatsapp = await json('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ brand_name: 'ZHEND’OR', whatsapp: '12' })
  });
  check('Validación rechaza WhatsApp inválido', badWhatsapp.status === 400);

  // 11. Placeholder SVG
  const ph = await fetch(BASE + '/placeholder?name=Prueba');
  check('El placeholder devuelve SVG', ph.status === 200 && ph.headers.get('content-type')?.includes('svg'));

  // 12. Seguridad: path traversal
  const traverse = await fetch(BASE + '/..%2f..%2fpackage.json');
  check('Bloquea path traversal', traverse.status !== 200 || !(await traverse.text()).includes('zhendor-joyeria'),
    'status ' + traverse.status);

  // 13. Eliminar productos de prueba
  const del1 = await json('/api/admin/products/' + productId, { method: 'DELETE', headers: auth });
  const del2 = await json('/api/admin/products/' + outId, { method: 'DELETE', headers: auth });
  check('DELETE elimina productos', del1.status === 200 && del2.status === 200);

  const finalList = await json('/api/admin/products', { headers: auth });
  check('Los productos de prueba ya no existen',
    !finalList.body.products.some((p) => p.id === productId || p.id === outId));

  // 13b. Descuentos y cotización calculada en el servidor
  const disc = await json('/api/admin/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'Producto descuento', price: 150000, status: 'available', published: true })
  });
  const discId = disc.body?.raw?.id;
  check('Producto de descuento creado', disc.status === 201 && Number.isFinite(discId));

  const percent = await json('/api/admin/products/' + discId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ discount_type: 'percent', discount_value: 20, discount_active: true })
  });
  check('Descuento 20% calcula precio final 120000',
    percent.status === 200 && percent.body.product.final_price === 120000,
    JSON.stringify(percent.body?.product));
  check('La etiqueta de descuento es "-20%"', percent.body.product.discount_label === '-20%');

  const pubDisc = await json('/api/products');
  const pubItem = pubDisc.body.products.find((p) => p.id === discId);
  check('El catálogo público refleja el descuento',
    pubItem && pubItem.final_price === 120000 && pubItem.has_discount === true);

  const quote = await json('/api/order/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: discId, quantity: 2 })
  });
  check('La cotización usa el precio final',
    quote.status === 200 && quote.body.quote.unit_price === 120000 && quote.body.quote.subtotal === 240000);
  check('La cotización suma el envío configurado', quote.body.quote.total === 275000,
    JSON.stringify(quote.body.quote));
  check('La cotización reporta el descuento aplicado',
    quote.body.quote.discount_amount === 60000 && quote.body.quote.discount_applied === true);

  const badPercent = await json('/api/admin/products/' + discId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ discount_type: 'percent', discount_value: 150, discount_active: true })
  });
  check('Rechaza porcentaje mayor a 100', badPercent.status === 400);

  const badFixed = await json('/api/admin/products/' + discId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ discount_type: 'fixed', discount_value: 200000, discount_active: true })
  });
  check('Rechaza descuento fijo mayor que el precio', badFixed.status === 400);

  const off = await json('/api/admin/products/' + discId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ discount_active: false })
  });
  check('Descuento desactivado usa el precio normal',
    off.body.product.final_price === 150000 && off.body.product.has_discount === false);

  const expired = await json('/api/admin/products/' + discId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ discount_type: 'percent', discount_value: 20, discount_active: true, discount_end: '2000-01-01' })
  });
  check('El descuento vencido no se aplica',
    expired.body.product.final_price === 150000 && expired.body.product.has_discount === false);

  const future = await json('/api/admin/products/' + discId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ discount_type: 'percent', discount_value: 20, discount_active: true, discount_end: '', discount_start: '2999-01-01' })
  });
  check('El descuento con inicio futuro no se aplica',
    future.body.product.final_price === 150000 && future.body.product.has_discount === false);

  const fixedOn = await json('/api/admin/products/' + discId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ discount_type: 'fixed', discount_value: 30000, discount_active: true, discount_start: '', discount_end: '' })
  });
  check('El descuento fijo aplica el monto',
    fixedOn.body.product.final_price === 120000 && fixedOn.body.product.discount_label.includes('30'));

  const invalidDate = await json('/api/admin/products/' + discId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ discount_start: '01/01/2000' })
  });
  check('Rechaza fecha de descuento inválida', invalidDate.status === 400);

  const oos = await json('/api/admin/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'Agotado descuento', price: 90000, status: 'out_of_stock', published: true })
  });
  const oosId = oos.body.raw.id;
  const qOos = await json('/api/order/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: oosId, quantity: 1 })
  });
  check('Cotizar un producto agotado devuelve 409', qOos.status === 409);

  const hidden = await json('/api/admin/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'Oculto descuento', price: 90000, status: 'available', published: false })
  });
  const hiddenId = hidden.body.raw.id;
  const qHidden = await json('/api/order/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: hiddenId, quantity: 1 })
  });
  check('Cotizar un producto no publicado devuelve 404', qHidden.status === 404);

  for (const id of [discId, oosId, hiddenId]) {
    await json('/api/admin/products/' + id, { method: 'DELETE', headers: auth });
  }

  // 14. Verificar mensaje de WhatsApp con el módulo compartido real
  const ZM = require(path.join(ROOT, 'public', 'js', 'message.js'));
  const wSettings = { brand_name: 'ZHEND’OR', shipping_cost: '35000' };
  const wProduct = { name: 'Anillo Aura Dorado', price: 1450000 };
  const wData = { name: 'Ana Gómez', phone: '3001234567', city: 'Bogotá', address: 'Calle 123 # 45-67' };

  const msg = ZM.buildMessage(wSettings, wProduct, 2, wData);
  check('El mensaje incluye el producto', msg.includes('• Producto: Anillo Aura Dorado'));
  check('El mensaje calcula el subtotal', msg.includes('• Subtotal: ' + ZM.money(2900000)));
  check('El mensaje incluye el envío configurado', msg.includes('• Envío: ' + ZM.money(35000)));
  check('El mensaje calcula el total', msg.includes('• Total: ' + ZM.money(2935000)));
  check('El mensaje incluye los datos del cliente',
    msg.includes('• Nombre: Ana Gómez') && msg.includes('• Ciudad: Bogotá') && msg.includes('• Dirección: Calle 123 # 45-67'));

  const msgNoShip = ZM.buildMessage({ brand_name: 'ZHEND’OR', shipping_cost: '' }, wProduct, 1, wData);
  check('Sin envío configurado indica "Por confirmar"', msgNoShip.includes('• Envío: Por confirmar') && msgNoShip.includes('envío por confirmar'));

  const waUrl = ZM.whatsappUrl('+57 300 111 2233', msg);
  check('El enlace WhatsApp usa el formato wa.me', waUrl.startsWith('https://wa.me/573001112233?text='));
  check('El mensaje se codifica y decodifica correctamente',
    decodeURIComponent(waUrl.split('text=')[1]) === msg);

  const quotedMsg = ZM.buildMessage(
    wSettings,
    { name: 'Producto descuento', price: 150000, final_price: 120000 },
    2,
    wData,
    { unit_price: 120000, subtotal: 240000, discount_amount: 60000, shipping: 35000, total: 275000 }
  );
  check('El mensaje con cotización usa el precio final y el descuento',
    quotedMsg.includes('• Precio unitario: ' + ZM.money(120000)) &&
    quotedMsg.includes('• Descuento aplicado: -' + ZM.money(60000)) &&
    quotedMsg.includes('• Total: ' + ZM.money(275000)));

  // 15. Cierre de sesión
  const logout = await json('/api/admin/logout', { method: 'POST', headers: auth });
  check('Logout responde 200', logout.status === 200);
  const afterLogout = await json('/api/admin/products', { headers: auth });
  check('El token invalidado ya no autoriza', afterLogout.status === 401);

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas.\n`);
  shutdown(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  shutdown(1);
});
