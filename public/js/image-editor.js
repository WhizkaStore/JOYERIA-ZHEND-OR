'use strict';

/* ==========================================================================
   ZHEND'OR Joyería — editor de imagen del catálogo.
   Vanilla (Canvas + CanvasRenderingContext2D), sin dependencias externas.

   Expone:  ZhendorImageEditor.editImage(file) -> Promise<string | null>
   Devuelve un dataURL JPEG ya recortado/ajustado, o null si se cancela.
   ========================================================================== */

(function (global) {
  'use strict';

  const ASPECT = 4 / 5; // marco de recorte (retrato, igual al de las tarjetas)
  const OUT_W = 800;
  const OUT_H = Math.round(OUT_W / ASPECT); // 1000
  const MAX_FILE = 8 * 1024 * 1024;

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const toRad = (deg) => (deg * Math.PI) / 180;
  const $ = (root, sel) => root.querySelector(sel);

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        return reject(new Error('El archivo debe ser una imagen.'));
      }
      if (file.size > MAX_FILE) {
        return reject(new Error('La imagen no puede superar los 8 MB.'));
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        if (!img.naturalWidth || !img.naturalHeight) {
          return reject(new Error('La imagen no es válida.'));
        }
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo leer la imagen.'));
      };
      img.src = url;
    });
  }

  function buildModal() {
    const overlay = document.createElement('div');
    overlay.className = 'ie-overlay';
    overlay.innerHTML = `
      <div class="ie-card" role="dialog" aria-modal="true" aria-label="Editar imagen">
        <div class="ie-head">
          <h3 class="ie-title">Editar imagen</h3>
          <button type="button" class="ie-close" data-ie="cancel" aria-label="Cerrar">×</button>
        </div>
        <div class="ie-stage">
          <canvas class="ie-canvas" width="${OUT_W}" height="${OUT_H}"></canvas>
          <div class="ie-grid" aria-hidden="true"></div>
        </div>
        <div class="ie-tools">
          <div class="ie-row">
            <button type="button" class="btn btn-ghost btn-small" data-ie="rotL">↺ Girar</button>
            <button type="button" class="btn btn-ghost btn-small" data-ie="rotR">Girar ↻</button>
            <button type="button" class="btn btn-ghost btn-small" data-ie="flipH">⟷</button>
            <button type="button" class="btn btn-ghost btn-small" data-ie="flipV">↕</button>
            <button type="button" class="btn btn-ghost btn-small" data-ie="reset">Reiniciar</button>
          </div>
          <label class="ie-slider">
            <span>Zoom</span>
            <input type="range" data-ie="zoom" min="1" max="4" step="0.05" value="1">
            <span class="ie-zoom-value" data-ie="zoomValue">100%</span>
          </label>
          <div class="ie-row ie-adjust-row">
            <label class="ie-slider"><span>Brillo</span><input type="range" data-ie="brightness" min="0.4" max="1.6" step="0.01" value="1"></label>
            <label class="ie-slider"><span>Contraste</span><input type="range" data-ie="contrast" min="0.5" max="1.5" step="0.01" value="1"></label>
            <label class="ie-slider"><span>Saturación</span><input type="range" data-ie="saturation" min="0" max="2" step="0.01" value="1"></label>
          </div>
          <p class="ie-tip">Arrastra para mover · ajusta el zoom con la rueda o el control · la zona visible es el recorte final.</p>
        </div>
        <div class="ie-actions">
          <button type="button" class="btn btn-ghost" data-ie="cancel">Cancelar</button>
          <button type="button" class="btn btn-gold" data-ie="apply">Aplicar imagen</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function editImage(file) {
    return loadImage(file).then(
      (img) =>
        new Promise((resolve) => {
          const overlay = buildModal();
          const canvas = $(overlay, '.ie-canvas');
          const ctx = canvas.getContext('2d');
          const zoomEl = $(overlay, '[data-ie="zoom"]');
          const zoomValue = $(overlay, '[data-ie="zoomValue"]');
          const stage = $(overlay, '.ie-stage');

          const srcW = img.naturalWidth;
          const srcH = img.naturalHeight;
          const cw = canvas.width;
          const ch = canvas.height;

          const state = {
            zoom: 1, panX: 0, panY: 0, rot: 0,
            flipH: false, flipV: false,
            brightness: 1, contrast: 1, saturation: 1
          };

          function close(result) {
            document.body.style.overflow = '';
            overlay.remove();
            resolve(result);
          }

          function clampPan() {
            const swapped = state.rot % 180 !== 0;
            const fit = Math.min(cw / (swapped ? srcH : srcW), ch / (swapped ? srcW : srcH));
            const scale = fit * state.zoom;
            const footW = (swapped ? srcH : srcW) * scale / 2;
            const footH = (swapped ? srcW : srcH) * scale / 2;
            state.panX = clamp(state.panX, -(footW - cw / 2), footW - cw / 2);
            state.panY = clamp(state.panY, -(footH - ch / 2), footH - ch / 2);
          }

          function draw() {
            ctx.clearRect(0, 0, cw, ch);
            ctx.fillStyle = '#FFFCF5';
            ctx.fillRect(0, 0, cw, ch);
            ctx.save();
            if ('filter' in ctx) {
              ctx.filter =
                `brightness(${state.brightness}) contrast(${state.contrast}) saturate(${state.saturation})`;
            }
            ctx.translate(cw / 2 + state.panX, ch / 2 + state.panY);
            ctx.rotate(toRad(state.rot));
            ctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
            const swapped = state.rot % 180 !== 0;
            const fit = Math.min(cw / (swapped ? srcH : srcW), ch / (swapped ? srcW : srcH));
            const scale = fit * state.zoom;
            ctx.drawImage(img, -(srcW * scale) / 2, -(srcH * scale) / 2, srcW * scale, srcH * scale);
            ctx.restore();
          }

          function render() {
            clampPan();
            zoomEl.value = state.zoom;
            zoomValue.textContent = Math.round(state.zoom * 100) + '%';
            draw();
          }

          /* --- Acciones --- */
          overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-ie]');
            if (!btn) {
              if (e.target === overlay) close(null);
              return;
            }
            switch (btn.dataset.ie) {
              case 'rotL': state.rot = (state.rot + 270) % 360; render(); break;
              case 'rotR': state.rot = (state.rot + 90) % 360; render(); break;
              case 'flipH': state.flipH = !state.flipH; render(); break;
              case 'flipV': state.flipV = !state.flipV; render(); break;
              case 'reset':
                state.zoom = 1; state.panX = 0; state.panY = 0; state.rot = 0;
                state.flipH = false; state.flipV = false;
                state.brightness = 1; state.contrast = 1; state.saturation = 1;
                $(overlay, '[data-ie="brightness"]').value = 1;
                $(overlay, '[data-ie="contrast"]').value = 1;
                $(overlay, '[data-ie="saturation"]').value = 1;
                render(); break;
              case 'cancel': close(null); break;
              case 'apply':
                close(canvas.toDataURL('image/jpeg', 0.85));
                break;
            }
          });

          document.addEventListener('keydown', onKey);
          function onKey(e) {
            if (e.key === 'Escape') {
              document.removeEventListener('keydown', onKey);
              close(null);
            }
          }

          /* --- Controles --- */
          zoomEl.addEventListener('input', () => {
            state.zoom = Number.parseFloat(zoomEl.value) || 1;
            render();
          });
          for (const name of ['brightness', 'contrast', 'saturation']) {
            $(overlay, '[data-ie="' + name + '"]').addEventListener('input', (e) => {
              state[name] = Number.parseFloat(e.target.value) || 1;
              draw();
            });
          }

          const minZoom = 1;
          canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            state.zoom = clamp(state.zoom + (e.deltaY < 0 ? 0.1 : -0.1), minZoom, 4);
            render();
          }, { passive: false });

          /* --- Arrastrar para mover (ratón y táctil) --- */
          let dragging = false;
          let lastX = 0;
          let lastY = 0;
          const toCanvas = (deltaCss) => deltaCss * (cw / stage.getBoundingClientRect().width);

          canvas.addEventListener('pointerdown', (e) => {
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            canvas.classList.add('dragging');
            canvas.setPointerCapture(e.pointerId);
          });
          canvas.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            state.panX += toCanvas(e.clientX - lastX);
            state.panY += toCanvas(e.clientY - lastY);
            lastX = e.clientX;
            lastY = e.clientY;
            draw();
          });
          canvas.addEventListener('pointerup', (e) => {
            dragging = false;
            canvas.classList.remove('dragging');
            try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
          });
          canvas.addEventListener('pointercancel', () => {
            dragging = false;
            canvas.classList.remove('dragging');
          });

          document.body.style.overflow = 'hidden';
          render();
        })
    );
  }

  global.ZhendorImageEditor = { editImage };
})(window);