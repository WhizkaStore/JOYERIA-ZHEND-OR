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
  await evaluate("document.querySelector('#collection-menu .collection-menu-row').click()");
  await waitFor("document.querySelectorAll('#product-grid [data-view]').length > 0", 6000);
  await evaluate("document.querySelector('#product-grid [data-view]').click()");
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

  // Menú de líneas: 6 filas en el orden esperado, con la vista de productos oculta
  const menu = JSON.parse(await evaluate(`JSON.stringify({
    hidden: document.querySelector('#collection-menu').hidden,
    viewHidden: document.querySelector('#collection-view').hidden,
    rows: [...document.querySelectorAll('.collection-menu-row')].map((r) => r.dataset.slug),
    nameCount: document.querySelectorAll('.collection-menu-row .cmr-name').length
  })`));
  check('[Colección] El menú muestra las 6 líneas en orden',
    !menu.hidden && menu.viewHidden && menu.nameCount === 6 &&
      menu.rows.join(',') === 'anillos,aretes,brazaletes,encanto-artesanal,cadenas,dijes',
    JSON.stringify(menu));

  // Clic en una fila abre la vista de la categoría con solo esas piezas
  await evaluate("document.querySelector('.collection-menu-row[data-slug=\"brazaletes\"]').click()");
  await sleep(400);
  const catView = JSON.parse(await evaluate(`JSON.stringify({
    viewHidden: document.querySelector('#collection-view').hidden,
    menuHidden: document.querySelector('#collection-menu').hidden,
    title: document.querySelector('#collection-view-title').textContent.trim(),
    count: document.querySelectorAll('#product-grid .card').length,
    cats: [...document.querySelectorAll('#product-grid .card-category')].map((e) => e.textContent.trim())
  })`));
  check('[Colección] La fila abre la vista filtrada de la categoría',
    !catView.viewHidden && catView.menuHidden && catView.title === 'Brazaletes' &&
      catView.count > 0 && catView.cats.every((c) => c === 'Brazaletes'),
    JSON.stringify(catView));

  // Volver al menú de líneas
  await evaluate("document.querySelector('#collection-back').click()");
  await sleep(400);
  const back = JSON.parse(await evaluate(`JSON.stringify({
    menuHidden: document.querySelector('#collection-menu').hidden,
    viewHidden: document.querySelector('#collection-view').hidden,
    rows: document.querySelectorAll('.collection-menu-row').length
  })`));
  check('[Colección] El botón volver regresa al menú de líneas',
    !back.menuHidden && back.viewHidden && back.rows === 6, JSON.stringify(back));

  // Abrir de nuevo la categoría para seguir con el modal de producto
  await evaluate("document.querySelector('.collection-menu-row[data-slug=\"brazaletes\"]').click()");
  await sleep(400);

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
      reqErr.availability.toLowerCase().includes('color') && !reqErr.checkoutOpen,
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
  await evaluate("document.querySelector('.collection-menu-row[data-slug=\"brazaletes\"]').click()");
  await waitFor("document.querySelectorAll('#product-grid [data-view]').length > 0", 6000);
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
  check('[Carrito] Las líneas muestran el chip de color de su variante',
    await evaluate("document.querySelectorAll('#cart-items .cart-item-variants .line-swatch').length") === 2);

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
    orderText.includes('Color: Oro') && orderText.includes('Color: Verde'));
  check('[Checkout] El mensaje incluye el total', orderText.includes('Total'));
  await waitFor('document.querySelector("#checkout-modal").hidden', 8000);
  check('[Checkout] El modal se cierra tras abrir WhatsApp',
    await evaluate('document.querySelector("#checkout-modal").hidden'));

  // Limpieza: eliminar el producto de prueba
  await fetch(`${BASE}/api/admin/products/${vpId}`, { method: 'DELETE', headers: apiAuth });

  /* --- Grupo mezclado legado: colores + tallas se dividen en secciones --- */

  // Producto con UN solo grupo que mezcla colores y tallas (como los datos legados en producción)
  const mix = await (await fetch(`${BASE}/api/admin/products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...apiAuth },
    body: JSON.stringify({
      name: 'Anillo Mezclado Test',
      price: 120000,
      status: 'available',
      published: true,
      category: 'anillos',
      variants: [{
        name: 'Talla del anillo', required: true,
        options: [
          { label: 'Oro viejo', color: '', available: true },
          { label: 'Champagne', color: '', available: false },
          { label: 'BRANDI', color: '', available: true },
          { label: 'Negro', color: '', available: true },
          { label: '6', color: '', available: true },
          { label: '7', color: '', available: false },
          { label: '8', color: '', available: true },
          { label: '9', color: '', available: true }
        ]
      }]
    })
  })).json();
  const mixId = mix.product.id;
  const mixGroups = mix.product.variants || [];
  const cOro = mixGroups[0]?.options?.[0]?.id;
  const cChamp = mixGroups[0]?.options?.[1]?.id;
  const cBrandi = mixGroups[0]?.options?.[2]?.id;
  const cNegro = mixGroups[0]?.options?.[3]?.id;
  const s6 = mixGroups[1]?.options?.[0]?.id;
  const s7 = mixGroups[1]?.options?.[1]?.id;
  const s8 = mixGroups[1]?.options?.[2]?.id;
  const s9 = mixGroups[1]?.options?.[3]?.id;
  check('[Mezclado] El grupo mixto se divide en Colores (primero) y Tallas',
    mixGroups.length === 2 && mixGroups[0].name === 'Color' &&
      mixGroups[0].options[0].color === '#b8933d' &&
      mixGroups[0].options[1].available === false &&
      mixGroups[1].name === 'Talla del anillo' &&
      mixGroups[1].options[1].available === false,
    JSON.stringify(mixGroups.map((g) => ({ name: g.name, opts: g.options.map((o) => o.label + (o.color ? '#' + o.color : '') + (o.available ? '' : '!')) }))));
  check('[Mezclado] Las tallas quedan solo con valores numéricos',
    mixGroups[1].options.map((o) => o.label).join(',') === '6,7,8,9');

  // Solo-talla: un grupo numérico limpio no cambia, en la tienda se titula «Tallas»
  const tallaOnly = await (await fetch(`${BASE}/api/admin/products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...apiAuth },
    body: JSON.stringify({
      name: 'Anillo Solo Talla Test',
      price: 80000, status: 'available', published: true, category: 'anillos',
      variants: [{ name: 'Talla del anillo', required: true, options: [
        { label: '15', color: '', available: true },
        { label: '16', color: '', available: true }
      ] }]
    })
  })).json();
  const tallaOnlyId = tallaOnly.product.id;

  // Tienda en escritorio con el carrito limpio
  await setViewport(1440, 900, false);
  await evaluate("localStorage.setItem('zhendor_cart_v1', '[]')");
  await goto(BASE);
  const openMixModal = async () => {
    await evaluate("document.querySelector('.collection-menu-row[data-slug=\"anillos\"]').click()");
    await waitFor(`document.querySelectorAll('#product-grid [data-view]').length > 0`, 6000);
    await evaluate(`document.querySelector('.card [data-view="${mixId}"]').click()`);
    await waitFor('!document.querySelector("#product-modal").hidden', 5000);
    await sleep(150);
  };
  await openMixModal();

  // Dos secciones «Colores» y «Tallas» con títulos y sin mezcla
  const mixedModal = JSON.parse(await evaluate(`JSON.stringify({
    groups: document.querySelectorAll('#pm-variants .variant-group').length,
    legends: [...document.querySelectorAll('#pm-variants .variant-group legend')].map((l) => l.textContent.replace('*', '').trim()),
    kinds: [...document.querySelectorAll('#pm-variants .variant-group')].map((g) => g.dataset.kind)
  })`));
  check('[Mezclado] El modal muestra «Colores» y «Tallas» como secciones separadas',
    mixedModal.groups === 2 && mixedModal.legends.join('|') === 'Colores|Tallas' &&
      mixedModal.kinds.join('|') === 'colors|tallas',
    JSON.stringify(mixedModal));

  // Agotados bloqueados e independencia de selección por grupo
  const selectState = JSON.parse(await evaluate(`JSON.stringify({
    champDisabled: document.querySelector('.variant-option[data-oid="${cChamp}"]')?.classList.contains('disabled') ?? false,
    s7Disabled: document.querySelector('.variant-option[data-oid="${s7}"]')?.classList.contains('disabled') ?? false,
    arDisabled: document.querySelector('.variant-option[data-oid="${s7}"]')?.getAttribute('aria-disabled'),
    addDisabled: document.querySelector('#pm-add').disabled,
    avail: document.querySelector('#pm-availability').textContent.trim()
  })`));
  check('[Mezclado] Opciones agotadas no seleccionables y falta selección',
    selectState.champDisabled && selectState.s7Disabled && selectState.arDisabled === 'true' &&
      selectState.addDisabled && selectState.avail.toLowerCase().includes('color'),
    JSON.stringify(selectState));

  // Seleccionar solo el color no basta: falta la talla
  await evaluate(`document.querySelector('.variant-option[data-oid="${cOro}"]').click()`);
  await sleep(120);
  const colorOnly = JSON.parse(await evaluate(`JSON.stringify({
    addDisabled: document.querySelector('#pm-add').disabled,
    avail: document.querySelector('#pm-availability').textContent.trim(),
    oroSelected: document.querySelector('.variant-option[data-oid="${cOro}"]').classList.contains('selected')
  })`));
  check('[Mezclado] Elegir el color no habilita hasta escoger la talla',
    colorOnly.oroSelected && colorOnly.addDisabled && colorOnly.avail.includes('talla'),
    JSON.stringify(colorOnly));

  // Elegir la talla habilita; luego cambiar el color conserva la talla
  await evaluate(`document.querySelector('.variant-option[data-oid="${s8}"]').click()`);
  await sleep(120);
  const withBoth = JSON.parse(await evaluate(`JSON.stringify({
    addDisabled: document.querySelector('#pm-add').disabled,
    s8Selected: document.querySelector('.variant-option[data-oid="${s8}"]').classList.contains('selected')
  })`));
  check('[Mezclado] Color + Talla habilitan la compra',
    !withBoth.addDisabled && withBoth.s8Selected, JSON.stringify(withBoth));

  await evaluate(`document.querySelector('.variant-option[data-oid="${cNegro}"]').click()`);
  await sleep(120);
  const independence = JSON.parse(await evaluate(`JSON.stringify({
    negroSelected: document.querySelector('.variant-option[data-oid="${cNegro}"]').classList.contains('selected'),
    oroSelected: document.querySelector('.variant-option[data-oid="${cOro}"]').classList.contains('selected'),
    s8Selected: document.querySelector('.variant-option[data-oid="${s8}"]').classList.contains('selected')
  })`));
  check('[Mezclado] Cambiar el color conserva la talla elegida',
    independence.negroSelected && !independence.oroSelected && independence.s8Selected,
    JSON.stringify(independence));

  // Añadir primera línea (Negro + 8) y segunda línea (BRANDI + 9)
  await evaluate("document.querySelector('#pm-add').click()");
  await sleep(300);
  await openMixModal();
  await evaluate(`document.querySelector('.variant-option[data-oid="${cBrandi}"]').click()`);
  await sleep(120);
  await evaluate(`document.querySelector('.variant-option[data-oid="${s9}"]').click()`);
  await sleep(120);
  await evaluate("document.querySelector('#pm-add').click()");
  await sleep(300);
  const mixCartBadge = await evaluate("document.querySelector('#cart-badge').textContent");
  check('[Mezclado] Cada combinación Color+Talla es una línea distinta', mixCartBadge === '2', `badge=${mixCartBadge}`);

  // El carrito muestra ambas opciones en líneas separadas
  await evaluate("document.querySelector('#cart-open').click()");
  await waitFor('!document.querySelector("#cart-drawer").hidden', 5000);
  await sleep(200);
  const mixCart = await evaluate(`[...document.querySelectorAll('#cart-items .cart-item')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).join(' || ')`);
  check('[Mezclado] El carrito separa Color y Talla por línea',
    mixCart.includes('Color: Negro') && mixCart.includes('Talla: 8') &&
      mixCart.includes('Color: BRANDI') && mixCart.includes('Talla: 9'),
    mixCart);

  // WhatsApp con ambas opciones en líneas separadas
  await evaluate("document.querySelector('#cart-checkout').click()");
  await waitFor('!document.querySelector("#checkout-modal").hidden', 6000);
  await sleep(200);
  await evaluate(`(() => {
    document.querySelector('#co-name').value = 'Laura M';
    document.querySelector('#co-phone').value = '3114455667';
    document.querySelector('#co-city').value = 'Bogotá';
    document.querySelector('#co-address').value = 'Cra 15 # 45-67';
    window.__waMix = null;
    window.open = (url) => { window.__waMix = url; return null; };
    document.querySelector('#co-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await waitFor('window.__waMix !== null', 8000);
  const waMixText = decodeURIComponent((await evaluate('window.__waMix')).split('text=')[1]);
  check('[Mezclado] El pedido de WhatsApp incluye Color y Talla por separado',
    waMixText.includes('Color: Negro') && waMixText.includes('Talla: 8') &&
      waMixText.includes('Color: BRANDI') && waMixText.includes('Talla: 9'),
    waMixText);

  // Móvil: las dos secciones se ven sin desbordes y el flujo sigue siendo independiente
  await setViewport(320, 568, true);
  await goto(BASE);
  await evaluate("document.querySelector('.collection-menu-row[data-slug=\"anillos\"]').click()");
  await waitFor(`document.querySelectorAll('#product-grid [data-view]').length > 0`, 6000);
  await evaluate(`document.querySelector('.card [data-view="${mixId}"]').click()`);
  await waitFor('!document.querySelector("#product-modal").hidden', 5000);
  await sleep(150);
  const mixMobile = JSON.parse(await evaluate(`JSON.stringify({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    groups: document.querySelectorAll('#pm-variants .variant-group').length,
    legends: [...document.querySelectorAll('#pm-variants .variant-group legend')].map((l) => l.textContent.replace('*', '').trim())
  })`));
  check('[Mezclado Móvil] Colores y Tallas visibles sin desbordamiento',
    mixMobile.sw <= mixMobile.iw + 1 && mixMobile.groups === 2 &&
      mixMobile.legends.join('|') === 'Colores|Tallas',
    JSON.stringify(mixMobile));

  // Solo-talla: una sola sección titulada «Tallas»
  await evaluate("document.querySelector('#product-modal [data-close]').click()");
  await sleep(200);
  await evaluate(`document.querySelector('.card [data-view="${tallaOnlyId}"]').click()`);
  await waitFor('!document.querySelector("#product-modal").hidden', 5000);
  await sleep(120);
  const tallaOnlyModal = JSON.parse(await evaluate(`JSON.stringify({
    groups: document.querySelectorAll('#pm-variants .variant-group').length,
    legend: document.querySelector('#pm-variants .variant-group legend')?.textContent.replace('*', '').trim() || '',
    kind: document.querySelector('#pm-variants .variant-group')?.dataset.kind || ''
  })`));
  check('[Solo Talla] Un grupo numérico se titula «Tallas» y bloquea sin elegir',
    tallaOnlyModal.groups === 1 && tallaOnlyModal.legend === 'Tallas' &&
      tallaOnlyModal.kind === 'tallas' && (await evaluate("document.querySelector('#pm-add').disabled")),
    JSON.stringify(tallaOnlyModal));

  // Cerrar el modal y limpiar los productos de prueba
  await evaluate("document.querySelector('#product-modal [data-close]').click()");
  await sleep(150);
  await fetch(`${BASE}/api/admin/products/${mixId}`, { method: 'DELETE', headers: apiAuth });
  await fetch(`${BASE}/api/admin/products/${tallaOnlyId}`, { method: 'DELETE', headers: apiAuth });

  /* --- Colección: menú y vista en móvil y tableta --- */
  const colSizes = [
    ['Móvil 320x568', 320, 568, true],
    ['Tableta 768x1024', 768, 1024, true]
  ];
  for (const [label, w, h, mobile] of colSizes) {
    await setViewport(w, h, mobile);
    await goto(BASE);
    const col = JSON.parse(await evaluate(`JSON.stringify({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      rows: document.querySelectorAll('.collection-menu-row').length,
      menuHidden: document.querySelector('#collection-menu').hidden,
      viewHidden: document.querySelector('#collection-view').hidden
    })`));
    check(`[${label}] El menú de Colección se muestra sin desbordamiento`,
      col.sw <= col.iw + 1 && col.rows === 6 && !col.menuHidden && col.viewHidden,
      `sw=${col.sw} iw=${col.iw} rows=${col.rows}`);
    await evaluate("document.querySelector('.collection-menu-row[data-slug=\"brazaletes\"]').click()");
    await sleep(350);
    const colView = JSON.parse(await evaluate(`JSON.stringify({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      viewHidden: document.querySelector('#collection-view').hidden,
      menuHidden: document.querySelector('#collection-menu').hidden,
      backVisible: (() => {
        const b = document.querySelector('#collection-back').getBoundingClientRect();
        return b.width > 0;
      })()
    })`));
    check(`[${label}] La vista de la línea abre sin desbordamiento y con botón volver`,
      colView.sw <= colView.iw + 1 && !colView.viewHidden && colView.menuHidden && colView.backVisible,
      JSON.stringify(colView));
    await evaluate("document.querySelector('#collection-back').click()");
    await sleep(350);
    check(`[${label}] Volver restaura el menú`,
      await evaluate("!document.querySelector('#collection-menu').hidden && document.querySelector('#collection-view').hidden"));
  }

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

  /* --- Selector visual de colores en el editor de productos --- */
  const selProd = await (await fetch(`${BASE}/api/admin/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuth },
    body: JSON.stringify({
      name: 'Brazalete Color Admin',
      price: 95000,
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
  const selId = selProd.product.id;
  await gotoWaiting(BASE + '/admin', "document.querySelector('#admin-tabs') && document.querySelector('#stat-total').textContent !== '—'", 12000);
  await evaluate("document.querySelector('.tab[data-view=\"products\"]').click()");
  await waitFor(`document.querySelector('[data-edit="${selId}"]')`, 8000);
  await evaluate(`document.querySelector('[data-edit="${selId}"]').click()`);
  await waitFor("document.querySelectorAll('#variant-groups .palt').length > 0", 8000);
  const swGui = JSON.parse(await evaluate(`JSON.stringify({
    groups: document.querySelectorAll('#variant-groups .variant-group-box').length,
    vsw: document.querySelectorAll('#variant-groups .vsw').length,
    palette: document.querySelectorAll('#variant-groups .palt').length,
    checked: document.querySelectorAll('#variant-groups .palt.in').length
  })`));
  check('[Admin] El editor muestra la cuadrícula de colores con sus muestras marcadas',
    swGui.groups >= 1 && swGui.vsw === 2 && swGui.checked === 2 && swGui.palette >= 10,
    JSON.stringify(swGui));
  const secTitle = await evaluate("document.querySelector('#variant-groups .vg-section-title').textContent");
  check('[Admin] La sección de colores se llama «Colores disponibles»',
    secTitle === 'Colores disponibles', secTitle);

  // Tocar una muestra de la paleta añade el color a la cuadrícula del producto
  await evaluate("document.querySelector('#variant-groups .palt:not(.in)').click()");
  await sleep(200);
  const swTo = JSON.parse(await evaluate(`JSON.stringify({
    vsw: document.querySelectorAll('#variant-groups .vsw').length,
    checked: document.querySelectorAll('#variant-groups .palt.in').length
  })`));
  check('[Admin] Tocar una muestra añade el color seleccionado',
    swTo.vsw === 3 && swTo.checked === 3, JSON.stringify(swTo));

  // Modo "Un solo color": al elegir otra muestra queda solo una selección
  await evaluate("document.querySelector('#variant-groups .vg-single').click()");
  await sleep(100);
  await evaluate("document.querySelector('#variant-groups .palt:not(.in)').click()");
  await sleep(200);
  const swSingle = JSON.parse(await evaluate(`JSON.stringify({
    vsw: document.querySelectorAll('#variant-groups .vsw').length,
    checked: document.querySelectorAll('#variant-groups .palt.in').length
  })`));
  check('[Admin] "Un solo color" limita a una muestra seleccionada',
    swSingle.vsw === 1 && swSingle.checked === 1, JSON.stringify(swSingle));

  // Color personalizado: aparece como muestra y queda seleccionada
  await evaluate(`(() => {
    const box = document.querySelector('#variant-groups .variant-group-box');
    box.querySelector('.cp-color').value = '#1f3a5f';
    box.querySelector('.cp-name').value = 'Azul capa';
    box.querySelector('.cp-add').click();
  })()`);
  await sleep(250);
  const swCustom = JSON.parse(await evaluate(`JSON.stringify({
    tiles: document.querySelectorAll('#variant-groups .palt').length,
    hasLabel: [...document.querySelectorAll('#variant-groups .palt')].some((t) => t.title === 'Azul capa'),
    vsw: document.querySelectorAll('#variant-groups .vsw').length
  })`));
  check('[Admin] El color personalizado aparece como muestra seleccionada',
    swCustom.hasLabel && swCustom.vsw === 1, JSON.stringify(swCustom));

  // Marcar agotado: la muestra queda dim y luego volvemos a disponible
  await evaluate("document.querySelector('#variant-groups .vsw').click()");
  await sleep(200);
  await evaluate("document.querySelector('#variant-groups .vg-editor .ed-available').click()");
  await sleep(200);
  const swOff = JSON.parse(await evaluate(`JSON.stringify({
    offTile: document.querySelector('#variant-groups .vsw-off') !== null,
    editorHidden: document.querySelector('#variant-groups [data-editor]').classList.contains('hidden')
  })`));
  check('[Admin] Marcar "Agotado" se refleja en la muestra',
    swOff.offTile && swOff.editorHidden, JSON.stringify(swOff));
  await evaluate("document.querySelector('#variant-groups .vsw-off').click()");
  await sleep(200);
  await evaluate("document.querySelector('#variant-groups .ed-available').click()");
  await sleep(200);
  check('[Admin] Volver a "Disponible" quita el estado agotado',
    await evaluate("document.querySelector('#variant-groups .vsw-off') === null"));

  // Cancelar para no modificar el producto y limpiar el de prueba
  await evaluate("document.querySelector('#product-cancel').click()");
  await sleep(200);
  await fetch(`${BASE}/api/admin/products/${selId}`, { method: 'DELETE', headers: apiAuth });

  /* --- Tallas de anillo: se agregan solas para la categoría Anillos --- */
  const ringProd = await (await fetch(`${BASE}/api/admin/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuth },
    body: JSON.stringify({
      name: 'Anillo Talla Test',
      price: 120000,
      status: 'available',
      published: true,
      category: 'anillos',
      variants: []
    })
  })).json();
  const ringId = ringProd.product.id;
  await gotoWaiting(BASE + '/admin', "document.querySelector('#admin-tabs') && document.querySelector('#stat-total').textContent !== '—'", 12000);
  await evaluate("document.querySelector('.tab[data-view=\"products\"]').click()");
  await waitFor(`document.querySelector('[data-edit="${ringId}"]')`, 8000);
  await evaluate(`document.querySelector('[data-edit="${ringId}"]').click()`);
  const szReady = await waitFor("document.querySelectorAll('#variant-groups .size-chip').length >= 19", 8000);
  check('[Tallas] Al editar un anillo aparece la sección de tallas', szReady);

  const szInit = JSON.parse(await evaluate(`JSON.stringify({
    chips: document.querySelectorAll('#variant-groups .size-chip').length,
    on: document.querySelectorAll('#variant-groups .size-chip.on').length,
    off: document.querySelectorAll('#variant-groups .size-chip.off').length,
    modeTallas: [...document.querySelectorAll('#variant-groups .vg-mode button')].some((b) => b.dataset.mode === 'tallas' && b.classList.contains('on')),
    section: document.querySelector('#variant-groups .vg-section-title').textContent,
    placeholder: document.querySelector('#variant-groups .vg-name').placeholder,
    hasPalette: !!document.querySelector('#variant-groups .vg-palette')
  })`));
  check('[Tallas] Sección «Tallas de anillos», sin tallas activas ni selector de colores',
    szInit.chips >= 19 && szInit.on === 0 && szInit.off >= 19 && szInit.modeTallas &&
      szInit.section === 'Tallas de anillos' && szInit.placeholder === 'Talla del anillo' && !szInit.hasPalette,
    JSON.stringify(szInit));

  await evaluate("document.querySelector('#variant-groups .size-chip[data-size=\"14\"]').click()");
  await sleep(120);
  await evaluate("document.querySelector('#variant-groups .size-chip[data-size=\"12\"]').click()");
  await sleep(120);
  const szOn = JSON.parse(await evaluate(`JSON.stringify({
    on: document.querySelectorAll('#variant-groups .size-chip.on').length,
    s12: document.querySelector('#variant-groups .size-chip[data-size="12"]').classList.contains('on'),
    s14: document.querySelector('#variant-groups .size-chip[data-size="14"]').classList.contains('on'),
    s10: document.querySelector('#variant-groups .size-chip[data-size="10"]').classList.contains('off')
  })`));
  check('[Tallas] Tocar una talla la marca disponible',
    szOn.on === 2 && szOn.s12 && szOn.s14 && szOn.s10, JSON.stringify(szOn));

  await evaluate("(() => { const b = document.querySelector('#variant-groups .variant-group-box'); b.querySelector('.sp-size-name').value = '8.5'; b.querySelector('.sp-add').click(); })()");
  await sleep(150);
  const szCustom = JSON.parse(await evaluate(`JSON.stringify({
    has85: document.querySelector('#variant-groups .size-chip[data-size="8.5"]') !== null,
    on85: document.querySelector('#variant-groups .size-chip[data-size="8.5"]').classList.contains('on'),
    chips: document.querySelectorAll('#variant-groups .size-chip').length,
    on: document.querySelectorAll('#variant-groups .size-chip.on').length
  })`));
  check('[Tallas] Se puede añadir una talla extra y queda disponible',
    szCustom.chips >= 20 && szCustom.on === 3 && szCustom.has85 && szCustom.on85, JSON.stringify(szCustom));

  await evaluate("document.querySelector('#variant-groups .size-chip[data-size=\"12\"]').click()");
  await sleep(120);
  const szOff = JSON.parse(await evaluate(`JSON.stringify({
    on: document.querySelectorAll('#variant-groups .size-chip.on').length,
    s12off: document.querySelector('#variant-groups .size-chip[data-size="12"]').classList.contains('off')
  })`));
  check('[Tallas] Volver a tocar una talla la desactiva',
    szOff.on === 2 && szOff.s12off, JSON.stringify(szOff));

  await evaluate("document.querySelector('#product-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))");
  const szSaved = await waitFor("!document.querySelector('#view-products').hidden", 12000);
  check('[Tallas] El anillo se guarda', szSaved);

  await gotoWaiting(BASE + '/', "document.querySelector('#product-grid')", 10000);
  await evaluate("location.hash = '#coleccion/anillos'");
  const ringCard = await waitFor(`document.querySelector('[data-view="${ringId}"]')`, 8000);
  check('[Tallas Tienda] El anillo aparece en su categoría', ringCard);
  await evaluate(`document.querySelector('[data-view="${ringId}"]').click()`);
  await waitFor("!document.querySelector('#product-modal').hidden", 5000);
  const ringShop = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.variant-option')].map((b) => b.textContent.trim()))`));
  check('[Tallas Tienda] El cliente solo ve las tallas disponibles',
    ringShop.length === 2 && ringShop.includes('14') && ringShop.includes('8.5') && !ringShop.includes('12') && !ringShop.includes('10'),
    JSON.stringify(ringShop));
  await evaluate("closeModal('#product-modal')");
  await sleep(150);

  // Al re-editar un anillo, las tallas activas persisten
  await gotoWaiting(BASE + '/admin', "document.querySelector('#admin-tabs')", 10000);
  await evaluate("document.querySelector('.tab[data-view=\"products\"]').click()");
  await waitFor(`document.querySelector('[data-edit="${ringId}"]')`, 8000);
  await evaluate(`document.querySelector('[data-edit="${ringId}"]').click()`);
  await waitFor("document.querySelectorAll('#variant-groups .size-chip').length >= 19", 8000);
  const szReopen = JSON.parse(await evaluate(`JSON.stringify({
    on: document.querySelectorAll('#variant-groups .size-chip.on').length,
    s14: document.querySelector('#variant-groups .size-chip[data-size="14"]').classList.contains('on'),
    s85: document.querySelector('#variant-groups .size-chip[data-size="8.5"]').classList.contains('on'),
    s12: document.querySelector('#variant-groups .size-chip[data-size="12"]').classList.contains('off')
  })`));
  check('[Tallas] Al re-editar persisten las tallas activas',
    szReopen.on === 2 && szReopen.s14 && szReopen.s85 && szReopen.s12, JSON.stringify(szReopen));

  // Desactivar una talla y guardar: deja de existir para el cliente
  await evaluate("document.querySelector('#variant-groups .size-chip[data-size=\"14\"]').click()");
  await sleep(120);
  await evaluate("document.querySelector('#product-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))");
  await waitFor("!document.querySelector('#view-products').hidden", 12000);
  const pubAfter = await (await fetch(`${BASE}/api/products/${ringId}`)).json();
  const tallaGroup = (pubAfter.product.variants || []).find((g) => /talla/i.test(g.name));
  check('[Tallas] Desactivar una talla la quita del producto',
    tallaGroup && tallaGroup.options.length === 1 && tallaGroup.options[0].label === '8.5',
    JSON.stringify(pubAfter.product.variants));
  await fetch(`${BASE}/api/admin/products/${ringId}`, { method: 'DELETE', headers: apiAuth });

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

  // El editor de producto es usable en móvil (sin campos ocultos ni desbordes)
  const tmpModal = await (await fetch(`${BASE}/api/admin/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuth },
    body: JSON.stringify({ name: 'Temp Móvil Admin', price: 10000, status: 'available', published: true })
  })).json();
  const tmpId = tmpModal.product.id;
  await evaluate("loadProducts()");
  await evaluate("document.querySelector('.tab[data-view=\"products\"]').click()");
  await waitFor(`document.querySelector('[data-edit="${tmpId}"]')`, 8000);
  await evaluate(`document.querySelector('[data-edit="${tmpId}"]').click()`);
  const editorOn = await waitFor("!document.querySelector('#view-editor').hidden && document.querySelector('#product-form')", 8000);
  check('[Admin móvil] El editor de producto abre', editorOn);

  const editorMob = JSON.parse(await evaluate(`JSON.stringify({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    nameW: document.querySelector('#p-name').getBoundingClientRect().width,
    catW: document.querySelector('#p-category').getBoundingClientRect().width,
    descW: document.querySelector('#p-description').getBoundingClientRect().width,
    priceW: document.querySelector('#p-price').getBoundingClientRect().width,
    weightW: document.querySelector('#p-weight').getBoundingClientRect().width,
    statusVisible: document.querySelector('#p-status').offsetParent !== null,
    pubVisible: document.querySelector('#p-published').offsetParent !== null,
    saveVisible: document.querySelector('#product-save').offsetParent !== null,
    cancelVisible: document.querySelector('#product-cancel').offsetParent !== null,
    variantsVisible: document.querySelector('.variants-card').offsetParent !== null,
    fontName: parseFloat(getComputedStyle(document.querySelector('#p-name')).fontSize),
    scrollable: document.documentElement.scrollHeight > window.innerHeight
  })`));
  check('[Admin móvil] Los campos del editor son visibles y sin desbordes',
    editorMob.sw <= editorMob.iw + 1 && editorMob.nameW > 0 && editorMob.catW > 0 &&
      editorMob.descW > 0 && editorMob.priceW > 0 && editorMob.weightW > 0 &&
      editorMob.statusVisible && editorMob.pubVisible && editorMob.variantsVisible,
    JSON.stringify(editorMob));
  check('[Admin móvil] Guardar/Cancelar accesibles y formulario desplazable',
    editorMob.saveVisible && editorMob.cancelVisible && editorMob.scrollable);
  check('[Admin móvil] Los campos usan 16px (sin zoom automático en iOS)', editorMob.fontName >= 16, `font=${editorMob.fontName}`);

  // Un anillo agrega su sección de tallas automáticamente al elegir la categoría
  await evaluate(`(() => {
    const sel = document.querySelector('#p-category');
    sel.value = 'anillos';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const mobTallas = await waitFor("document.querySelectorAll('#variant-groups .size-chip').length >= 19", 6000);
  const mobTallasInfo = JSON.parse(await evaluate(`JSON.stringify({
    section: document.querySelector('#variant-groups .vg-section-title') ? document.querySelector('#variant-groups .vg-section-title').textContent : '',
    chips: document.querySelectorAll('#variant-groups .size-chip').length
  })`));
  check('[Admin móvil] Elegir categoría Anillos añade «Tallas de anillos»',
    mobTallas && mobTallasInfo.section === 'Tallas de anillos' && mobTallasInfo.chips >= 19,
    JSON.stringify(mobTallasInfo));

  // El selector de colores también funciona en móvil
  await evaluate("document.querySelector('#variant-group-add').click()");
  await sleep(200);
  await evaluate("document.querySelectorAll('#variant-groups .variant-group-box')[1].querySelector('[data-mode=\"colors\"]').click()");
  await sleep(250);
  const mobColors = JSON.parse(await evaluate(`JSON.stringify({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    palt: document.querySelectorAll('#variant-groups .palt').length,
    section: document.querySelectorAll('#variant-groups .vg-section-title')[1].textContent,
    width: document.querySelector('#variant-groups .vg-palette-grid') ? document.querySelector('#variant-groups .vg-palette-grid').getBoundingClientRect().width : 0
  })`));
  check('[Admin móvil] El selector de colores muestra «Colores disponibles» sin desbordes',
    mobColors.palt > 0 && mobColors.section === 'Colores disponibles' &&
      mobColors.sw <= mobColors.iw + 1 && mobColors.width > 0 && mobColors.width <= mobColors.iw,
    JSON.stringify(mobColors));
  await evaluate("document.querySelector('.variants-card').scrollIntoView({ block: 'start' })");
  await sleep(250);
  await screenshot('admin-mobile-editor.png');
  await evaluate("document.querySelector('#product-cancel').click()");
  await sleep(200);

  // El modal de confirmación cabe en la pantalla del móvil
  await evaluate("document.querySelector('.tab[data-view=\"products\"]').click()");
  await waitFor(`document.querySelector('[data-delete="${tmpId}"]')`, 8000);
  await evaluate(`document.querySelector('[data-delete="${tmpId}"]').click()`);
  const modalOn = await waitFor("!document.querySelector('#confirm-modal').hidden", 6000);
  const modalFit = JSON.parse(await evaluate(`(() => {
    const card = document.querySelector('#confirm-modal .confirm-card').getBoundingClientRect();
    return JSON.stringify({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, left: card.left, right: card.right });
  })()`));
  check('[Admin móvil] El modal de confirmación cabe en la pantalla',
    modalOn && modalFit.sw <= modalFit.iw + 1 && modalFit.left >= 0 && modalFit.right <= modalFit.iw + 1,
    JSON.stringify(modalFit));
  await evaluate("document.querySelector('#confirm-modal [data-close]').click()");
  await sleep(150);
  await fetch(`${BASE}/api/admin/products/${tmpId}`, { method: 'DELETE', headers: apiAuth });

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
