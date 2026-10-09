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
let currentSettings = null;
let pendingImage = null;
let pendingLogo = null;
let deleteId = null;

async function loadProducts() {
  try {
    const data = await api('/api/admin/products');
    products = data.products;
    renderProducts();
    renderDashboard();
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
        <td><div class="cell-name">${esc(p.name)}</div></td>
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
    $('#p-status').value = p.status;
    $('#p-published').value = String(Number(p.published));
    $('#p-discount_type').value = p.discount_type || 'none';
    $('#p-discount_value').value = p.discount_value || 0;
    $('#p-discount_active').checked = Number(p.discount_active) === 1;
    $('#p-discount_start').value = p.discount_start || '';
    $('#p-discount_end').value = p.discount_end || '';
    updateImagePreview(p.image || '');
  } else {
    $('#editor-title').textContent = 'Agregar producto';
    $('#editor-sub').textContent = 'Registra una nueva pieza para el catálogo.';
    $('#p-id').value = '';
    $('#p-status').value = 'available';
    $('#p-published').value = '1';
    $('#p-discount_type').value = 'none';
    $('#p-discount_value').value = 0;
    $('#p-discount_active').checked = false;
    $('#p-discount_start').value = '';
    $('#p-discount_end').value = '';
  }

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
    status: $('#p-status').value,
    published: $('#p-published').value === '1',
    discount_type: type,
    discount_value: value,
    discount_active: $('#p-discount_active').checked,
    discount_start: start,
    discount_end: end
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
  await loadProducts();
  switchView('dashboard');
}

document.addEventListener('DOMContentLoaded', init);
