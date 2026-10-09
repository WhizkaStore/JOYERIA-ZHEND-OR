'use strict';

/* ==========================================================================
   ZHEND'OR Joyería — lógica del sitio público
   Carga catálogo y configuración desde el backend, gestiona el modal de
   producto y el formulario de compra por WhatsApp.
   ========================================================================== */

const state = {
  settings: null,
  products: [],
  currentProduct: null,
  quantity: 1,
  quote: null
};

const $ = (selector) => document.querySelector(selector);

const ZM = window.ZhendorMessage;
const money = ZM.money;

// Precio a mostrar para un producto (usa el precio final calculado por el backend).
function displayPrice(product) {
  const original = Number(product.price) || 0;
  const final = product.final_price === undefined || product.final_price === null
    ? original
    : Number(product.final_price) || 0;
  const hasDiscount = !!product.has_discount && final < original;
  return { original, final, hasDiscount, label: product.discount_label || '' };
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

/* Fallback global para imágenes que no cargan */
window.imgFallback = function (el) {
  el.onerror = null;
  el.src = '/placeholder?name=' + encodeURIComponent(el.dataset.name || 'ZHEND’OR');
};

/* ------------------------------------------------------------------ */
/* Carga de datos                                                     */
/* ------------------------------------------------------------------ */

async function loadData() {
  try {
    const [settingsRes, productsRes] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/products')
    ]);
    if (!settingsRes.ok || !productsRes.ok) throw new Error('No se pudo cargar la tienda.');
    state.settings = (await settingsRes.json()).settings;
    state.products = (await productsRes.json()).products;
  } catch (error) {
    console.error(error);
    showToast('No se pudo cargar la tienda. Recarga la página.');
    state.settings = state.settings || {};
    state.products = state.products || [];
  }
}

/* ------------------------------------------------------------------ */
/* Aplicar identidad de marca                                         */
/* ------------------------------------------------------------------ */

function applySettings() {
  const s = state.settings || {};
  const brand = s.brand_name || 'ZHEND’OR';
  const tagline = s.tagline || 'Joyería';
  const slogan = s.slogan || 'Tu historia';

  document.title = `${brand} ${tagline}`;

  setText('#brand-name', brand);
  setText('#brand-tagline', tagline);
  setText('#hero-brand', brand);
  setText('#hero-tagline', slogan);
  setText('#footer-name', brand);
  setText('#footer-tagline', tagline);
  setText('#footer-brand-inline', brand);
  setText('#footer-text', s.footer_text || '');
  setText('#about-text', s.description || '');
  setText('#hero-phrase', s.hero_phrase || '');

  if (s.logo) {
    for (const [imgSel, hideSel] of [['#brand-logo-img', '#brand-wordmark'], ['#footer-logo-img', '.footer-wordmark']]) {
      const img = $(imgSel);
      img.src = s.logo;
      img.alt = `${brand} ${tagline}`;
      img.hidden = false;
      $(hideSel).hidden = true;
    }
  }

  const wa = (s.whatsapp || '').replace(/[^\d]/g, '');
  const generalMsg = encodeURIComponent(`Hola ${brand}, me gustaría consultar sobre sus joyas.`);

  const orders = $('#orders-link');
  const contactWa = $('#contact-whatsapp');
  const footerWa = $('#footer-whatsapp');

  if (wa) {
    const url = `https://wa.me/${wa}?text=${generalMsg}`;
    orders.href = url;
    contactWa.href = url;
    footerWa.href = url;
  } else {
    orders.href = '#contacto';
    contactWa.removeAttribute('href');
    contactWa.classList.add('is-disabled');
    contactWa.setAttribute('aria-disabled', 'true');
    contactWa.title = 'WhatsApp aún no configurado';
    footerWa.style.display = 'none';
  }

  renderContactRows(s);
  renderFooterRows(s);
}

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value;
}

function rowIcon(kind) {
  const icons = {
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z"/></svg>'
  };
  return icons[kind] || '';
}

