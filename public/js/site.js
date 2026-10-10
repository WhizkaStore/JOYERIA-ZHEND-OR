'use strict';

/* ==========================================================================
   ZHEND'OR Joyería — lógica del sitio público
   Carga catálogo y configuración desde el backend, gestiona las categorías,
   las variantes, el carrito y el pedido multi-producto por WhatsApp.
   ========================================================================== */

const CART_KEY = 'zhendor_cart_v1';

const state = {
  settings: null,
  products: [],
  categories: [],
  filter: 'todas',
  currentProduct: null,
  quantity: 1,
  selections: {},
  cart: [],
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

const slugToFilter = (slug) => (slug === 'todas' || !slug ? 'todas' : slug);

/* ------------------------------------------------------------------ */
/* Carga de datos                                                     */
/* ------------------------------------------------------------------ */

async function loadData() {
  try {
    const [settingsRes, productsRes, categoriesRes] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/products'),
      fetch('/api/categories')
    ]);
    if (!settingsRes.ok || !productsRes.ok || !categoriesRes.ok) throw new Error('No se pudo cargar la tienda.');
    state.settings = (await settingsRes.json()).settings;
    state.products = (await productsRes.json()).products;
    state.categories = (await categoriesRes.json()).categories || [];
  } catch (error) {
    console.error(error);
    showToast('No se pudo cargar la tienda. Recarga la página.');
    state.settings = state.settings || {};
    state.products = state.products || [];
    state.categories = state.categories || [];
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
/* Colección: menú de líneas y vista por categoría                    */
/* ------------------------------------------------------------------ */

// Orden fijo de las líneas, tal como se exhiben en el menú de Colección.
const COLLECTION_ORDER = ['anillos', 'aretes', 'brazaletes', 'encanto-artesanal', 'cadenas', 'dijes'];

function orderedCategories() {
  const rank = (c) => {
    const index = COLLECTION_ORDER.indexOf(c.slug);
    return index === -1 ? COLLECTION_ORDER.length : index;
  };
  return [...state.categories].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'es'));
}

function categoryCount(slug) {
  return state.products.filter((p) => p.category === slug).length;
}

function renderCollectionMenu() {
  const list = $('#collection-menu-list');
  list.innerHTML = orderedCategories()
    .map((c) => {
      const count = categoryCount(c.slug);
      return `
      <a class="collection-menu-row" href="#coleccion/${esc(c.slug)}" data-slug="${esc(c.slug)}">
        <span class="cmr-text">
          <span class="cmr-name">${esc(c.name)}</span>
          <span class="cmr-count">${count} ${count === 1 ? 'pieza' : 'piezas'}</span>
        </span>
        <span class="cmr-arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
        </span>
      </a>`;
    })
    .join('') || '<p class="catalog-note">Aún no hay líneas en la colección.</p>';
}

function renderCollection() {
  const hashSlug = parseCollectionHash();
  const menu = $('#collection-menu');
  const view = $('#collection-view');
  const showView = !!hashSlug;
  menu.hidden = showView;
  view.hidden = !showView;
  if (showView) {
    const slug = slugToFilter(hashSlug);
    const cat = state.categories.find((c) => c.slug === slug);
    $('#collection-view-title').textContent = cat ? cat.name : slug === 'todas' ? 'Todas las piezas' : slug;
    state.filter = slug;
    renderProducts();
  } else {
    state.filter = 'todas';
    renderCollectionMenu();
  }
}

/* ------------------------------------------------------------------ */
/* Catálogo                                                           */
/* ------------------------------------------------------------------ */

