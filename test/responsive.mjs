// Pruebas responsive de ZHEND'OR Joyería con navegador real (Chrome/Edge headless vía CDP).
// Sin dependencias: usa el WebSocket global de Node y el CDP del navegador.
// Uso: node test/responsive.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3460;
const CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'resp-secret';
const ADMIN_USER = 'resp-admin';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zhendor-resp-'));
const SHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zhendor-shots-'));

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

let passed = 0;
let failed = 0;
const soft = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.error(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function note(text) {
  soft.push(text);
  console.log(`  \u2022 ${text}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- Servidor ----------------------------- */

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD, ADMIN_USER, DATA_DIR },
  stdio: ['ignore', 'ignore', 'pipe']
});
server.stderr.on('data', (d) => {
  const t = d.toString();
  if (!t.includes('ExperimentalWarning') && !t.includes('trace-warnings')) process.stderr.write(t);
});

async function waitForServer(timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(`${BASE}/api/products`);
      if (r.ok) return true;
    } catch { /* esperando */ }
    await sleep(200);
  }
  return false;
}

/* ----------------------------- Navegador ----------------------------- */

function findBrowser() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p));
}

let browser;
let ws;
let msgId = 0;
const pending = new Map();
const listeners = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Timeout CDP: ' + method));
      }
    }, 15000);
  });
}

function once(event) {
  return new Promise((resolve) => listeners.set(event, resolve));
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (res.exceptionDetails) {
    throw new Error('Evaluación falló: ' + JSON.stringify(res.exceptionDetails.exception));
  }
  return res.result.value;
}

async function waitFor(expression, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  return false;
}

async function setViewport(width, height, mobile) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
    screenWidth: width,
    screenHeight: height
  });
}

async function goto(url) {
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded.catch(() => {});
  await waitFor("document.readyState === 'complete'", 10000);
  await waitFor("document.querySelectorAll('.card').length > 0", 10000);
  await sleep(150);
}

// Navega y espera una condición arbitraria (para páginas que no tienen .card).
async function gotoWaiting(url, readyExpr, timeout = 10000) {
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded.catch(() => {});
  await waitFor("document.readyState === 'complete'", timeout);
  await waitFor(readyExpr, timeout);
  await sleep(150);
}

async function openCheckout() {
  await evaluate("document.querySelector('[data-view]').click()");
  await waitFor("!document.querySelector('#product-modal').hidden", 5000);
  await sleep(200);
  await evaluate("document.querySelector('#pm-buy').click()");
  await waitFor("!document.querySelector('#checkout-modal').hidden", 5000);
  await sleep(450);
}

// Desplaza al final cualquier contenedor con scroll del checkout
// (en móvil el modal; en escritorio la tarjeta) y devuelve la posición del botón.
async function scrollToSubmit() {
  return JSON.parse(await evaluate(`(() => {
    const modal = document.querySelector('#checkout-modal');
    const card = document.querySelector('#checkout-modal .modal-card');
    modal.scrollTop = modal.scrollHeight;
    card.scrollTop = card.scrollHeight;
    const s = document.querySelector('#co-submit').getBoundingClientRect();
    return JSON.stringify({ top: s.top, bottom: s.bottom, ih: window.innerHeight });
  })()`));
}

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const modal = q('#checkout-modal');
  const card = q('#checkout-modal .modal-card');
  const submit = q('#co-submit');
  const close = q('#checkout-modal .modal-close');
  const name = q('#co-name');
  const cs = (el) => (el ? getComputedStyle(el).position : '');
  return JSON.stringify({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    docScrollWidth: document.documentElement.scrollWidth,
    modalOpen: !modal.hidden,
    modalScrollHeight: modal.scrollHeight,
    modalClientHeight: modal.clientHeight,
    modalScrollTop: modal.scrollTop,
    card: rect(card),
    submit: rect(submit),
    close: rect(close),
    name: rect(name),
    closePos: cs(close),
    cardPos: cs(card),
    cardTransform: getComputedStyle(card).transform,
    overlayPos: cs(q('#checkout-modal .modal-overlay'))
  });
})()`;

async function measure() {
  return JSON.parse(await evaluate(MEASURE));
}

async function screenshot(file) {
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(SHOT_DIR, file), Buffer.from(res.data, 'base64'));
}

/* ----------------------------- Escenarios ----------------------------- */

async function checkLayout(label, width, height, mobile) {
  await setViewport(width, height, mobile);
  await goto(BASE);
  const home = await evaluate(
    "JSON.stringify({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })"
  );
  const h = JSON.parse(home);
  check(`[${label}] Sin desplazamiento horizontal en la página`, h.sw <= h.iw + 1, `scrollWidth=${h.sw} innerWidth=${h.iw}`);
}

async function run() {
  if (!await waitForServer()) {
    console.error('El servidor no arrancó.');
    return shutdown(1);
  }

  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('No se encontró Chrome ni Edge. No se pueden ejecutar las pruebas de navegador.');
    return shutdown(1);
  }

  console.log('\nZHEND’OR Joyería — pruebas responsive (navegador real)\n');
  console.log(`  Navegador: ${browserPath}\n`);

  browser = spawn(browserPath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'zhendor-chrome-' + Date.now())}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank'
  ], { stdio: 'ignore' });

  // Descubrir la pestaña vía CDP
  let target = null;
  const start = Date.now();
  while (Date.now() - start < 15000 && !target) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
    } catch { /* esperando */ }
    if (!target) await sleep(300);
  }
  if (!target) {
    console.error('No se pudo conectar al navegador.');
    return shutdown(1);
  }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      const resolve = listeners.get(msg.method);
      listeners.delete(msg.method);
      resolve(msg.params);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');

  /* --- Escritorio --- */
  await checkLayout('PC 1440x900', 1440, 900, false);
  await setViewport(1440, 900, false);
  await goto(BASE);
  await openCheckout();
  let m = await measure();
  check('[PC] El formulario abre como modal', m.modalOpen);
  check('[PC] El formulario no excede la pantalla', m.card.height <= m.innerHeight + 1, `card=${Math.round(m.card.height)} vh=${m.innerHeight}`);
  check('[PC] El botón de cerrar es visible', m.close.top >= 0 && m.close.right <= m.innerWidth + 1);
  const reachPc = await scrollToSubmit();
  check('[PC] Se puede llegar al botón "Continuar por WhatsApp"',
    reachPc.bottom <= reachPc.ih + 1 && reachPc.top >= -1, `bottom=${Math.round(reachPc.bottom)} vh=${reachPc.ih}`);
  await screenshot('pc-checkout.png');

  /* --- Móvil pequeño (portrait) --- */
  const mobileSizes = [
    ['Móvil 320x568', 320, 568],
    ['Móvil 390x844', 390, 844],
    ['Móvil 430x932', 430, 932]
  ];

  for (const [label, w, h] of mobileSizes) {
    await checkLayout(label, w, h, true);
    await setViewport(w, h, true);
    await goto(BASE);
    await openCheckout();
    m = await measure();

    check(`[${label}] El formulario abre`, m.modalOpen);
    check(`[${label}] Sin desbordamiento horizontal`, m.docScrollWidth <= m.innerWidth + 1, `sw=${m.docScrollWidth} iw=${m.innerWidth}`);
    check(`[${label}] El botón de cerrar está en pantalla`, m.close.top >= 0 && m.close.bottom <= m.innerHeight + 1, `close=${JSON.stringify(m.close)} sTop=${m.modalScrollTop} sH=${m.modalScrollHeight} cH=${m.modalClientHeight} pos=${m.closePos} cardT=${m.cardTransform}`);
    check(`[${label}] El primer campo está visible al abrir`, m.name.top >= 0 && m.name.top < m.innerHeight - 20,
      `name.top=${Math.round(m.name.top)} vh=${m.innerHeight}`);

    // Desplazar al final y comprobar que el botón de confirmación es alcanzable
    const reach = await scrollToSubmit();
    check(`[${label}] Se puede llegar al botón "Continuar por WhatsApp"`,
      reach.bottom <= reach.ih + 1 && reach.top >= -1, `bottom=${Math.round(reach.bottom)} vh=${reach.ih}`);

    // Simular teclado virtual reduciendo la altura del viewport
    const kbHeight = Math.round(h * 0.5);
    await setViewport(w, kbHeight, true);
    await evaluate("document.querySelector('#co-name').focus()");
    await sleep(250);
    const kb = JSON.parse(await evaluate(`(() => {
      const modal = document.querySelector('#checkout-modal');
      modal.scrollTop = modal.scrollHeight;
      const s = document.querySelector('#co-submit').getBoundingClientRect();
      const n = document.querySelector('#co-name').getBoundingClientRect();
      return JSON.stringify({ sTop: s.top, sBottom: s.bottom, nTop: n.top, nBottom: n.bottom, ih: window.innerHeight });
    })()`));
    check(`[${label}] Con teclado (emulado) el botón sigue alcanzable`, kb.sBottom <= kb.ih + 1, `sBottom=${Math.round(kb.sBottom)} vh=${kb.ih}`);
    await setViewport(w, h, true);

    await screenshot(`mobile-${w}x${h}.png`);
  }

  /* --- Validación: completar y generar enlace WhatsApp --- */
  await setViewport(390, 844, true);
  await goto(BASE);
  await openCheckout();
  await evaluate(`(() => {
    document.querySelector('#co-name').value = 'Ana Gómez';
    document.querySelector('#co-phone').value = '3001234567';
    document.querySelector('#co-city').value = 'Bogotá';
    document.querySelector('#co-address').value = 'Calle 123 # 45-67';
    document.querySelector('#co-notes').value = 'Empaque de regalo';
  })()`);
  // Construir el enlace real desde el módulo compartido usando los datos del DOM
  const waCheck = JSON.parse(await evaluate(`(() => {
    const ZM = window.ZhendorMessage;
    const settings = { brand_name: 'ZHEND’OR', shipping_cost: '' };
    const product = { name: 'Prueba', price: 1000000 };
    const data = {
      name: document.querySelector('#co-name').value,
      phone: document.querySelector('#co-phone').value,
      city: document.querySelector('#co-city').value,
      address: document.querySelector('#co-address').value,
      notes: document.querySelector('#co-notes').value
    };
    const msg = ZM.buildMessage(settings, product, 2, data);
    const url = ZM.whatsappUrl('573001112233', msg);
    return JSON.stringify({ url, msg });
  })()`));
  check('[Compra] El enlace WhatsApp conserva los datos del pedido',
    waCheck.url.startsWith('https://wa.me/573001112233?text=') &&
    decodeURIComponent(waCheck.url.split('text=')[1]) === waCheck.msg &&
    waCheck.msg.includes('Ana Gómez') && waCheck.msg.includes('Calle 123 # 45-67') &&
    waCheck.msg.includes('Empaque de regalo'));

  /* --- Móvil apaisado (landscape) --- */
  await setViewport(844, 390, true);
  await goto(BASE);
  await openCheckout();
  const land = JSON.parse(await evaluate(`JSON.stringify({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    ih: window.innerHeight
  })`));
  check('[Móvil apaisado] Sin desbordamiento horizontal', land.sw <= land.iw + 1, `sw=${land.sw} iw=${land.iw}`);
  const landReach = await scrollToSubmit();
  check('[Móvil apaisado] El botón es alcanzable',
    landReach.bottom <= landReach.ih + 1 && landReach.top >= -1, `bottom=${Math.round(landReach.bottom)} vh=${landReach.ih}`);
  await screenshot('mobile-landscape.png');

  /* --- Cerrar sin comprar --- */
  await evaluate("document.querySelector('#checkout-modal .modal-close').click()");
  const closed = JSON.parse(await evaluate(`JSON.stringify({
    hidden: document.querySelector('#checkout-modal').hidden,
    bodyOverflow: document.body.style.overflow
  })`));
  check('[Cerrar] El formulario se cierra y libera el scroll',
    closed.hidden === true && closed.bodyOverflow === '');

  /* --- Vitrina: categorías, variantes y carrito multi-línea --- */

  // Crear un producto con variantes vía API (para probar la UI pública)
  const apiLogin = await (await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD })
  })).json();
  const apiAuth = { Authorization: 'Bearer ' + apiLogin.token };
  const vp = await (await fetch(`${BASE}/api/admin/products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...apiAuth },
    body: JSON.stringify({
      name: 'Brazalete Vitrina Test',
      price: 90000,
      status: 'available',
      published: true,
      category: 'brazaletes',
      variants: [
        {
          name: 'Color de hilo', required: true,
          options: [
            { label: 'Oro', color: '#d8be69', available: true },
            { label: 'Verde', color: '#5f7a4a', available: true }
          ]
        }
      ]
    })
  })).json();
  const vpId = vp.product.id;
  const optOro = vp.product.variants[0].options[0].id;
  const optVerde = vp.product.variants[0].options[1].id;

  await setViewport(1440, 900, false);
  await goto(BASE);

  const chipCount = await evaluate("document.querySelectorAll('.chip').length");
  check('[Categorías] Los chips se muestran (Todas + 6 categorías)', chipCount >= 7, `chips=${chipCount}`);

  await evaluate("document.querySelector('.chip[data-slug=\"brazaletes\"]').click()");
  await sleep(300);
  const catFilter = JSON.parse(await evaluate(`JSON.stringify({
    count: document.querySelectorAll('#product-grid .card').length,
    cats: [...document.querySelectorAll('#product-grid .card-category')].map((e) => e.textContent.trim())
  })`));
  check('[Categorías] El chip filtra solo piezas de esa categoría',
    catFilter.count > 0 && catFilter.cats.every((c) => c === 'Brazaletes'),
    `count=${catFilter.count}`);
  await evaluate("document.querySelector('.chip[data-slug=\"todas\"]').click()");
  await sleep(300);

  // Modal de producto con variantes
  await evaluate(`document.querySelector('.card [data-view="${vpId}"]').click()`);
  await waitFor('!document.querySelector("#product-modal").hidden', 5000);
  const variantModal = JSON.parse(await evaluate(`JSON.stringify({
    hidden: document.querySelector('#pm-variants').hidden,
    groups: document.querySelectorAll('#pm-variants .variant-group').length
  })`));
  check('[Variantes] El modal muestra los grupos de variantes',
    !variantModal.hidden && variantModal.groups === 1);

  // Comprar sin elegir el grupo obligatorio: los botones quedan deshabilitados
  const reqErr = JSON.parse(await evaluate(`JSON.stringify({
    addDisabled: document.querySelector('#pm-add').disabled,
    buyDisabled: document.querySelector('#pm-buy').disabled,
    availability: document.querySelector('#pm-availability').textContent.trim(),
    checkoutOpen: !document.querySelector('#checkout-modal').hidden
  })`));
  check('[Variantes] Faltando la opción obligatoria se bloquea la compra',
    reqErr.addDisabled && reqErr.buyDisabled &&
      reqErr.availability.toLowerCase().includes('color de hilo') && !reqErr.checkoutOpen,
    JSON.stringify(reqErr));

  // Elegir variante y añadir al carrito
  await evaluate(`document.querySelector('.variant-option[data-oid="${optOro}"]').click()`);
  await sleep(150);
  const afterSelect = JSON.parse(await evaluate(`JSON.stringify({
    addDisabled: document.querySelector('#pm-add').disabled,
    buyDisabled: document.querySelector('#pm-buy').disabled,
    availability: document.querySelector('#pm-availability').textContent.trim()
  })`));
  check('[Variantes] Al elegir la opción los botones se habilitan',
    !afterSelect.addDisabled && !afterSelect.buyDisabled && !afterSelect.availability.includes('Color de hilo'));

  // Carrito de prueba limpio para validar el contador y las líneas
  await evaluate("localStorage.setItem('zhendor_cart_v1', '[]')");
  await goto(BASE);
  await evaluate(`document.querySelector('.card [data-view="${vpId}"]').click()`);
  await waitFor('!document.querySelector("#product-modal").hidden', 5000);
  await evaluate(`document.querySelector('.variant-option[data-oid="${optOro}"]').click()`);
  await sleep(150);
  await evaluate("document.querySelector('#pm-add').click()");
  await sleep(300);
  const add1 = JSON.parse(await evaluate(`JSON.stringify({
    badge: document.querySelector('#cart-badge').textContent,
    hidden: document.querySelector('#cart-badge').hidden,
    toast: document.querySelector('#toast').textContent
  })`));
  check('[Carrito] Añadir con variante actualiza el contador',
    !add1.hidden && add1.badge === '1' && add1.toast.includes('se añadió al carrito'), `badge=${add1.badge}`);

  // Segunda línea con otra variante
  await evaluate(`document.querySelector('.card [data-view="${vpId}"]').click()`);
  await waitFor('!document.querySelector("#product-modal").hidden', 5000);
  await evaluate(`document.querySelector('.variant-option[data-oid="${optVerde}"]').click()`);
  await sleep(150);
  await evaluate("document.querySelector('#pm-add').click()");
  await sleep(300);
  const badge2 = await evaluate("document.querySelector('#cart-badge').textContent");
  check('[Carrito] La misma pieza con otra variante suma otra línea', badge2 === '2', `badge=${badge2}`);

  // Panel del carrito
  await evaluate("document.querySelector('#cart-open').click()");
  await waitFor('!document.querySelector("#cart-drawer").hidden', 5000);
  await sleep(250);
  const drawer = JSON.parse(await evaluate(`JSON.stringify({
    items: document.querySelectorAll('#cart-items .cart-item').length,
    subtotalHidden: document.querySelector('#cart-subtotal').hidden,
    subtotal: document.querySelector('#cart-subtotal').textContent.trim()
  })`));
  check('[Carrito] El panel muestra las dos líneas', drawer.items === 2, `items=${drawer.items}`);
  check('[Carrito] El subtotal del panel es visible', !drawer.subtotalHidden && drawer.subtotal.length > 0);

  // Resumen y envío a WhatsApp
  await evaluate("document.querySelector('#cart-checkout').click()");
  await waitFor('!document.querySelector("#checkout-modal").hidden', 6000);
  await sleep(250);
  const coItems = await evaluate("document.querySelectorAll('#co-items .co-item').length");
  check('[Checkout] El resumen lista las dos líneas', coItems === 2, `items=${coItems}`);
  const coTotals = JSON.parse(await evaluate(`JSON.stringify({
    rows: [...document.querySelectorAll('#co-totals .co-total-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
    grand: document.querySelector('#co-totals .grand strong')?.textContent.trim() || ''
  })`));
  check('[Checkout] Subtotal, envío y total presentes',
    coTotals.rows.length >= 3 && coTotals.grand.length > 0, JSON.stringify(coTotals));
  const coText = await evaluate(`[...document.querySelectorAll('#co-items .co-item')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`);
  check('[Checkout] Las líneas describen sus variantes',
    coText.includes('Oro') && coText.includes('Verde'), coText);

  // Enviar el pedido capturando la URL de WhatsApp
  await evaluate(`(() => {
    document.querySelector('#co-name').value = 'María T';
    document.querySelector('#co-phone').value = '3002223344';
    document.querySelector('#co-city').value = 'Medellín';
    document.querySelector('#co-address').value = 'Cra 10 # 1-2';
    window.__waCapture = null;
    window.open = (url) => { window.__waCapture = url; return null; };
    document.querySelector('#co-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await waitFor('window.__waCapture !== null', 8000);
  const waLink = await evaluate('window.__waCapture');
  check('[Checkout] Se genera el enlace de WhatsApp',
    typeof waLink === 'string' && waLink.startsWith('https://wa.me/') && waLink.includes('text='));
  const orderText = decodeURIComponent(waLink.split('text=')[1]);
  check('[Checkout] El mensaje repite la pieza dos veces (dos líneas)',
    (orderText.match(/Brazalete Vitrina Test/g) || []).length === 2);
  check('[Checkout] El mensaje incluye las variantes de cada línea',
    orderText.includes('Color de hilo: Oro') && orderText.includes('Color de hilo: Verde'));
  check('[Checkout] El mensaje incluye el total', orderText.includes('Total'));
  await waitFor('document.querySelector("#checkout-modal").hidden', 8000);
  check('[Checkout] El modal se cierra tras abrir WhatsApp',
    await evaluate('document.querySelector("#checkout-modal").hidden'));

  // Limpieza: eliminar el producto de prueba
  await fetch(`${BASE}/api/admin/products/${vpId}`, { method: 'DELETE', headers: apiAuth });

  /* --- Panel de administración (login + responsive) --- */
  await setViewport(1440, 900, false);
  await gotoWaiting(BASE + '/admin', "location.pathname === '/login'", 10000);
  check('[Admin] Sin sesión, /admin redirige a /login',
    (await evaluate('location.pathname')) === '/login');

  // Credenciales incorrectas
  await evaluate(`(() => {
    document.querySelector('#username').value = ${JSON.stringify(ADMIN_USER)};
    document.querySelector('#password').value = 'incorrecta';
    document.querySelector('#login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`);
  const badMsg = await waitFor("!document.querySelector('#login-error').hidden", 8000);
  check('[Admin] Las credenciales incorrectas se rechazan',
    badMsg && (await evaluate('location.pathname')) === '/login');

  // Credenciales correctas
  await evaluate(`(() => {
    document.querySelector('#username').value = ${JSON.stringify(ADMIN_USER)};
    document.querySelector('#password').value = ${JSON.stringify(ADMIN_PASSWORD)};
    document.querySelector('#login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`);
  const okLogin = await waitFor(
    "location.pathname === '/admin' && document.querySelector('#admin-tabs') && document.querySelector('#stat-total').textContent !== '—'",
    12000
  );
  check('[Admin] El login válido entra al panel', okLogin);

  const admDesk = JSON.parse(await evaluate(`JSON.stringify({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    tabs: document.querySelectorAll('.tab').length,
    stat: document.querySelector('#stat-total').textContent
  })`));
  check('[Admin PC] Sin desbordamiento horizontal', admDesk.sw <= admDesk.iw + 1, `sw=${admDesk.sw} iw=${admDesk.iw}`);
  check('[Admin PC] Muestra el resumen con estadísticas', admDesk.tabs >= 5 && admDesk.stat !== '—');

  await evaluate("document.querySelector('.tab[data-view=\"discounts\"]').click()");
  await waitFor("document.querySelectorAll('.discount-card').length > 0", 8000);
  check('[Admin PC] La sección Descuentos lista los productos',
    (await evaluate("document.querySelectorAll('.discount-card').length")) > 0);
  await screenshot('admin-desktop.png');

  // Editor de imagen: elegir una foto abre el editor y "Aplicar" guarda el recorte
  await send('DOM.enable');
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const pngPath = path.join(SHOT_DIR, 'editor-sample.png');
  fs.writeFileSync(pngPath, Buffer.from(PNG_1PX, 'base64'));
  const doc = await send('DOM.getDocument', { depth: 2 });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#p-image' });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [pngPath] });
  await evaluate("document.querySelector('#p-image').dispatchEvent(new Event('change', { bubbles: true }))");
  const editorOpen = await waitFor("!!document.querySelector('.ie-overlay .ie-canvas')", 8000);
  check('[Admin] El editor de imagen abre al elegir una foto', editorOpen);
  await screenshot('image-editor.png');
  await evaluate("document.querySelector('[data-ie=\"apply\"]').click()");
  const applied = await waitFor(
    "!document.querySelector('#p-image-preview').hidden && document.querySelector('#p-image-preview').src.startsWith('data:image/jpeg')",
    8000
  );
  check('[Admin] El editor aplica la imagen recortada', applied);

  // Panel en móvil
  await setViewport(390, 844, true);
  await gotoWaiting(BASE + '/admin', "document.querySelector('#admin-tabs')", 12000);
  const admMob = JSON.parse(await evaluate(`JSON.stringify({
    sw: document.documentElement.scrollWidth, iw: window.innerWidth
  })`));
  check('[Admin móvil] Sin desbordamiento horizontal', admMob.sw <= admMob.iw + 1, `sw=${admMob.sw} iw=${admMob.iw}`);

  await evaluate("document.querySelector('.tab[data-view=\"products\"]').click()");
  await sleep(250);
  const admProd = JSON.parse(await evaluate(`JSON.stringify({
    sw: document.documentElement.scrollWidth, iw: window.innerWidth,
    rows: document.querySelectorAll('#products-tbody tr').length
  })`));
  check('[Admin móvil] La tabla de productos no desborda la página',
    admProd.sw <= admProd.iw + 1 && admProd.rows > 0, `sw=${admProd.sw} rows=${admProd.rows}`);
  await screenshot('admin-mobile.png');

  // Secciones nuevas del panel en móvil
  await evaluate("document.querySelector('.tab[data-view=\"categories\"]').click()");
  const catRows = await waitFor("document.querySelectorAll('#category-list .category-row').length > 0", 8000);
  check('[Admin móvil] La sección Categorías lista las 6',
    catRows && await evaluate("document.querySelectorAll('#category-list .category-row').length") === 6);
  await screenshot('admin-mobile-categories.png');

  await evaluate("document.querySelector('.tab[data-view=\"backup\"]').click()");
  await sleep(250);
  const backupShown = JSON.parse(await evaluate(`JSON.stringify({
    download: !!document.querySelector('#backup-download'),
    restore: !!document.querySelector('#backup-restore-pick'),
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth
  })`));
  check('[Admin móvil] La sección Respaldo muestra descargar y restaurar',
    backupShown.download && backupShown.restore && backupShown.sw <= backupShown.iw + 1);
  await screenshot('admin-mobile-backup.png');

  // Cerrar sesión: la sesión deja de ser válida
  await evaluate("document.querySelector('#logout-btn').click()");
  await waitFor("location.pathname === '/login'", 10000);
  await gotoWaiting(BASE + '/admin', "location.pathname === '/login'", 10000);
  check('[Admin] Tras cerrar sesión, /admin vuelve a pedir login',
    (await evaluate('location.pathname')) === '/login');

  note(`Capturas guardadas en: ${SHOT_DIR}`);
  note('El "teclado virtual" se emuló reduciendo la altura del viewport; no es un teclado de sistema real.');

  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas.\n`);
  shutdown(failed === 0 ? 0 : 1);
}

function shutdown(code) {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  try { if (browser) browser.kill(); } catch { /* ignore */ }
  try { server.kill(); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 300);
}

run().catch((error) => {
  console.error(error);
  shutdown(1);
});