function renderContactRows(s) {
  const rows = [];
  if (s.contact_phone) {
    rows.push(['phone', 'Teléfono', esc(s.contact_phone)]);
  }
  if (s.contact_email) {
    rows.push(['mail', 'Correo', `<a href="mailto:${esc(s.contact_email)}">${esc(s.contact_email)}</a>`]);
  }
  if (s.address) {
    rows.push(['pin', 'Dirección', esc(s.address)]);
  }
  const wa = (s.whatsapp || '').replace(/[^\d]/g, '');
  if (wa) {
    rows.push(['chat', 'WhatsApp', `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">+${esc(wa)}</a>`]);
  }

  const container = $('#contact-rows');
  if (!rows.length) {
    container.innerHTML = '<p class="contact-row-value">Escríbenos y con gusto te atendemos.</p>';
    return;
  }
  container.innerHTML = rows
    .map(
      ([icon, label, value]) => `
      <div class="contact-row">
        ${rowIcon(icon)}
        <div>
          <span class="contact-row-label">${label}</span>
          <span class="contact-row-value">${value}</span>
        </div>
      </div>`
    )
    .join('');
}

function renderFooterRows(s) {
  const rows = [];
  if (s.contact_phone) rows.push(esc(s.contact_phone));
  if (s.contact_email) rows.push(`<a href="mailto:${esc(s.contact_email)}">${esc(s.contact_email)}</a>`);
  if (s.address) rows.push(esc(s.address));
  $('#footer-rows').innerHTML = rows.length
    ? rows.map((r) => `<span>${r}</span>`).join('')
    : '<span>Escríbenos por WhatsApp</span>';
}

/* ------------------------------------------------------------------ */
/* Catálogo                                                           */
/* ------------------------------------------------------------------ */

function renderProducts() {
  const grid = $('#product-grid');
  const note = $('#catalog-note');

  if (!state.products.length) {
    grid.innerHTML = '';
    note.textContent = 'Estamos preparando nuevas piezas. Vuelve pronto.';
    note.hidden = false;
    return;
  }
  note.hidden = true;

  grid.innerHTML = state.products
    .map((p) => {
      const out = p.status === 'out_of_stock';
      const d = displayPrice(p);
      const priceHtml = d.hasDiscount
        ? `<span class="price-old">${money(d.original)}</span>
           <span class="card-price">${money(d.final)}</span>`
        : `<span class="card-price">${money(d.final)}</span>`;
      return `
      <article class="card reveal">
        <div class="card-media">
          <img src="${esc(p.image || '/placeholder?name=' + encodeURIComponent(p.name))}"
               alt="${esc(p.name)}" data-name="${esc(p.name)}" loading="lazy"
               onerror="imgFallback(this)">
          <div class="card-badges">
            ${d.hasDiscount ? `<span class="card-badge discount">${esc(d.label)}</span>` : ''}
            ${out ? '<span class="card-badge out">Agotado</span>' : ''}
          </div>
        </div>
        <div class="card-body">
          <h3 class="card-title">${esc(p.name)}</h3>
          <p class="card-desc">${esc(p.description)}</p>
          <p class="card-meta">
            ${priceHtml}
            ${p.weight ? `<span class="card-weight">· ${esc(p.weight)}</span>` : ''}
          </p>
          <p class="card-availability">
            <span class="dot ${out ? 'out' : ''}"></span>${out ? 'Agotado' : 'Disponible'}
          </p>
          <button class="btn btn-ghost" data-view="${p.id}">Ver producto</button>
        </div>
      </article>`;
    })
    .join('');

  grid.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => openProduct(Number(btn.dataset.view)));
  });

  observeReveal();
}

/* ------------------------------------------------------------------ */
/* Modal de producto                                                  */
/* ------------------------------------------------------------------ */