function renderProducts() {
  const grid = $('#product-grid');
  const note = $('#catalog-note');

  const visible = state.filter === 'todas'
    ? state.products
    : state.products.filter((p) => p.category === state.filter);

  if (!visible.length) {
    grid.innerHTML = '';
    if (!state.products.length) {
      note.textContent = 'Estamos preparando nuevas piezas. Vuelve pronto.';
    } else {
      note.textContent = 'Aún no hay piezas en esta categoría. Vuelve pronto.';
    }
    note.hidden = false;
    return;
  }
  note.hidden = true;

  grid.innerHTML = visible
    .map((p) => {
      const out = p.status === 'out_of_stock';
      const d = displayPrice(p);
      const category = p.category_name ? `<span class="card-category">${esc(p.category_name)}</span>` : '';
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
          ${category}
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
  state.selections = {};

  const out = product.status === 'out_of_stock';
  const img = $('#pm-image');
  img.src = product.image || '/placeholder?name=' + encodeURIComponent(product.name);
  img.dataset.name = product.name;
  img.alt = product.name;
  img.onerror = () => window.imgFallback(img);

  setText('#pm-category', product.category_name || '');
  $('#pm-category').hidden = !product.category_name;
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
  setAvailability(out ? 'Agotado' : 'Disponible', out);
  setText('#pm-description', product.description);

  $('#pm-qty').value = 1;
  renderVariants();
  updateBuyButtons();

  openModal('#product-modal');
}

function setAvailability(text, isError) {
  const el = $('#pm-availability');
  el.classList.toggle('is-error', !!isError);
  el.innerHTML = isError ? esc(text) : `<span class="dot ${isError ? 'out' : ''}"></span>${esc(text)}`;
}

const SIZE_NAME_RE = /talla|tama|medida|num|n[uú]mero/i;
const COLOR_NAME_RE = /color|hilo|tono|tapiz|material|cinta/i;
const SIZE_LABEL_RE = /^\d+(?:[.,]\d+)?$/;

function labelLooksLikeSize(label) {
  let t = String(label || '').trim().toLowerCase();
  t = t.replace(/^(talla|tama|medida|n[uu]mero|num|nro|n°|no\.?|#)\s*/, '');
  t = t.replace(/\s*(cm|mm|ml)$/, '');
  t = t.replace(/\s+/g, '');
  return SIZE_LABEL_RE.test(t);
}

function variantGroupKind(group) {
  const name = String(group.name || '');
  const opts = group.options || [];
  if (SIZE_NAME_RE.test(name)) return 'tallas';
  if (COLOR_NAME_RE.test(name) || opts.some((o) => o.color)) return 'colors';
  if (opts.some((o) => labelLooksLikeSize(o.label))) return 'tallas';
  return 'opciones';
}

function variantGroupTitle(group) {
  const kind = variantGroupKind(group);
  if (kind === 'colors') return 'Colores';
  if (kind === 'tallas') return 'Tallas';
  return group.name;
}

function renderVariants() {
  const product = state.currentProduct;
  const wrap = $('#pm-variants');
  const groups = (product && Array.isArray(product.variants) ? product.variants : [])
    .filter((g) => g.options && g.options.length);

  if (!groups.length) {
    wrap.innerHTML = '';
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  wrap.innerHTML = groups
    .map((group) => {
      const options = (group.options || []).map((opt) => {
        const sel = state.selections[group.id] && state.selections[group.id].option_id === opt.id;
        const disabled = !opt.available;
        const colorStyle = opt.color ? `style="--vc:${esc(opt.color)}"` : '';
        return `
        <button type="button" class="variant-option ${opt.color ? 'has-swatch' : ''} ${sel ? 'selected' : ''} ${disabled ? 'disabled' : ''}"
                data-gid="${group.id}" data-oid="${opt.id}" ${colorStyle}
                aria-pressed="${sel}" ${disabled ? 'aria-disabled="true"' : ''}>
          ${opt.color ? '<span class="swatch-chip"></span>' : ''}
          <span class="variant-label">${esc(opt.label)}</span>
        </button>`;
      });
      return `
      <fieldset class="variant-group" data-kind="${variantGroupKind(group)}">
        <legend>${esc(variantGroupTitle(group))}${group.required ? ' <abbr class="variant-required" title="Obligatorio">*</abbr>' : ''}</legend>
        <div class="variant-options">${options.join('')}</div>
      </fieldset>`;
    })
    .join('');

  wrap.querySelectorAll('.variant-option:not(.disabled)').forEach((btn) =>
    btn.addEventListener('click', () => selectOption(Number(btn.dataset.gid), Number(btn.dataset.oid)))
  );
}

function selectOption(groupId, optionId) {
  const product = state.currentProduct;
  const group = (product.variants || []).find((g) => g.id === groupId);
  const option = group && (group.options || []).find((o) => o.id === optionId);
  if (!group || !option || !option.available) return;
  state.selections[groupId] = {
    group_id: groupId,
    option_id: optionId,
    group_name: group.name,
    option_label: option.label,
    color: option.color || ''
  };
  renderVariants();
  updateBuyButtons();
}

function selectionErrors(product) {
  const errors = [];
  const groups = product && Array.isArray(product.variants) ? product.variants : [];
  for (const group of groups) {
    if (group.required && group.options && group.options.length && !state.selections[group.id]) {
      const kind = variantGroupKind(group);
      if (kind === 'colors') errors.push('Selecciona un color.');
      else if (kind === 'tallas') errors.push('Selecciona una talla.');
      else errors.push(`Selecciona ${group.name.toLowerCase()}.`);
    }
  }
  return errors;
}

function updateBuyButtons() {
  const product = state.currentProduct;
  const out = product && product.status === 'out_of_stock';
  const errors = product ? selectionErrors(product) : [];

  const add = $('#pm-add');
  const buy = $('#pm-buy');

  add.disabled = out || errors.length > 0;
  buy.disabled = out || errors.length > 0;
  add.textContent = out ? 'Agotado' : 'Añadir al carrito';
  buy.textContent = out ? 'Agotado' : 'Comprar ahora';
  add.classList.toggle('is-out', out);
  buy.classList.toggle('is-out', out);

  if (!out && errors.length) setAvailability(errors.join(' '), true);
  else setAvailability(out ? 'Agotado' : 'Disponible', false);
}

function changeQuantity(delta) {
  const input = $('#pm-qty');
  let value = Number.parseInt(input.value, 10) || 1;
  value = Math.min(99, Math.max(1, value + delta));
  input.value = value;
}

/* ------------------------------------------------------------------ */
/* Carrito                                                            */
/* ------------------------------------------------------------------ */

function cartLineKey(product, selections) {
  const parts = Object.keys(selections)
    .map(Number)
    .sort((a, b) => a - b)
    .map((gid) => `g${gid}o${selections[gid].option_id}`)
    .join('');
  return `p${product.id}${parts}`;
}

function buildCartLineFromCurrent() {
  const product = state.currentProduct;
  return {
    key: cartLineKey(product, state.selections),
    product_id: product.id,
    qty: state.quantity,
    variants: Object.keys(state.selections)
      .map(Number)
      .sort((a, b) => a - b)
      .map((gid) => ({
        group_id: gid,
        option_id: state.selections[gid].option_id
      })),
    selections: Object.keys(state.selections).map((gid) => ({
      group_id: Number(gid),
      option_id: state.selections[gid].option_id,
      group_name: state.selections[gid].group_name,
      option_label: state.selections[gid].option_label,
      color: state.selections[gid].color || ''
    })),
    snapshot: Object.assign({}, product)
  };
}

function addCurrentToCart() {
  const product = state.currentProduct;
  const errors = selectionErrors(product);
  if (errors.length) {
    showToast(errors[0]);
    return;
  }
  state.quantity = Math.min(99, Math.max(1, Number.parseInt($('#pm-qty').value, 10) || 1));
  cartAdd(buildCartLineFromCurrent());
  showToast(`${product.name} se añadió al carrito.`);
}

function buyNow() {
  const product = state.currentProduct;
  const errors = selectionErrors(product);
  if (errors.length) {
    showToast(errors[0]);
    return;
  }
  state.quantity = Math.min(99, Math.max(1, Number.parseInt($('#pm-qty').value, 10) || 1));
  const line = buildCartLineFromCurrent();
  state.cart = state.cart.filter((c) => c.key === line.key);
  state.cart.push(line);
  saveCart();
  renderCart();
  closeModal('#product-modal');
  openCheckout();
}

function cartAdd(line) {
  const existing = state.cart.find((c) => c.key === line.key);
  if (existing) {
    existing.qty = Math.min(99, existing.qty + line.qty);
  } else {
    state.cart.push(line);
  }
  saveCart();
  renderCart();
}

function cartSetQty(key, delta) {
  const line = state.cart.find((c) => c.key === key);
  if (!line) return;
  line.qty = Math.min(99, Math.max(1, line.qty + delta));
  saveCart();
  renderCart();
}

function cartRemove(key) {
  state.cart = state.cart.filter((c) => c.key !== key);
  saveCart();
  renderCart();
}

function clearCart() {
  state.cart = [];
  saveCart();
  renderCart();
}

function cartCount() {
  return state.cart.reduce((sum, c) => sum + c.qty, 0);
}

function cartEstimate() {
  return state.cart.reduce((sum, c) => {
    const p = c.snapshot || {};
    const unit = Number(p.final_price ?? p.price) || 0;
    return sum + unit * c.qty;
  }, 0);
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
  } catch {
    /* almacenamiento no disponible */
  }
}

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) state.cart = parsed.filter((c) => c && c.product_id && c.qty > 0 && c.snapshot);
  } catch {
    state.cart = [];
  }
}

function renderCart() {
  const badge = $('#cart-badge');
  const count = cartCount();
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);

  const itemsEl = $('#cart-items');
  const emptyEl = $('#cart-empty');
  const foot = $('.cart-foot');
  const subtotal = $('#cart-subtotal');

  if (!state.cart.length) {
    itemsEl.innerHTML = '';
    emptyEl.hidden = false;
    foot.hidden = true;
    subtotal.textContent = '';
    return;
  }
  emptyEl.hidden = true;
  foot.hidden = false;
  subtotal.innerHTML = `<span>Subtotal estimado</span><strong>${money(cartEstimate())}</strong>
    <small>El total se confirma al finalizar el pedido.</small>`;

  itemsEl.innerHTML = state.cart
    .map((line) => {
      const p = line.snapshot || {};
      const unit = Number(p.final_price ?? p.price) || 0;
      const variantText = line.selections && line.selections.length
        ? line.selections
            .map(
              (s) =>
                `<span class="cart-variant-line">${s.color ? `<span class="line-swatch" style="--vc:${esc(s.color)}"></span>` : ''}<span class="cart-variant-label">${esc(ZM.shortGroupName(s.group_name))}:</span> ${esc(s.option_label)}</span>`
            )
            .join('')
        : '';
      return `
      <article class="cart-item">
        <img class="cart-item-img" src="${esc(p.image || '/placeholder?name=' + encodeURIComponent(p.name))}"
             alt="${esc(p.name)}" data-name="${esc(p.name)}" onerror="imgFallback(this)">
        <div class="cart-item-info">
          <div class="cart-item-name">${esc(p.name)}</div>
          ${variantText ? `<div class="cart-item-variants">${variantText}</div>` : ''}
          <div class="cart-item-price">${money(unit)} c/u</div>
          <div class="cart-item-controls">
            <button type="button" class="qty-btn" data-dec="${esc(line.key)}" aria-label="Disminuir">−</button>
            <span class="cart-item-qty">${line.qty}</span>
            <button type="button" class="qty-btn" data-inc="${esc(line.key)}" aria-label="Aumentar">+</button>
          </div>
        </div>
        <button type="button" class="cart-item-remove" data-remove="${esc(line.key)}" aria-label="Quitar del carrito">Quitar</button>
      </article>`;
    })
    .join('');

  itemsEl.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => cartSetQty(b.dataset.dec, -1)));
  itemsEl.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => cartSetQty(b.dataset.inc, 1)));
  itemsEl.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => cartRemove(b.dataset.remove)));
}

