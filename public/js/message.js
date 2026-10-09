/**
 * ZHEND'OR Joyería — utilidades compartidas de formato y mensaje de WhatsApp.
 * Se usa tanto en el navegador (window.ZhendorMessage) como en las pruebas (Node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ZhendorMessage = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function money(value) {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0
    }).format(Number(value) || 0);
  }

  function parseShipping(settings) {
    const raw = settings && settings.shipping_cost;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function buildMessage(settings, product, qty, data, quote) {
    settings = settings || {};
    product = product || {};
    data = data || {};
    qty = Math.max(1, Number.parseInt(qty, 10) || 1);

    const brand = settings.brand_name || 'ZHEND’OR';

    // Si el servidor entrega una cotización, esa es la fuente de verdad.
    const unitPrice = quote
      ? Number(quote.unit_price) || 0
      : Number(product.final_price ?? product.price) || 0;
    const subtotal = quote ? Number(quote.subtotal) || 0 : unitPrice * qty;
    const discountTotal = quote
      ? Number(quote.discount_amount) || 0
      : (Number(product.price) - unitPrice) * qty;
    const shipping = quote ? quote.shipping : parseShipping(settings);

    const lines = [
      `Hola ${brand}, quiero hacer este pedido:`,
      '',
      `• Producto: ${product.name || ''}`,
      `• Cantidad: ${qty}`,
      `• Precio unitario: ${money(unitPrice)}`
    ];
    if (discountTotal > 0) {
      lines.push(`• Descuento aplicado: -${money(discountTotal)}`);
    }
    lines.push(
      `• Subtotal: ${money(subtotal)}`,
      `• Envío: ${shipping === null || shipping === undefined ? 'Por confirmar' : money(shipping)}`,
      `• Total: ${
        shipping === null || shipping === undefined
          ? money(subtotal) + ' + envío por confirmar'
          : money(subtotal + shipping)
      }`,
      '',
      'Mis datos:',
      `• Nombre: ${data.name || ''}`,
      `• Teléfono: ${data.phone || ''}`,
      `• Ciudad: ${data.city || ''}`,
      `• Dirección: ${data.address || ''}`
    );
    if (data.notes) lines.push(`• Observaciones: ${data.notes}`);
    return lines.join('\n');
  }

  function normalizePhone(phone) {
    return String(phone || '').replace(/[^\d]/g, '');
  }

  function whatsappUrl(phone, message) {
    const digits = normalizePhone(phone);
    return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  }

  return { money, parseShipping, buildMessage, normalizePhone, whatsappUrl };
});