function openProduct(id) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  state.currentProduct = product;
  state.quantity = 1;

  const out = product.status === 'out_of_stock';
  const img = $('#pm-image');
  img.src = product.image || '/placeholder?name=' + encodeURIComponent(product.name);
  img.dataset.name = product.name;
  img.alt = product.name;
  img.onerror = () => window.imgFallback(img);

  setText('#pm-title', product.name);
  const d = displayPrice(product);
  if (d.hasDiscount) {
    $('#pm-price').innerHTML =
      `<span class="price-old">${money(d.original)}</span> ` +
      `<span class="pm-price-final">${money(d.final)}</span> ` +
      `<span class="pm-discount-tag">${esc(d.label)}</span>`;
  } else {
    $('#pm-price').textContent = money(d.final);
  }
  setText('#pm-weight', product.weight || '');
  $('#pm-weight').hidden = !product.weight;
  $('#pm-availability').innerHTML = `<span class="dot ${out ? 'out' : ''}"></span>${out ? 'Agotado' : 'Disponible'}`;
  setText('#pm-description', product.description);

  const qtyInput = $('#pm-qty');
  qtyInput.value = 1;

  const buy = $('#pm-buy');
  buy.disabled = out;
  buy.textContent = out ? 'Agotado' : 'Comprar';
  buy.classList.toggle('is-out', out);

  openModal('#product-modal');
}

function changeQuantity(delta) {
  const input = $('#pm-qty');
  let value = Number.parseInt(input.value, 10) || 1;
  value = Math.min(99, Math.max(1, value + delta));
  input.value = value;
}

/* ------------------------------------------------------------------ */
/* Checkout por WhatsApp                                              */
/* ------------------------------------------------------------------ */

async function openCheckout() {
  if (!state.currentProduct) return;
  const product = state.currentProduct;
  if (product.status === 'out_of_stock') {
    showToast('Esta pieza está agotada por el momento.');
    return;
  }
  state.quantity = Math.min(99, Math.max(1, Number.parseInt($('#pm-qty').value, 10) || 1));
  try {
    state.quote = await requestQuote(product.id, state.quantity);
  } catch (error) {
    state.quote = null;
    showToast(error.message);
    return;
  }
  renderCheckoutSummary();
  closeModal('#product-modal');
  openModal('#checkout-modal');
  setTimeout(() => $('#co-name').focus(), 250);
}

// El precio definitivo lo calcula el servidor; el navegador solo lo muestra.
async function requestQuote(productId, quantity) {
  const res = await fetch('/api/order/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: productId, quantity })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudo calcular el precio. Intenta de nuevo.');
  return data.quote;
}

function renderCheckoutSummary() {
  const p = state.currentProduct;
  const qty = state.quantity;
  const q = state.quote;

  const unit = q ? q.unit_price : displayPrice(p).final;
  const subtotal = q ? q.subtotal : unit * qty;
  const discountTotal = q ? q.discount_amount : 0;
  const shipping = q ? q.shipping : ZM.parseShipping(state.settings);
  const total = shipping === null ? null : subtotal + shipping;

  const unitHtml =
    discountTotal > 0
      ? `<span class="price-old">${money(p.price)}</span> ${money(unit)} c/u`
      : `${money(unit)} c/u`;

  $('#co-summary').innerHTML = `
    <img class="co-summary-img" src="${esc(p.image || '/placeholder?name=' + encodeURIComponent(p.name))}"
         alt="${esc(p.name)}" data-name="${esc(p.name)}" onerror="imgFallback(this)">
    <div class="co-summary-info">
      <div class="co-summary-name">${esc(p.name)}</div>
      <div class="co-summary-unit">${unitHtml}</div>
    </div>
    <div class="co-summary-qty">Cantidad: ${qty}</div>`;

  const existingTotals = document.querySelector('.co-totals');
  if (existingTotals) existingTotals.remove();

  const discountRow = discountTotal > 0
    ? `<div class="co-total-row discount"><span>Descuento${q && q.discount_label ? ' (' + esc(q.discount_label) + ')' : ''}</span><strong>-${money(discountTotal)}</strong></div>`
    : '';

  const shippingRow = shipping === null
    ? `<div class="co-total-row"><span>Envío</span><span class="co-total-pending">Por confirmar</span></div>`
    : `<div class="co-total-row"><span>Envío</span><strong>${money(shipping)}</strong></div>`;

  const grandValue = total === null ? `${money(subtotal)} + envío` : money(total);

  $('#co-form').insertAdjacentHTML(
    'beforebegin',
    `<div class="co-totals">
      <div class="co-total-row"><span>Subtotal (${qty} × ${money(unit)})</span><strong>${money(subtotal)}</strong></div>
      ${discountRow}
      ${shippingRow}
      <div class="co-total-row grand"><span>Total</span><strong>${grandValue}</strong></div>
    </div>`
  );
}