function openCart() {
  const drawer = $('#cart-drawer');
  drawer.hidden = false;
  requestAnimationFrame(() => drawer.classList.add('open'));
  document.body.style.overflow = 'hidden';
}

function closeCart() {
  const drawer = $('#cart-drawer');
  drawer.classList.remove('open');
  document.body.style.overflow = '';
  setTimeout(() => {
    drawer.hidden = true;
    drawer.classList.remove('open');
  }, 260);
}

/* ------------------------------------------------------------------ */
/* Checkout multi-producto por WhatsApp                               */
/* ------------------------------------------------------------------ */

async function requestOrderQuote(lines) {
  const items = lines.map((l) => ({
    product_id: l.product_id,
    quantity: l.qty,
    variant_selections: l.variants
  }));
  const res = await fetch('/api/order/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'No se pudo calcular el precio. Intenta de nuevo.');
    err.errors = data.errors || null;
    err.product_id = data.product_id || null;
    throw err;
  }
  return data.quote;
}

async function openCheckout() {
  if (!state.cart.length) return;
  closeCart();
  let quote;
  try {
    quote = await requestOrderQuote(state.cart);
  } catch (quoteError) {
    state.quote = null;
    if (quoteError.product_id) {
      // Producto agotado o eliminado: se quita del carrito en vivo.
      state.cart = state.cart.filter((c) => c.product_id !== quoteError.product_id);
      saveCart();
      renderCart();
    }
    showToast(quoteError.message);
    return;
  }
  state.quote = quote;
  renderCheckoutSummary();
  openModal('#checkout-modal');
  setTimeout(() => {
    // En pantallas cortas, desplaza el modal hasta el formulario sin perder
    // el botón de cerrar (que queda fijo sobre el contenido desplegado).
    const modal = $('#checkout-modal');
    const form = $('#co-form');
    if (form && modal && window.innerHeight <= 700) {
      const formTop = form.getBoundingClientRect().top + modal.scrollTop;
      modal.scrollTop = Math.max(0, formTop - 14);
    }
    const field = $('#co-name');
    if (field) field.focus({ preventScroll: true });
  }, 400);
}

