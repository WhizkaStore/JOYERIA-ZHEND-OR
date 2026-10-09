'use strict';

/**
 * ZHEND'OR Joyería — cálculo de descuentos y cotizaciones.
 * Toda la lógica de precios vive aquí para que el backend sea la única
 * fuente de verdad (el navegador nunca decide el precio final).
 */

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(toInt(value));
}

function parseDate(value, endOfDay) {
  if (value === undefined || value === null || value === '') return NaN;
  const s = String(value).trim();
  if (s.length === 10) {
    return Date.parse(s + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'));
  }
  return Date.parse(s);
}

// ¿El descuento configurado está vigente en este momento?
function isDiscountApplied(product, now = Date.now()) {
  if (!product || !Number(product.discount_active)) return false;
  const type = product.discount_type;
  if (type !== 'percent' && type !== 'fixed') return false;
  if (toInt(product.discount_value) <= 0) return false;

  const start = parseDate(product.discount_start, false);
  const end = parseDate(product.discount_end, true);
  if (!Number.isNaN(start) && now < start) return false;
  if (!Number.isNaN(end) && now > end) return false;
  return true;
}

// Importe del descuento en pesos, nunca mayor que el precio ni negativo.
function discountAmount(price, type, value) {
  const base = toInt(price);
  if (type === 'percent') {
    const pct = Math.min(100, Math.max(0, toInt(value)));
    return Math.round((base * pct) / 100);
  }
  if (type === 'fixed') {
    return Math.min(base, Math.max(0, toInt(value)));
  }
  return 0;
}

function finalPrice(product, now = Date.now()) {
  const price = toInt(product && product.price);
  if (!isDiscountApplied(product, now)) return price;
  return Math.max(0, price - discountAmount(price, product.discount_type, product.discount_value));
}

function discountLabel(product, now = Date.now()) {
  if (!isDiscountApplied(product, now)) return '';
  if (product.discount_type === 'percent') return `-${toInt(product.discount_value)}%`;
  const amount = discountAmount(toInt(product.price), 'fixed', toInt(product.discount_value));
  return `-${money(amount)}`;
}

// Forma pública de un producto (sin campos internos como published).
function serializeProduct(row, now = Date.now()) {
  if (!row) return null;
  const price = toInt(row.price);
  const applied = isDiscountApplied(row, now);
  const final = applied
    ? Math.max(0, price - discountAmount(price, row.discount_type, row.discount_value))
    : price;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    price,
    final_price: final,
    weight: row.weight || '',
    status: row.status,
    image: row.image || '',
    has_discount: applied,
    discount_label: applied ? discountLabel(row, now) : '',
    discount_amount: applied ? price - final : 0
  };
}

// Cotización de un pedido calculada en el servidor.
function computeQuote(product, quantity, shippingCost) {
  const qty = Math.min(99, Math.max(1, toInt(quantity) || 1));
  const unitOriginal = toInt(product.price);
  const unitFinal = finalPrice(product);
  const applied = isDiscountApplied(product);
  const shipping =
    shippingCost === null || shippingCost === undefined || String(shippingCost).trim() === ''
      ? null
      : Math.max(0, toInt(shippingCost));

  const subtotal = unitFinal * qty;
  const discountTotal = (unitOriginal - unitFinal) * qty;

  return {
    product_id: product.id,
    name: product.name,
    quantity: qty,
    unit_price: unitFinal,
    unit_original: unitOriginal,
    discount_applied: applied,
    discount_type: applied ? product.discount_type : 'none',
    discount_value: applied ? toInt(product.discount_value) : 0,
    discount_label: applied ? discountLabel(product) : '',
    discount_amount: discountTotal,
    subtotal,
    shipping,
    total: shipping === null ? null : subtotal + shipping
  };
}

module.exports = {
  toInt,
  money,
  isDiscountApplied,
  discountAmount,
  finalPrice,
  discountLabel,
  serializeProduct,
  computeQuote
};