async function handleCheckoutSubmit(event) {
  event.preventDefault();
  const error = $('#co-error');
  error.hidden = true;

  const fields = [
    ['#co-name', 'name', 2],
    ['#co-phone', 'phone', 6],
    ['#co-city', 'city', 2],
    ['#co-address', 'address', 4]
  ];

  let valid = true;
  const data = {};
  for (const [sel, key, min] of fields) {
    const input = $(sel);
    const value = input.value.trim();
    if (value.length < min) {
      input.classList.add('invalid');
      valid = false;
    } else {
      input.classList.remove('invalid');
      data[key] = value;
    }
  }
  if (!valid) {
    error.textContent = 'Revisa los campos marcados para continuar.';
    error.hidden = false;
    return;
  }
  data.notes = $('#co-notes').value.trim();

  const wa = (state.settings.whatsapp || '').replace(/[^\d]/g, '');
  if (!wa) {
    error.textContent = 'El WhatsApp de la tienda aún no está configurado. Escríbenos más tarde.';
    error.hidden = false;
    return;
  }

  const btn = $('#co-submit');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Calculando…';

  // Vuelve a cotizar en el servidor justo antes de enviar (precio confiable).
  let quote;
  try {
    quote = await requestQuote(state.currentProduct.id, state.quantity);
    state.quote = quote;
  } catch (quoteError) {
    btn.disabled = false;
    btn.textContent = originalLabel;
    error.textContent = quoteError.message;
    error.hidden = false;
    return;
  }

  const message = ZM.buildMessage(state.settings, state.currentProduct, state.quantity, data, quote);
  const url = ZM.whatsappUrl(wa, message);
  window.open(url, '_blank', 'noopener');

  btn.textContent = 'Abriendo WhatsApp…';
  showToast('Revisa WhatsApp y pulsa Enviar para confirmar tu pedido.');
  setTimeout(() => {
    btn.textContent = 'Continuar por WhatsApp';
    btn.disabled = false;
    closeModal('#checkout-modal');
  }, 1600);
}

/* ------------------------------------------------------------------ */
/* Modales / utilidades de UI                                         */
/* ------------------------------------------------------------------ */

function openModal(selector) {
  const modal = $(selector);
  modal.hidden = false;
  modal.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function closeModal(selector) {
  const modal = $(selector);
  modal.hidden = true;
  document.body.style.overflow = '';
}

let toastTimer;
function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
}

function observeReveal() {
  const items = document.querySelectorAll('.reveal:not(.in)');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  items.forEach((el) => observer.observe(el));
}

function initEvents() {
  $('#pm-minus').addEventListener('click', () => changeQuantity(-1));
  $('#pm-plus').addEventListener('click', () => changeQuantity(1));
  $('#pm-qty').addEventListener('change', (e) => {
    let v = Number.parseInt(e.target.value, 10) || 1;
    e.target.value = Math.min(99, Math.max(1, v));
  });
  $('#pm-buy').addEventListener('click', openCheckout);
  $('#co-form').addEventListener('submit', handleCheckoutSubmit);

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => {
      closeModal('#product-modal');
      closeModal('#checkout-modal');
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal('#product-modal');
      closeModal('#checkout-modal');
    }
  });

  const toggle = $('#menu-toggle');
  const nav = $('#main-nav');
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.querySelectorAll('.nav-link').forEach((link) =>
    link.addEventListener('click', () => {
      nav.classList.remove('open');
      toggle.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    })
  );

  window.addEventListener('scroll', () => {
    $('#site-header').classList.toggle('scrolled', window.scrollY > 12);
  });
}

/* ------------------------------------------------------------------ */
/* Arranque                                                           */
/* ------------------------------------------------------------------ */

async function init() {
  $('#year').textContent = new Date().getFullYear();
  $('#band-img').onerror = function () {
    this.style.display = 'none';
  };
  await loadData();
  applySettings();
  renderProducts();
  initEvents();
  observeReveal();
}

document.addEventListener('DOMContentLoaded', init);