// Nuestro carrito va en el mismo orden que devuelve el servidor.
function cartForMessage() {
  const q = state.quote;
  if (!q || !Array.isArray(q.items)) return state.cart;
  return state.cart.map((line, i) => {
    const serverLine = q.items[i] || {};
    return {
      product: { name: serverLine.name || (line.snapshot.name || ''), category_name: serverLine.category_name || '' },
      quantity: line.qty,
      selections: serverLine.variants || line.selections || [],
      unit_price: serverLine.unit_price,
      subtotal: serverLine.subtotal,
      discount_amount: serverLine.discount_amount
    };
  });
}

function renderCheckoutSummary() {
  const q = state.quote;
  if (!q || !Array.isArray(q.items)) {
    $('#co-items').innerHTML = '';
    $('#co-totals').innerHTML = '';
    return;
  }

  $('#co-items').innerHTML = q.items
    .map((line) => {
      const variants =
        line.variants && line.variants.length
          ? `<div class="co-variants">${line.variants.map((v) => esc(v.option_label)).join(' · ')}</div>`
          : '';
      const old = Number(line.unit_original) || 0;
      const unit = Number(line.unit_price) || 0;
      const unitHtml = line.discount_amount > 0
        ? `<span class="price-old">${money(old)}</span> ${money(unit)} c/u`
        : `${money(unit)} c/u`;
      return `
      <article class="co-item">
        <img class="co-item-img" src="${esc(line.image || '/placeholder?name=' + encodeURIComponent(line.name))}"
             alt="${esc(line.name)}" data-name="${esc(line.name)}" onerror="imgFallback(this)">
        <div class="co-item-info">
          <div class="co-item-name">${esc(line.name)}
            ${line.category_name ? `<span class="co-item-category">${esc(line.category_name)}</span>` : ''}
          </div>
          ${variants}
          <div class="co-item-unit">${unitHtml}</div>
        </div>
        <div class="co-item-qty">Cantidad: ${line.quantity}</div>
      </article>`;
    })
    .join('');

  const shipping = q.shipping;
  const grand = shipping === null || shipping === undefined ? `${money(q.subtotal)} + envío` : money(q.subtotal + shipping);
  const discountRow = q.discount_amount > 0
    ? `<div class="co-total-row discount"><span>Descuento aplicado</span><strong>-${money(q.discount_amount)}</strong></div>`
    : '';
  const shippingRow = shipping === null || shipping === undefined
    ? `<div class="co-total-row"><span>Envío</span><span class="co-total-pending">Por confirmar</span></div>`
    : `<div class="co-total-row"><span>Envío</span><strong>${money(shipping)}</strong></div>`;

  $('#co-totals').innerHTML = `
    <div class="co-total-row"><span>Subtotal</span><strong>${money(q.subtotal)}</strong></div>
    ${discountRow}
    ${shippingRow}
    <div class="co-total-row grand"><span>Total</span><strong>${grand}</strong></div>`;
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
    quote = await requestOrderQuote(state.cart);
    state.quote = quote;
  } catch (quoteError) {
    btn.disabled = false;
    btn.textContent = originalLabel;
    if (quoteError.product_id) {
      state.cart = state.cart.filter((c) => c.product_id !== quoteError.product_id);
      saveCart();
      renderCart();
    }
    error.textContent = quoteError.message;
    error.hidden = false;
    return;
  }

  renderCheckoutSummary();
  const message = ZM.buildOrderMessage(state.settings, cartForMessage(), data, state.quote);
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

