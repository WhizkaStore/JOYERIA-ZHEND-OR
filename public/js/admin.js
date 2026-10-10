'use strict';

/* ==========================================================================
   ZHEND'OR Joyería — lógica del panel de administración
   Autenticación por cookie de sesión (el servidor protege /admin y la API).
   ========================================================================== */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

const money = (value) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(Number(value) || 0);

// Convierte valores numéricos escritos con separadores (ej. "113.900") a enteros.
const copInt = (value) => {
  const n = Number.parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : NaN;
};

/* ------------------------------------------------------------------ */
/* Cliente API (usa la cookie de sesión automáticamente)              */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 401) {
    location.replace('/login');
    throw new Error('Sesión expirada.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data.error || (Array.isArray(data.errors) ? data.errors.join(' ') : '') || 'Ocurrió un error.';
    throw new Error(message);
  }
  return data;
}

function logout() {
  api('/api/admin/logout', { method: 'POST' })
    .catch(() => {})
    .finally(() => location.replace('/login'));
}

/* ------------------------------------------------------------------ */
/* Utilidades de UI                                                   */
/* ------------------------------------------------------------------ */

let toastTimer;
function showToast(text, isError = false) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3800);
}

function openModal(sel) {
  $(sel).hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal(sel) {
  $(sel).hidden = true;
  document.body.style.overflow = '';
}

function readImageFile(file, maxSize = 1400, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('El archivo debe ser una imagen.'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('La imagen no puede superar los 8 MB.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('La imagen no es válida.'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFCF5';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ */
/* Descuentos: cálculo local para la vista previa                     */
/* ------------------------------------------------------------------ */

function computeDiscount(source) {
  const price = Number(source.price) || 0;
  const type = source.discount_type || 'none';
  const value = Number(source.discount_value) || 0;
  const active = source.discount_active === true || source.discount_active === 1 || source.discount_active === 'true' || source.discount_active === 'on';

  let applied = active && (type === 'percent' || type === 'fixed') && value > 0;
  const now = Date.now();
  const parse = (v, end) => {
    if (!v) return NaN;
    const s = String(v);
    return Date.parse(s.length === 10 ? s + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z') : s);
  };
  const start = parse(source.discount_start, false);
  const end = parse(source.discount_end, true);
  if (!Number.isNaN(start) && now < start) applied = false;
  if (!Number.isNaN(end) && now > end) applied = false;

  let amount = 0;
  if (applied) {
    amount = type === 'percent'
      ? Math.round((price * Math.min(100, Math.max(0, value))) / 100)
      : Math.min(price, Math.max(0, value));
  }
  const final = Math.max(0, price - amount);
  const label = applied ? (type === 'percent' ? `-${value}%` : `-${money(amount)}`) : '';
  return { applied, amount, final, label };
}

/* ------------------------------------------------------------------ */
/* Datos                                                              */
/* ------------------------------------------------------------------ */

let products = [];
let productsAll = [];
let productsFilter = null;
let categories = [];
let currentSettings = null;
let pendingImage = null;
let pendingLogo = null;
let deleteId = null;
let editorVariants = [];
let variantIdSeed = 1;
let colorPalette = [];
const currentOption = { g: null, o: null };

/* Colores de fábrica que siempre aparecen en la cuadrícula del editor. */
const BASE_COLORS = [
  ['Dorado', '#d8be69'],
  ['Oro viejo', '#b8933d'],
  ['Champagne', '#e9ddba'],
  ['Plata', '#c0c0c0'],
  ['Negro', '#2a2a2a'],
  ['Blanco', '#f5f3ee'],
  ['Marfil', '#fffff0'],
  ['Beige', '#dcd3bf'],
  ['Camel', '#c19a6b'],
  ['Marrón', '#6f4e37'],
  ['Chocolate', '#4a3127'],
  ['Burdeos', '#7a2e2e'],
  ['Rojo', '#a63432'],
  ['Coral', '#e86850'],
  ['Terracota', '#cb7a5a'],
  ['Rosado', '#d98ba8'],
  ['Rosa palo', '#e8c4c4'],
  ['Rosa cuarzo', '#f7b3c4'],
  ['Fucsia', '#c71585'],
  ['Naranja', '#d9822b'],
  ['Amarillo', '#e8b23a'],
  ['Oliva', '#8a9a6b'],
  ['Verde esmeralda', '#2f7d63'],
  ['Verde bosque', '#3d5c4a'],
  ['Turquesa', '#3fa9a0'],
  ['Celeste', '#a8cfdd'],
  ['Azul acero', '#5b7c99'],
  ['Azul marino', '#2e4a6e'],
  ['Lavanda', '#c6b9db'],
  ['Morado', '#7b5e9b'],
  ['Violeta', '#5a3d6e'],
  ['Gris perla', '#b9b4aa']
];

const normalizeHex = (hex) => {
  let value = String(hex || '').trim().toLowerCase();
  if (!value) return null;
  if (value[0] !== '#') value = '#' + value;
  if (/^#([0-9a-f]{3})$/.test(value)) {
    value = '#' + value.slice(1).split('').map((d) => d + d).join('');
  }
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
};

async function loadColorPalette() {
  let saved = [];
  try {
    saved = (await api('/api/admin/palette')).colors || [];
  } catch {
    saved = [];
  }
  const map = new Map();
  const add = (label, hex, source) => {
    const h = normalizeHex(hex);
    if (!h) return;
    const key = h.toLowerCase();
    const prev = map.get(key);
    const labelOk = String(label || '').trim();
    if (!prev) {
      map.set(key, { label: labelOk || h, hex: h, source });
    } else if (source === 'save' || (source === 'base' && prev.source === 'derived')) {
      prev.label = labelOk || h;
      prev.source = source;
    }
  };
  saved.forEach((c) => add(c.label, c.hex, 'save'));
  BASE_COLORS.forEach(([label, hex]) => add(label, hex, 'base'));
  productsAll.forEach((p) => {
    (p.variants || []).forEach((g) => {
      (g.options || []).forEach((o) => {
        if (o.color) add(o.label || o.color, o.color, 'derived');
      });
    });
  });
  colorPalette = [...map.values()].map(({ label, hex }) => ({ label, hex }));
}

function persistPalette() {
  return api('/api/admin/palette', { method: 'PUT', body: { colors: colorPalette } }).catch(() => {});
}

function upsertPalette(label, hex) {
  const h = normalizeHex(hex);
  if (!h) return null;
  const key = h.toLowerCase();
  const existing = colorPalette.find((c) => c.hex.toLowerCase() === key);
  const name = String(label || '').trim() || existing?.label || h;
  if (existing) existing.label = name;
  else colorPalette.push({ label: name, hex: h });
  return h;
}

async function loadProducts() {
  try {
    const data = await api('/api/admin/products');
    productsAll = data.products;
    productsFilter = null;
    products = [...productsAll];
    renderProducts();
    renderDashboard();
    updateProductsFilterBar();
  } catch (error) {
    showToast(error.message, true);
  }
}

function updateProductsFilterBar() {
  const bar = $('#products-filter-bar');
  if (!bar) return;
  if (!productsFilter) {
    bar.hidden = true;
    return;
  }
  const cat = categories.find((c) => c.slug === productsFilter);
  bar.hidden = false;
  $('#products-filter-name').textContent = cat ? cat.name : productsFilter;
}

function fillCategoryOptions(selected = '') {
  const sel = $('#p-category');
  if (!sel) return;
  sel.innerHTML =
    '<option value="">Sin categoría</option>' +
    categories
      .map((c) => `<option value="${esc(c.slug)}"${c.slug === selected ? ' selected' : ''}>${esc(c.name)}</option>`)
      .join('');
}

async function loadCategories() {
  try {
    const data = await api('/api/admin/categories');
    categories = data.categories || [];
    fillCategoryOptions();
  } catch (error) {
    showToast(error.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* Resumen                                                            */
/* ------------------------------------------------------------------ */

function renderDashboard() {
  if (!products.length && !$('#stat-total')) return;
  const total = products.length;
  const published = products.filter((p) => Number(p.published) === 1).length;
  const out = products.filter((p) => p.status === 'out_of_stock').length;
  const discounts = products.filter((p) => p.has_discount || computeDiscount(p).applied).length;

  $('#stat-total').textContent = total;
  $('#stat-published').textContent = published;
  $('#stat-out').textContent = out;
  $('#stat-discounts').textContent = discounts;
}

/* ------------------------------------------------------------------ */
/* Productos                                                          */
/* ------------------------------------------------------------------ */

function renderProducts() {
  const tbody = $('#products-tbody');
  const empty = $('#products-empty');
  empty.hidden = products.length > 0;

  tbody.innerHTML = products
    .map((p) => {
      const out = p.status === 'out_of_stock';
      const published = Number(p.published) === 1;
      const thumb = p.image || '/placeholder?name=' + encodeURIComponent(p.name);

      let discountCell = '<span class="pill pill-muted">—</span>';
      if (p.discount_type === 'percent' || p.discount_type === 'fixed') {
        const base = p.discount_type === 'percent' ? `${p.discount_value}%` : money(p.discount_value);
        const applied = p.has_discount || computeDiscount(p).applied;
        discountCell = applied
          ? `<span class="pill pill-gold">${esc(base)}</span>`
          : `<span class="pill pill-muted" title="Configurado pero inactivo">${esc(base)} · inactivo</span>`;
      }

      const priceCell = p.has_discount
        ? `<span class="cell-price price-old">${money(p.price)}</span><br><span class="cell-price">${money(p.final_price)}</span>`
        : `<span class="cell-price">${money(p.price)}</span>`;

      return `
      <tr>
        <td>
          <img class="thumb" src="${esc(thumb)}" alt="" loading="lazy"
               onerror="this.onerror=null;this.src='/placeholder?name=' + encodeURIComponent('${esc(p.name)}')">
        </td>
        <td>
          <div class="cell-name">${esc(p.name)}</div>
          ${p.category_name ? `<button class="cell-category" data-filter="${esc(p.category)}">${esc(p.category_name)}</button>` : ''}
        </td>
        <td>${priceCell}</td>
        <td>${discountCell}</td>
        <td>${p.weight ? esc(p.weight) : '<span class="pill pill-muted">—</span>'}</td>
        <td><span class="pill ${out ? 'pill-red' : 'pill-green'}">${out ? 'Agotado' : 'Disponible'}</span></td>
        <td><span class="pill ${published ? 'pill-gold' : 'pill-muted'}">${published ? 'Publicado' : 'Oculto'}</span></td>
        <td>
          <div class="row-actions">
            <button class="icon-action" data-edit="${p.id}" title="Editar" aria-label="Editar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m14 6 4 4"/></svg>
            </button>
            <button class="icon-action danger" data-delete="${p.id}" title="Eliminar" aria-label="Eliminar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () => openEditor(Number(btn.dataset.edit)))
  );
  tbody.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', () => askDelete(Number(btn.dataset.delete)))
  );
  tbody.querySelectorAll('[data-filter]').forEach((btn) =>
    btn.addEventListener('click', () => {
      productsFilter = btn.dataset.filter;
      products = productsAll.filter((p) => p.category === productsFilter);
      renderProducts();
      updateProductsFilterBar();
    })
  );
  const clearFilter = $('#products-filter-clear');
  if (clearFilter) {
    clearFilter.addEventListener('click', () => {
      productsFilter = null;
      products = [...productsAll];
      renderProducts();
      updateProductsFilterBar();
    });
  }
}

/* ------------------------------------------------------------------ */
/* Editor de producto (agregar / editar)                              */
/* ------------------------------------------------------------------ */

function showPanel(name) {
  $$('[data-view-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== name;
  });
}

function setActiveTab(view) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
}

function switchView(view) {
  if (view === 'new') {
    setActiveTab('new');
    openEditor(null);
    return;
  }
  setActiveTab(view);
  showPanel(view);
  if (view === 'dashboard') renderDashboard();
  if (view === 'discounts') renderDiscounts();
  if (view === 'categories') loadCategories().then(renderCategoryManager);
  if (view === 'settings' && !currentSettings) loadSettings();
}

function openEditor(id = null) {
  const form = $('#product-form');
  form.reset();
  $('#product-error').hidden = true;
  pendingImage = null;
  updateImagePreview('');

  if (id) {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    $('#editor-title').textContent = 'Editar producto';
    $('#editor-sub').textContent = `Modificando “${p.name}”.`;
    $('#p-id').value = p.id;
    $('#p-name').value = p.name;
    $('#p-description').value = p.description || '';
    $('#p-price').value = p.price;
    $('#p-weight').value = p.weight || '';
    fillCategoryOptions(p.category || '');
    $('#p-status').value = p.status;
    $('#p-published').value = String(Number(p.published));
    $('#p-discount_type').value = p.discount_type || 'none';
    $('#p-discount_value').value = p.discount_value || 0;
    $('#p-discount_active').checked = Number(p.discount_active) === 1;
    $('#p-discount_start').value = p.discount_start || '';
    $('#p-discount_end').value = p.discount_end || '';
    updateImagePreview(p.image || '');
    renderVariantsEditor(p.variants || []);
  } else {
    $('#editor-title').textContent = 'Agregar producto';
    $('#editor-sub').textContent = 'Registra una nueva pieza para el catálogo.';
    $('#p-id').value = '';
    fillCategoryOptions('');
    $('#p-status').value = 'available';
    $('#p-published').value = '1';
    $('#p-discount_type').value = 'none';
    $('#p-discount_value').value = 0;
    $('#p-discount_active').checked = false;
    $('#p-discount_start').value = '';
    $('#p-discount_end').value = '';
    renderVariantsEditor([]);
  }

  ensureRingSizeGroup();
  setActiveTab('new');
  showPanel('editor');
  updateDiscountPreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => $('#p-name').focus(), 200);
}

function readEditorDiscount() {
  return {
    price: copInt($('#p-price').value) || 0,
    discount_type: $('#p-discount_type').value,
    discount_value: copInt($('#p-discount_value').value) || 0,
    discount_active: $('#p-discount_active').checked,
    discount_start: $('#p-discount_start').value,
    discount_end: $('#p-discount_end').value
  };
}

function updateDiscountPreview(source) {
  const el = $('#p-discount-preview');
  const data = source || readEditorDiscount();
  if (data.discount_type === 'none') {
    el.textContent = 'Precio final: ' + money(data.price);
    return;
  }
  const { applied, final, label } = computeDiscount(data);
  const status = applied ? `Activo ${label}` : 'Inactivo';
  el.innerHTML =
    `Precio final: <strong>${money(final)}</strong>` +
    (applied && final !== data.price ? ` <span class="price-old">${money(data.price)}</span>` : '') +
    ` · <span class="discount-status ${applied ? 'on' : 'off'}">${status}</span>`;
}

function updateImagePreview(src) {
  const img = $('#p-image-preview');
  const hint = $('#image-drop-hint');
  if (src) {
    img.src = src;
    img.hidden = false;
    hint.hidden = true;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    hint.hidden = false;
  }
}

async function handleProductImage(file) {
  try {
    const edited = await ZhendorImageEditor.editImage(file);
    if (!edited) return;
    pendingImage = edited;
    updateImagePreview(pendingImage);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveProduct(event) {
  event.preventDefault();
  const errorEl = $('#product-error');
  errorEl.hidden = true;

  const id = $('#p-id').value;
  const name = $('#p-name').value.trim();
  const price = copInt($('#p-price').value);
  const type = $('#p-discount_type').value;
  const value = copInt($('#p-discount_value').value) || 0;

  if (name.length < 2) {
    return showFormError(errorEl, 'El nombre debe tener al menos 2 caracteres.');
  }
  if (!Number.isFinite(price) || price < 1) {
    return showFormError(errorEl, 'Introduce un precio válido en pesos colombianos.');
  }
  if (type === 'percent' && value > 100) {
    return showFormError(errorEl, 'El porcentaje de descuento no puede superar el 100 %.');
  }
  if (type === 'fixed' && value > price) {
    return showFormError(errorEl, 'El descuento fijo no puede ser mayor que el precio.');
  }
  const start = $('#p-discount_start').value;
  const end = $('#p-discount_end').value;
  if (start && end && start > end) {
    return showFormError(errorEl, 'La fecha de inicio no puede ser posterior a la de fin.');
  }

  const payload = {
    name,
    description: $('#p-description').value.trim(),
    price,
    weight: $('#p-weight').value.trim(),
    category: $('#p-category').value,
    status: $('#p-status').value,
    published: $('#p-published').value === '1',
    discount_type: type,
    discount_value: value,
    discount_active: $('#p-discount_active').checked,
    discount_start: start,
    discount_end: end,
    variants: readVariantsEditor()
  };
  if (pendingImage) payload.image = pendingImage;

  const btn = $('#product-save');
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  try {
    if (id) {
      await api('/api/admin/products/' + id, { method: 'PUT', body: payload });
      showToast('Producto actualizado.');
    } else {
      await api('/api/admin/products', { method: 'POST', body: payload });
      showToast('Producto creado.');
    }
    await loadProducts();
    switchView('products');
  } catch (error) {
    showFormError(errorEl, error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar producto';
  }
}

function showFormError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Editor de variantes de producto                                    */
/* ------------------------------------------------------------------ */

const SIZE_PRESET = ['6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24'];

const SIZE_RE = /talla|tama|medida|num|numero|numeración/i;
const COLOR_RE = /color|hilo|tono|tapiz|material|cinta/i;

// Determina el tipo de grupo: 'colors', 'tallas' u 'opciones'.
function modeOfGroup(g) {
  g = g || {};
  const name = String(g.name || '');
  if (SIZE_RE.test(name)) return 'tallas';
  if (COLOR_RE.test(name) || (g.options || []).some((o) => o && o.color)) return 'colors';
  return 'opciones';
}

function nextVariantId() {
  return variantIdSeed++;
}

// Garantiza que un anillo tenga su grupo de "Tallas de anillos".
// No duplica si ya existe y conserva las tallas guardadas.
function ensureRingSizeGroup() {
  const sel = document.getElementById('p-category');
  if (!sel || sel.value !== 'anillos') return;
  const hasSizes = editorVariants.some((g) => (g.mode || modeOfGroup(g)) === 'tallas');
  if (hasSizes) return;
  editorVariants.push({
    _gid: nextVariantId(),
    name: 'Talla del anillo',
    required: true,
    single: false,
    mode: 'tallas',
    options: []
  });
  renderVariantsEditor(editorVariants);
}

function renderVariantsEditor(groups) {
  const container = $('#variant-groups');
  editorVariants = (groups || []).map((g) => ({
    _gid: nextVariantId(),
    name: g.name || '',
    required: !!g.required,
    single: !!g.single,
    mode: modeOfGroup(g),
    options: (g.options || []).map((o) => ({
      _oid: nextVariantId(),
      label: o.label || '',
      color: o.color || '',
      available: o.available !== false
    }))
  }));

  const findGroup = (gid) => editorVariants.find((g) => g._gid === gid);
  const findOption = (g, oid) => g.options.find((o) => o._oid === oid);
  const pushColor = (g, hex, label) => {
    g.options.push({
      _oid: nextVariantId(),
      label: String(label || '').trim() || hex,
      color: hex,
      available: true
    });
  };
  const hasHex = (g, hex) => g.options.some((o) => normalizeHex(o.color) === hex);

  const closeEditor = () => {
    document.querySelectorAll('[data-editor]').forEach((el) => el.classList.add('hidden'));
    currentOption.g = null;
    currentOption.o = null;
  };

  const render = () => {
    if (!editorVariants.length) {
      container.innerHTML =
        '<p class="empty-note variants-empty">Sin variantes. Añade grupos de color, talla u otra opción.</p>';
      return;
    }
    container.innerHTML = editorVariants.map(renderGroup).join('');
    bindEvents();
  };

  const renderGroup = (g) => {
    const gid = g._gid;
    if (!g.mode) g.mode = modeOfGroup(g);
    const sizesMode = g.mode === 'tallas';
    const colorsMode = g.mode === 'colors';

    const sectionTitle = sizesMode
      ? 'Tallas de anillos'
      : colorsMode
        ? 'Colores disponibles'
        : 'Opciones del grupo';
    const sectionHint = sizesMode
      ? 'Toca las tallas que estén disponibles. La tienda solo mostrará las marcadas.'
      : colorsMode
        ? 'Toca una muestra para añadirla o quitarla del producto.'
        : 'Añade y edita las opciones de este grupo.';

    const modeSwitch = `
      <div class="vg-mode" role="group" aria-label="Tipo de variante">
        <button type="button" class="${colorsMode ? 'on' : ''}" data-mode="colors">Colores</button>
        <button type="button" class="${sizesMode ? 'on' : ''}" data-mode="tallas">Tallas</button>
        <button type="button" class="${g.mode === 'opciones' ? 'on' : ''}" data-mode="opciones">Opciones</button>
      </div>`;

    const sizeLabels = [];
    SIZE_PRESET.forEach((s) => {
      if (!sizeLabels.includes(s)) sizeLabels.push(s);
    });
    g.options.forEach((o) => {
      const l = String(o.label || '').trim();
      if (l && !sizeLabels.includes(l)) sizeLabels.push(l);
    });
    const sizeTiles = sizeLabels
      .map((size) => {
        const opt = g.options.find((o) => o.label === size);
        const on = !!(opt && opt.available);
        return `
        <button type="button" class="size-chip ${on ? 'on' : 'off'}" data-size="${esc(size)}" title="Marcar talla ${esc(size)} como ${on ? 'no disponible' : 'disponible'}">
          <span class="size-num">${esc(size)}</span>
          <span class="size-state">${on ? 'Disponible' : 'Agotado'}</span>
        </button>`;
      })
      .join('');
    const tiles = g.options
      .map(
        (o) => `
        <button type="button" class="vsw ${o.available ? '' : 'vsw-off'}" data-gid="${gid}" data-oid="${o._oid}" title="Editar ${esc(o.label)}">
          <span class="vsw-dot" style="--vc:${esc(o.color || '#d8be69')}"></span>
          <span class="vsw-name">${esc(o.label || '(sin nombre)')}</span>
          ${o.available ? '' : '<span class="vsw-tag">Agotado</span>'}
          <span class="vsw-edit" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16M5 17l11-11 3 3-11 11-4 1z"/></svg>
          </span>
        </button>`
      )
      .join('');

    const paletteBlock = colorsMode
      ? `<div class="vg-palette">
           <p class="vg-label">Paleta · toca una muestra para añadirla o quitarla del producto</p>
           <div class="vg-palette-grid">
             ${colorPalette
               .map((c) => `
               <button type="button" class="palt ${hasHex(g, c.hex) ? 'in' : ''}" data-gid="${gid}" data-hex="${esc(c.hex)}" title="${esc(c.label)}">
                 <span class="vsw-dot" style="--vc:${esc(c.hex)}"></span>
                 <span class="vsw-name">${esc(c.label)}</span>
                 <span class="palt-check" aria-hidden="true">
                   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
                 </span>
               </button>`)
               .join('')}
           </div>
           <div class="vg-custom">
             <input type="color" class="cp-color" value="#d8be69" aria-label="Tonalidad del color nuevo">
             <input type="text" class="cp-name" maxlength="40" placeholder="Nombre del color (ej. Azul capa)" aria-label="Nombre del color nuevo">
             <button type="button" class="btn btn-ghost btn-small cp-add" data-gid="${gid}">Añadir color</button>
           </div>
         </div>`
      : '';

    const editorBlock = sizesMode
      ? ''
      : `<div class="vg-editor hidden" data-editor>
        <p class="vg-label">Editar color</p>
        <div class="vg-editor-row">
          <label class="color-field" title="Tonalidad">
            <input type="color" class="ed-color" value="#d8be69" aria-label="Tonalidad">
          </label>
          <input type="text" class="ed-label" maxlength="80" placeholder="Nombre del color (ej. Azul)" aria-label="Nombre del color">
          <label class="switch switch-mini">
            <input type="checkbox" class="ed-available" checked>
            <span>Disponible</span>
          </label>
          <button type="button" class="btn btn-danger btn-small ed-remove">Quitar</button>
          <button type="button" class="btn btn-ghost btn-small ed-done">Listo</button>
        </div>
      </div>`;

    const contentBlock = sizesMode
      ? `<div class="vg-sizes">
           <p class="vg-label">Marca las tallas disponibles de este anillo:</p>
           <div class="vg-size-grid">${sizeTiles}</div>
           <div class="vg-custom">
             <input type="text" class="sp-size-name" maxlength="12" placeholder="Otra talla (ej. 12.5)" aria-label="Otra talla">
             <button type="button" class="btn btn-ghost btn-small sp-add" data-gid="${gid}">Añadir talla</button>
           </div>
         </div>`
      : `<div class="vg-swatches">
           ${tiles || '<p class="vg-label">Aún sin opciones.</p>'}
         </div>
         <button type="button" class="btn btn-ghost btn-small vg-opt-add" data-gid="${gid}">+ Añadir opción</button>
         ${paletteBlock}`;

    return `
    <div class="variant-group-box" data-gid="${gid}" data-mode="${g.mode}">
      <div class="vg-head">
        <input type="text" class="vg-name" value="${esc(g.name)}" maxlength="80"
               placeholder="${sizesMode ? 'Talla del anillo' : 'Nombre del grupo (ej. Color de hilo)'}" aria-label="Nombre del grupo de variantes">
        ${modeSwitch}
        <label class="switch switch-mini">
          <input type="checkbox" class="vg-required" ${g.required ? 'checked' : ''}>
          <span>Obligatorio</span>
        </label>
        ${sizesMode ? '' : `<label class="switch switch-mini" title="Limita la selección a un solo color en este grupo">
          <input type="checkbox" class="vg-single" ${g.single ? 'checked' : ''}>
          <span>Un solo color</span>
        </label>`}
        <button type="button" class="icon-action danger vg-remove" title="Quitar grupo" aria-label="Quitar grupo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <div class="vg-section">
        <h4 class="vg-section-title">${sectionTitle}</h4>
        <p class="vg-section-hint">${sectionHint}</p>
      </div>

      ${editorBlock}
      ${contentBlock}
    </div>`;
  };

  const bindEvents = () => {
    container.querySelectorAll('.variant-group-box').forEach((box) => {
      const gid = Number(box.dataset.gid);
      const group = findGroup(gid);

      box.querySelector('.vg-name').addEventListener('input', (e) => {
        group.name = e.target.value;
      });
      box.querySelectorAll('.vg-mode button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const next = btn.dataset.mode;
          if (!next || next === group.mode) return;
          group.mode = next;
          if (next === 'tallas' && !String(group.name || '').trim()) {
            group.name = 'Talla del anillo';
          }
          render();
        });
      });
      box.querySelector('.vg-required').addEventListener('change', (e) => {
        group.required = e.target.checked;
      });
      const singleSwitch = box.querySelector('.vg-single');
      if (singleSwitch) {
        singleSwitch.addEventListener('change', (e) => {
          group.single = e.target.checked;
        });
      }
      box.querySelector('.vg-remove').addEventListener('click', () => {
        editorVariants = editorVariants.filter((g) => g._gid !== gid);
        render();
      });
      const optAdd = box.querySelector('.vg-opt-add');
      if (optAdd) {
        optAdd.addEventListener('click', () => {
          pushColor(group, '', '');
          render();
        });
      }

      box.querySelectorAll('.size-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const size = chip.dataset.size;
          const existing = group.options.find((o) => o.label === size);
          if (existing && existing.available) {
            group.options = group.options.filter((o) => o.label !== size);
          } else if (existing) {
            existing.available = true;
          } else {
            group.options.push({ _oid: nextVariantId(), label: size, color: '', available: true });
          }
          render();
        });
      });

      const addSizeInput = box.querySelector('.sp-size-name');
      const addSizeBtn = box.querySelector('.sp-add');
      const addSize = () => {
        const name = String(addSizeInput ? addSizeInput.value : '').trim();
        if (!name) {
          showToast('Escribe una talla válida.', true);
          return;
        }
        const existing = group.options.find((o) => o.label === name);
        if (existing) existing.available = true;
        else group.options.push({ _oid: nextVariantId(), label: name, color: '', available: true });
        if (addSizeInput) addSizeInput.value = '';
        render();
      };
      if (addSizeBtn) addSizeBtn.addEventListener('click', addSize);
      if (addSizeInput) addSizeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addSize();
        }
      });

      const editorEl = box.querySelector('[data-editor]');
      const openEditorFor = (oid) => {
        currentOption.g = group;
        currentOption.o = findOption(group, oid);
        if (!currentOption.o) return;
        editorEl.classList.remove('hidden');
        const color = editorEl.querySelector('.ed-color');
        const label = editorEl.querySelector('.ed-label');
        const avail = editorEl.querySelector('.ed-available');
        color.value = currentOption.o.color || '#d8be69';
        label.value = currentOption.o.label || '';
        avail.checked = currentOption.o.available !== false;
        color.oninput = () => {
          const h = normalizeHex(color.value);
          if (h) {
            currentOption.o.color = h;
            if (upsertPalette(currentOption.o.label, h)) persistPalette();
          }
        };
        label.oninput = () => {
          currentOption.o.label = label.value;
          if (upsertPalette(label.value, currentOption.o.color)) persistPalette();
        };
        avail.onchange = () => {
          currentOption.o.available = avail.checked;
          closeEditor();
          currentOption.g = null;
          currentOption.o = null;
          render();
        };
        editorEl.querySelector('.ed-remove').onclick = () => {
          group.options = group.options.filter((o) => o._oid !== oid);
          closeEditor();
          render();
        };
        editorEl.querySelector('.ed-done').onclick = () => {
          closeEditor();
          currentOption.g = null;
          currentOption.o = null;
          if (group.mode === 'colors' && !box.querySelector('.vg-palette')) render();
        };
      };

      box.querySelectorAll('.vsw[data-oid]').forEach((tile) => {
        tile.addEventListener('click', () => openEditorFor(Number(tile.dataset.oid)));
      });

      box.querySelectorAll('.palt').forEach((tile) => {
        tile.addEventListener('click', () => {
          const hex = normalizeHex(tile.dataset.hex);
          if (!hex) return;
          const entry = colorPalette.find((c) => c.hex.toLowerCase() === hex.toLowerCase());
          closeEditor();
          if (group.single) {
            group.options = !hasHex(group, hex)
              ? [{ _oid: nextVariantId(), label: entry ? entry.label : hex, color: hex, available: true }]
              : [];
          } else {
            const existing = group.options.find((o) => normalizeHex(o.color) === hex);
            if (existing) group.options = group.options.filter((o) => o._oid !== existing._oid);
            else pushColor(group, hex, entry ? entry.label : hex);
          }
          render();
        });
      });

      const cpAdd = box.querySelector('.cp-add');
      if (cpAdd) {
        cpAdd.addEventListener('click', () => {
        const hex = normalizeHex(box.querySelector('.cp-color').value);
        if (!hex) {
          showToast('Selecciona una tonalidad válida.', true);
          return;
        }
        const name = box.querySelector('.cp-name').value.trim();
        upsertPalette(name, hex);
        persistPalette();
        const entry = colorPalette.find((c) => c.hex === hex);
        if (group.single) {
          group.options = !hasHex(group, hex)
            ? [{ _oid: nextVariantId(), label: name || (entry ? entry.label : hex), color: hex, available: true }]
            : [];
        } else {
          const existing = group.options.find((o) => normalizeHex(o.color) === hex);
          if (existing) existing.label = name || existing.label;
          else pushColor(group, hex, name || (entry ? entry.label : hex));
        }
        box.querySelector('.cp-name').value = '';
        closeEditor();
        render();
        showToast(`Color ${name || hex} añadido.`);
        });
      }
    });
  };

  render();
}

function readVariantsEditor() {
  return editorVariants
    .filter((g) => g.name.trim())
    .map((g) => ({
      name: g.name.trim(),
      required: !!g.required,
      options: g.options
        .filter((o) => o.label.trim())
        .map((o) => ({
          label: o.label.trim(),
          color: o.color.trim(),
          available: o.available !== false
        }))
    }));
}

/* ------------------------------------------------------------------ */
/* Eliminar producto                                                  */
/* ------------------------------------------------------------------ */

function askDelete(id) {
  const p = products.find((x) => x.id === id);
  deleteId = id;
  $('#confirm-text').textContent = `¿Seguro que deseas eliminar “${p ? p.name : 'este producto'}”? Esta acción no se puede deshacer.`;
  openModal('#confirm-modal');
}

async function confirmDelete() {
  if (!deleteId) return;
  const btn = $('#confirm-delete');
  btn.disabled = true;
  btn.textContent = 'Eliminando…';
  try {
    await api('/api/admin/products/' + deleteId, { method: 'DELETE' });
    closeModal('#confirm-modal');
    showToast('Producto eliminado.');
    await loadProducts();
    switchView('products');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Eliminar';
    deleteId = null;
  }
}

/* ------------------------------------------------------------------ */
/* Descuentos                                                         */
/* ------------------------------------------------------------------ */

function renderDiscounts() {
  const list = $('#discounts-list');
  const empty = $('#discounts-empty');
  empty.hidden = products.length > 0;

  list.innerHTML = products
    .map((p) => {
      const thumb = p.image || '/placeholder?name=' + encodeURIComponent(p.name);
      const info = computeDiscount(p);
      return `
      <div class="discount-card" data-id="${p.id}" data-price="${p.price}">
        <div class="discount-product">
          <img src="${esc(thumb)}" alt="" loading="lazy"
               onerror="this.onerror=null;this.src='/placeholder?name=' + encodeURIComponent('${esc(p.name)}')">
          <div>
            <div class="cell-name">${esc(p.name)}</div>
            <div class="discount-base">Precio normal: ${money(p.price)}</div>
          </div>
        </div>
        <div class="discount-grid">
          <div class="field">
            <label>Tipo</label>
            <select data-dtype>
              <option value="none"${p.discount_type === 'none' ? ' selected' : ''}>Sin descuento</option>
              <option value="percent"${p.discount_type === 'percent' ? ' selected' : ''}>Porcentaje (%)</option>
              <option value="fixed"${p.discount_type === 'fixed' ? ' selected' : ''}>Valor fijo (COP)</option>
            </select>
          </div>
          <div class="field">
            <label>Valor</label>
            <input type="text" inputmode="numeric" data-dvalue value="${esc(p.discount_value || 0)}">
          </div>
          <div class="field">
            <label>Inicio</label>
            <input type="date" data-dstart value="${esc(p.discount_start || '')}">
          </div>
          <div class="field">
            <label>Fin</label>
            <input type="date" data-dend value="${esc(p.discount_end || '')}">
          </div>
          <label class="switch">
            <input type="checkbox" data-dactive ${Number(p.discount_active) === 1 ? 'checked' : ''}>
            <span>Activo</span>
          </label>
        </div>
        <div class="discount-footer">
          <p class="discount-preview" data-preview>
            Precio final: <strong>${money(info.final)}</strong>
            ${info.applied ? ` · <span class="discount-status on">Activo ${info.label}</span>` : ''}
          </p>
          <button class="btn btn-gold btn-small" data-save-discount>Guardar</button>
        </div>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.discount-card').forEach((card) => {
    const inputs = card.querySelectorAll('[data-dtype],[data-dvalue],[data-dstart],[data-dend],[data-dactive]');
    const refresh = () => {
      const data = {
        price: Number(card.dataset.price) || 0,
        discount_type: card.querySelector('[data-dtype]').value,
        discount_value: copInt(card.querySelector('[data-dvalue]').value) || 0,
        discount_active: card.querySelector('[data-dactive]').checked,
        discount_start: card.querySelector('[data-dstart]').value,
        discount_end: card.querySelector('[data-dend]').value
      };
      const info = computeDiscount(data);
      card.querySelector('[data-preview]').innerHTML =
        `Precio final: <strong>${money(info.final)}</strong>` +
        (info.applied && info.final !== data.price
          ? ` <span class="price-old">${money(data.price)}</span>`
          : '') +
        ` · <span class="discount-status ${info.applied ? 'on' : 'off'}">${info.applied ? 'Activo ' + info.label : 'Inactivo'}</span>`;
    };
    inputs.forEach((el) => el.addEventListener('input', refresh));
    inputs.forEach((el) => el.addEventListener('change', refresh));

    card.querySelector('[data-save-discount]').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Guardando…';
      try {
        await api('/api/admin/products/' + card.dataset.id, {
          method: 'PUT',
          body: {
            discount_type: card.querySelector('[data-dtype]').value,
            discount_value: copInt(card.querySelector('[data-dvalue]').value) || 0,
            discount_active: card.querySelector('[data-dactive]').checked,
            discount_start: card.querySelector('[data-dstart]').value,
            discount_end: card.querySelector('[data-dend]').value
          }
        });
        showToast('Descuento guardado.');
        await loadProducts();
        renderDiscounts();
      } catch (error) {
        showToast(error.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Guardar';
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Categorías                                                         */
/* ------------------------------------------------------------------ */

function renderCategoryManager() {
  const list = $('#category-list');
  const empty = $('#categories-empty');
  if (!list) return;
  empty.hidden = categories.length > 0;

  list.innerHTML = categories
    .map(
      (c) => `
    <div class="category-row" data-slug="${esc(c.slug)}">
      <div class="category-row-main">
        <input type="text" class="category-rename" value="${esc(c.name)}" maxlength="60"
               aria-label="Nombre de la categoría">
        <span class="pill pill-gold">${c.product_count} ${c.product_count === 1 ? 'producto' : 'productos'}</span>
      </div>
      <div class="category-row-actions">
        <button type="button" class="btn btn-gold btn-small cat-save">Guardar</button>
        <button type="button" class="icon-action danger cat-delete" title="Eliminar categoría" aria-label="Eliminar categoría">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
        </button>
      </div>
    </div>`
    )
    .join('');

  list.querySelectorAll('.category-row').forEach((row) => {
    const slug = row.dataset.slug;
    row.querySelector('.cat-save').addEventListener('click', async () => {
      const btn = row.querySelector('.cat-save');
      const name = row.querySelector('.category-rename').value.trim();
      if (name.length < 2) {
        showToast('El nombre debe tener al menos 2 caracteres.', true);
        return;
      }
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await api('/api/admin/categories/' + encodeURIComponent(slug), { method: 'PUT', body: { name } });
        showToast('Categoría actualizada.');
        await loadCategories();
        renderCategoryManager();
      } catch (error) {
        showToast(error.message, true);
        btn.disabled = false;
        btn.textContent = 'Guardar';
      }
    });

    row.querySelector('.cat-delete').addEventListener('click', async () => {
      const btn = row.querySelector('.cat-delete');
      btn.disabled = true;
      try {
        await api('/api/admin/categories/' + encodeURIComponent(slug), { method: 'DELETE' });
        showToast('Categoría eliminada.');
        await loadCategories();
        renderCategoryManager();
      } catch (error) {
        btn.disabled = false;
        showToast(error.message, true);
      }
    });
  });
}

async function createCategory() {
  const input = $('#cat-name');
  const name = input.value.trim();
  if (name.length < 2) {
    showToast('El nombre debe tener al menos 2 caracteres.', true);
    return;
  }
  const btn = $('#cat-create');
  btn.disabled = true;
  btn.textContent = 'Creando…';
  try {
    await api('/api/admin/categories', { method: 'POST', body: { name } });
    input.value = '';
    showToast('Categoría creada.');
    await loadCategories();
    renderCategoryManager();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crear categoría';
  }
}

/* ------------------------------------------------------------------ */
/* Respaldo y restauración                                            */
/* ------------------------------------------------------------------ */

let pendingRestore = null;
let restoreTimer = null;

async function downloadBackup() {
  const btn = $('#backup-download');
  btn.disabled = true;
  btn.textContent = 'Generando…';
  try {
    const data = await api('/api/admin/backup');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zhendor-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('Respaldo descargado. Guárdalo en un lugar seguro.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Descargar respaldo (.json)';
  }
}

function handleBackupFile(file) {
  if (!file) return;
  const confirmBtn = $('#backup-restore-confirm');
  confirmBtn.hidden = true;
  if (file.size > 60 * 1024 * 1024) {
    showToast('El archivo de respaldo es demasiado grande.', true);
    return;
  }
  file
    .text()
    .then((text) => {
      JSON.parse(text); // valida que sea JSON antes de mostrar el botón
      pendingRestore = text;
      confirmBtn.textContent = `¿Restaurar «${file.name}»?`;
      confirmBtn.hidden = false;
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        pendingRestore = null;
        confirmBtn.hidden = true;
      }, 8000);
    })
    .catch(() => showToast('El archivo no es un respaldo válido (.json).', true));
}

async function confirmRestore() {
  if (!pendingRestore) return;
  const btn = $('#backup-restore-confirm');
  btn.disabled = true;
  btn.textContent = 'Restaurando…';
  try {
    await api('/api/admin/restore', { method: 'POST', body: JSON.parse(pendingRestore) });
    pendingRestore = null;
    btn.hidden = true;
    showToast('Respaldo restaurado. La tienda volvió a su estado guardado.');
    const settingsWasLoaded = currentSettings !== null;
    await Promise.all([
      loadProducts(),
      loadCategories(),
      settingsWasLoaded ? loadSettings() : Promise.resolve()
    ]);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '¿Restaurar ahora?';
  }
}

/* ------------------------------------------------------------------ */
/* Configuración                                                      */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  try {
    const data = await api('/api/admin/settings');
    currentSettings = data.settings;
    fillSettingsForm(currentSettings);
  } catch (error) {
    showToast(error.message, true);
  }
}

function fillSettingsForm(s) {
  $('#s-brand_name').value = s.brand_name || '';
  $('#s-tagline').value = s.tagline || '';
  $('#s-slogan').value = s.slogan || '';
  $('#s-whatsapp').value = s.whatsapp || '';
  $('#s-shipping_cost').value = s.shipping_cost || '';
  $('#s-contact_phone').value = s.contact_phone || '';
  $('#s-contact_email').value = s.contact_email || '';
  $('#s-address').value = s.address || '';
  $('#s-hero_phrase').value = s.hero_phrase || '';
  $('#s-description').value = s.description || '';
  $('#s-footer_text').value = s.footer_text || '';
  pendingLogo = null;
  renderLogoPreview(s.logo || '');
}

function renderLogoPreview(src) {
  const box = $('#logo-preview');
  if (src) {
    box.innerHTML = `<img src="${esc(src)}" alt="Logotipo">`;
  } else {
    box.innerHTML = '<span class="logo-placeholder">ZHEND’OR</span>';
  }
}

async function handleLogoFile(file) {
  try {
    pendingLogo = await readImageFile(file, 900, 0.9);
    renderLogoPreview(pendingLogo);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const errorEl = $('#settings-error');
  errorEl.hidden = true;

  const payload = {
    brand_name: $('#s-brand_name').value.trim(),
    tagline: $('#s-tagline').value.trim(),
    slogan: $('#s-slogan').value.trim(),
    whatsapp: $('#s-whatsapp').value.trim(),
    shipping_cost: $('#s-shipping_cost').value.trim(),
    contact_phone: $('#s-contact_phone').value.trim(),
    contact_email: $('#s-contact_email').value.trim(),
    address: $('#s-address').value.trim(),
    hero_phrase: $('#s-hero_phrase').value.trim(),
    description: $('#s-description').value.trim(),
    footer_text: $('#s-footer_text').value.trim()
  };
  if (pendingLogo !== null) payload.logo = pendingLogo;

  const btn = $('#settings-save');
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  try {
    const data = await api('/api/admin/settings', { method: 'PUT', body: payload });
    currentSettings = data.settings;
    pendingLogo = null;
    fillSettingsForm(currentSettings);
    showToast('Configuración guardada.');
  } catch (error) {
    showFormError(errorEl, error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar cambios';
  }
}

/* ------------------------------------------------------------------ */
/* Eventos e inicio                                                   */
/* ------------------------------------------------------------------ */

function initEvents() {
  $('#logout-btn').addEventListener('click', logout);
  $('#logout-btn-2').addEventListener('click', logout);

  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => switchView(tab.dataset.view))
  );
  $$('.dash-action').forEach((btn) =>
    btn.addEventListener('click', () => switchView(btn.dataset.view))
  );

  $('#new-product-btn').addEventListener('click', () => openEditor(null));
  $('#dash-new-btn').addEventListener('click', () => openEditor(null));
  $('#editor-back').addEventListener('click', () => switchView('products'));
  $('#product-cancel').addEventListener('click', () => switchView('products'));

  $('#product-form').addEventListener('submit', saveProduct);
  $('#confirm-delete').addEventListener('click', confirmDelete);
  $('#settings-form').addEventListener('submit', saveSettings);

  $('#variant-group-add').addEventListener('click', () => {
    editorVariants.push({ _gid: nextVariantId(), name: '', required: false, single: false, mode: 'opciones', options: [] });
    renderVariantsEditor(editorVariants);
  });

  $('#p-category').addEventListener('change', ensureRingSizeGroup);

  $('#cat-create').addEventListener('click', createCategory);
  $('#cat-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createCategory();
    }
  });

  $('#backup-download').addEventListener('click', downloadBackup);
  $('#backup-restore-pick').addEventListener('click', () => $('#backup-file').click());
  $('#backup-file').addEventListener('change', (e) => {
    if (e.target.files[0]) handleBackupFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#backup-restore-confirm').addEventListener('click', confirmRestore);

  ['#p-discount_type', '#p-discount_value', '#p-discount_start', '#p-discount_end', '#p-discount_active', '#p-price']
    .forEach((sel) => {
      $(sel).addEventListener('input', () => updateDiscountPreview());
      $(sel).addEventListener('change', () => updateDiscountPreview());
    });

  $$('[data-close]').forEach((el) =>
    el.addEventListener('click', () => closeModal('#confirm-modal'))
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal('#confirm-modal');
  });

  // Imagen de producto
  const drop = $('#image-drop');
  const imageInput = $('#p-image');
  drop.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleProductImage(e.target.files[0]);
    e.target.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleProductImage(e.dataTransfer.files[0]);
  });
  $('#p-image-remove').addEventListener('click', () => {
    pendingImage = null;
    updateImagePreview('');
  });

  // Logotipo
  const logoFile = $('#logo-file');
  $('#logo-pick').addEventListener('click', () => logoFile.click());
  logoFile.addEventListener('change', (e) => {
    if (e.target.files[0]) handleLogoFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#logo-remove').addEventListener('click', () => {
    pendingLogo = '';
    renderLogoPreview('');
  });
}

async function init() {
  try {
    await api('/api/admin/me');
  } catch {
    return; // api() ya redirige a /login si no hay sesión
  }
  initEvents();
  await Promise.all([loadProducts(), loadCategories()]);
  await loadColorPalette();
  switchView('dashboard');
}

document.addEventListener('DOMContentLoaded', init);