function closeMenu() {
  const nav = $('#main-nav');
  const toggle = $('#menu-toggle');
  nav.classList.remove('open');
  toggle.classList.remove('open');
  toggle.setAttribute('aria-expanded', 'false');
}

function parseCollectionHash() {
  const m = /^#coleccion\/([^/]+)$/.exec(window.location.hash || '');
  return m ? decodeURIComponent(m[1]) : null;
}

function initEvents() {
  $('#pm-minus').addEventListener('click', () => changeQuantity(-1));
  $('#pm-plus').addEventListener('click', () => changeQuantity(1));
  $('#pm-qty').addEventListener('change', (e) => {
    let v = Number.parseInt(e.target.value, 10) || 1;
    e.target.value = Math.min(99, Math.max(1, v));
  });
  $('#pm-add').addEventListener('click', addCurrentToCart);
  $('#pm-buy').addEventListener('click', buyNow);
  $('#co-form').addEventListener('submit', handleCheckoutSubmit);

  $('#cart-open').addEventListener('click', () => {
    closeModal('#product-modal');
    openCart();
  });
  $('#cart-close').addEventListener('click', closeCart);
  $('#cart-overlay').addEventListener('click', closeCart);
  $('#cart-checkout').addEventListener('click', openCheckout);
  $('#cart-empty-link').addEventListener('click', closeCart);
  $('#cart-clear').addEventListener('click', () => {
    clearCart();
    showToast('Carrito vaciado.');
  });

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => {
      closeModal('#product-modal');
      closeModal('#checkout-modal');
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeCart();
    closeModal('#product-modal');
    closeModal('#checkout-modal');
  });

  const toggle = $('#menu-toggle');
  const nav = $('#main-nav');
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', closeMenu));

  window.addEventListener('hashchange', renderCollection);

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
  loadCart();
  renderCollection();
  renderCart();
  initEvents();
  observeReveal();
}

document.addEventListener('DOMContentLoaded', init);