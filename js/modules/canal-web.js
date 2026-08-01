/**
 * canal-web.js — la pantalla "Catálogo online" del tab Pedidos.
 *
 * Vive en su propio archivo porque `pedidos.js` ya pasa las dos mil líneas y
 * esto es otra cosa: es lo único del SO que escribe en la nube. Se monta como
 * una subvista más de Pedidos, y solo para administración.
 *
 * Publicar un producto copia nombre, precio, categoría y unidad, y guarda
 * `producto_id` para poder mapear el ítem cuando entre un pedido del buzón.
 * El costo nunca sale de acá: el catálogo es público (regla 8).
 */

import { state } from '../state.js';
import { auth } from '../auth.js';
import { ui } from '../ui.js';
import * as nube from '../nube.js';
import { svg as qrSvg } from '../qr.js';

/** Se recuerda entre renders: publicar algo no te devuelve al principio. */
let publicados = null;

const porProductoId = () =>
  new Map((publicados || []).filter((i) => i.producto_id).map((i) => [i.producto_id, i]));

/* ------------------------------------------------------------------ */
/*  Pantalla                                                           */
/* ------------------------------------------------------------------ */

export async function pantalla(cont) {
  const est = await nube.estado();

  if (!est.conectado) {
    cont.innerHTML = pantallaDesconectado(est);
    cont.querySelector('#conectar')?.addEventListener('click', () => modalConectar(cont));
    return;
  }

  cont.innerHTML = '<p class="faint">Trayendo el catálogo…</p>';

  try {
    publicados = await nube.listarCatalogo();
  } catch (e) {
    cont.innerHTML = `
      <div class="card">
        <h3>No pudimos leer el catálogo</h3>
        <p class="faint">${ui.esc(e.message)}</p>
        <button class="btn btn--block" id="reintentar" style="margin-top:var(--sp-3)">Reintentar</button>
      </div>`;
    cont.querySelector('#reintentar').addEventListener('click', () => pantalla(cont));
    return;
  }

  const enlace = nube.enlacePublico();
  const mapa = porProductoId();
  const activos = publicados.filter((i) => i.activo).length;

  cont.innerHTML = `
    ${bloqueEnlace(enlace, activos)}

    <div class="between" style="margin:var(--sp-5) 0 var(--sp-3)">
      <h2 style="margin:0;font-size:1rem">Qué se publica</h2>
      <button class="btn btn--ghost" id="sincronizar">Sincronizar precios</button>
    </div>

    <div class="lista">
      ${state.productos.filter((p) => p.activo).map((p) => filaProducto(p, mapa.get(p.id))).join('')}
    </div>

    ${bloqueHuerfanos(publicados)}

    <p class="faint" style="margin-top:var(--sp-5)">
      Conectado como ${ui.esc(est.email)} ·
      <button class="btn btn--ghost" id="desconectar" style="padding:0 var(--sp-2)">Desconectar</button>
    </p>`;

  cablear(cont, enlace);
}

function pantallaDesconectado(est) {
  return `
    ${ui.vacio({
      modulo: 'pedidos', icono: '\u{1F517}', titulo: 'El catálogo online no está conectado',
      texto: est.configurado
        ? 'La sesión se cerró o venció. Volvé a entrar con el usuario del canal web.'
        : 'Falta conectar el proyecto de Supabase donde viven el catálogo y el buzón de pedidos.',
    })}
    <button class="btn btn--primary btn--block" id="conectar">Conectar</button>`;
}

/** El link, para copiar, mandar y colgar en la pared. */
function bloqueEnlace(enlace, activos) {
  return `
    <div class="card" data-accent="pedidos">
      <div class="faint">El link que se comparte</div>
      <div class="num" style="word-break:break-all;margin:var(--sp-2) 0">${ui.esc(enlace)}</div>
      <div class="row">
        <button class="btn grow" id="copiar">Copiar</button>
        <button class="btn grow" id="compartir">Mandar por WhatsApp</button>
      </div>
      <div class="row" style="margin-top:var(--sp-2)">
        <button class="btn btn--ghost grow" id="ver-qr">Ver el QR para imprimir</button>
      </div>
      <p class="faint" style="margin:var(--sp-3) 0 0">
        ${activos} ${activos === 1 ? 'producto publicado' : 'productos publicados'}
      </p>
    </div>`;
}

function filaProducto(producto, item) {
  const publicado = Boolean(item?.activo);
  const desfasado = item && Number(item.precio) !== Number(producto.precio_venta);

  return `
    <div class="between card" data-producto="${producto.id}">
      <div style="min-width:0">
        <div>${ui.esc(producto.nombre)}</div>
        <div class="faint">
          ${ui.money(producto.precio_venta)}
          ${desfasado ? ` · <span class="danger">en la web dice ${ui.money(item.precio)}</span>` : ''}
        </div>
      </div>
      <button class="btn ${publicado ? '' : 'btn--primary'}"
              data-toggle="${publicado ? 'baja' : 'alta'}"
              data-item="${item?.id || ''}">
        ${publicado ? 'Publicado' : 'Publicar'}
      </button>
    </div>`;
}

/**
 * Ítems publicados que ya no corresponden a ningún producto del SO. Aparecen
 * si alguien cargó el catálogo a mano o si se borró el producto: conviene
 * verlos, porque siguen a la venta.
 */
function bloqueHuerfanos(items) {
  const idsSO = new Set(state.productos.map((p) => p.id));
  const sueltos = items.filter((i) => i.activo && (!i.producto_id || !idsSO.has(i.producto_id)));
  if (!sueltos.length) return '';

  return `
    <div class="card" style="margin-top:var(--sp-4)">
      <h3 style="font-size:.95rem">Publicados sin producto en el SO</h3>
      <p class="faint">Se venden igual, pero al importar el pedido hay que elegir a mano a qué producto corresponden.</p>
      <div class="lista" style="margin-top:var(--sp-3)">
        ${sueltos.map((i) => `
          <div class="between">
            <span>${ui.esc(i.nombre)} <span class="faint">${ui.money(i.precio)}</span></span>
            <button class="btn btn--danger" data-toggle="baja" data-item="${i.id}">Bajar</button>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/*  Acciones                                                           */
/* ------------------------------------------------------------------ */

function cablear(cont, enlace) {
  cont.querySelector('#copiar').addEventListener('click', () => copiar(enlace));

  cont.querySelector('#compartir').addEventListener('click', () => {
    const texto = `Hola! Te paso el link para hacer el pedido a Manos Libres: ${enlace}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
  });

  cont.querySelector('#ver-qr').addEventListener('click', () => modalQR(enlace));
  cont.querySelector('#sincronizar').addEventListener('click', (e) => sincronizar(e.target, cont));
  cont.querySelector('#desconectar').addEventListener('click', async () => {
    if (!(await ui.confirmar('¿Desconectar el catálogo online?', 'Desconectar'))) return;
    await nube.desconectar();
    publicados = null;
    pantalla(cont);
  });

  cont.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    await alternar(btn, cont);
  });
}

async function alternar(btn, cont) {
  const alta = btn.dataset.toggle === 'alta';
  const productoId = btn.closest('[data-producto]')?.dataset.producto;

  btn.disabled = true;
  btn.textContent = alta ? 'Publicando…' : 'Bajando…';

  try {
    if (alta) {
      const producto = state.productoPorId(productoId);
      await nube.publicar(producto);
      ui.toast(`${producto.nombre} está en el catálogo`);
    } else {
      await nube.despublicar(btn.dataset.item);
      ui.toast('Sacado del catálogo');
    }
    publicados = null;
    await pantalla(cont);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = alta ? 'Publicar' : 'Publicado';
    ui.toast(err.message, true);
  }
}

async function sincronizar(btn, cont) {
  btn.disabled = true;
  btn.textContent = 'Sincronizando…';

  try {
    const cambios = await nube.sincronizarPrecios(state.productos);

    if (!cambios.length) {
      ui.toast('Los precios de la web ya estaban al día');
      btn.disabled = false;
      btn.textContent = 'Sincronizar precios';
      return;
    }

    // Cambiar precios de cara al público no es una operación silenciosa:
    // se muestra qué se movió y cuánto.
    ui.abrirModal(`
      <h3>Precios actualizados</h3>
      <div class="lista" style="margin-top:var(--sp-3)">
        ${cambios.map((c) => `
          <div class="between">
            <span>${ui.esc(c.item.nombre)}</span>
            <span class="num">${ui.money(c.precioAnterior)} → <b>${ui.money(c.precioNuevo)}</b></span>
          </div>`).join('')}
      </div>
      <button class="btn btn--primary btn--block" data-close style="margin-top:var(--sp-4)">Listo</button>
    `, null, () => { publicados = null; pantalla(cont); });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Sincronizar precios';
    ui.toast(err.message, true);
  }
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    ui.toast('Link copiado');
  } catch {
    // En un WebView sin permiso de portapapeles no hay copia posible: se
    // muestra el link seleccionable para que se copie a mano.
    ui.abrirModal(`
      <h3>Copiá el link</h3>
      <input class="input" value="${ui.esc(texto)}" readonly style="margin-top:var(--sp-3)">
      <button class="btn btn--block" data-close style="margin-top:var(--sp-3)">Cerrar</button>
    `, (root) => root.querySelector('input').select());
  }
}

function modalQR(enlace) {
  ui.abrirModal(`
    <h3>QR del catálogo</h3>
    <p class="faint">Para imprimir y pegar en el CIC.</p>
    <div id="qr" style="background:#fff;border-radius:var(--r-sm);padding:var(--sp-3);margin:var(--sp-3) 0">
      ${qrSvg(enlace)}
    </div>
    <p class="faint">Probalo con la cámara del celular antes de mandarlo a imprimir.</p>
    <div class="row" style="margin-top:var(--sp-3)">
      <button class="btn grow" id="imprimir">Imprimir</button>
      <button class="btn grow" data-close>Cerrar</button>
    </div>
  `, (root) => {
    root.querySelector('#imprimir').addEventListener('click', () => imprimirQR(enlace));
  });
}

/**
 * El QR se imprime desde una ventana aparte: mandar a imprimir la app entera
 * saca la nav, los modales y el fondo negro en una hoja A4.
 */
function imprimirQR(enlace) {
  const w = window.open('', '_blank');
  if (!w) { ui.toast('El navegador bloqueó la ventana de impresión', true); return; }

  w.document.write(`
    <!doctype html><html lang="es"><head><meta charset="utf-8">
    <title>QR — Manos Libres</title>
    <style>
      body { font-family: system-ui, sans-serif; text-align: center; padding: 40px 20px; }
      h1 { font-size: 28px; margin: 0 0 4px; }
      p { color: #444; margin: 0 0 24px; }
      svg { width: 320px; height: 320px; }
      .link { margin-top: 16px; font-size: 14px; color: #666; word-break: break-all; }
    </style></head><body>
      <h1>Manos Libres</h1>
      <p>Escaneá y hacé tu pedido</p>
      ${qrSvg(enlace)}
      <div class="link">${ui.esc(enlace)}</div>
    </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

/* ------------------------------------------------------------------ */
/*  Conexión                                                           */
/* ------------------------------------------------------------------ */

function modalConectar(cont) {
  ui.abrirModal(`
    <h3>Conectar el catálogo online</h3>
    <p class="faint">Los datos del proyecto de Supabase donde viven el catálogo y el buzón.</p>
    <div class="stack" style="margin-top:var(--sp-4)">
      <div class="field">
        <label for="c-url">URL del proyecto</label>
        <input class="input" id="c-url" placeholder="https://xxxx.supabase.co" inputmode="url">
      </div>
      <div class="field">
        <label for="c-key">Publishable key</label>
        <input class="input" id="c-key" placeholder="sb_publishable_…">
      </div>
      <div class="field">
        <label for="c-email">Usuario</label>
        <input class="input" id="c-email" type="email" autocomplete="username">
      </div>
      <div class="field">
        <label for="c-pass">Contraseña</label>
        <input class="input" id="c-pass" type="password" autocomplete="current-password">
        <span class="faint">No se guarda: se usa una vez para abrir la sesión.</span>
      </div>
      <p class="faint" id="c-error" style="color:var(--danger)"></p>
      <button class="btn btn--primary btn--block" id="c-ok">Conectar</button>
    </div>
  `, (root) => {
    const btn = root.querySelector('#c-ok');
    btn.addEventListener('click', async () => {
      const error = root.querySelector('#c-error');
      error.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Conectando…';
      ui.bloquearModal(true);

      try {
        await nube.conectar({
          url: root.querySelector('#c-url').value.trim(),
          anonKey: root.querySelector('#c-key').value.trim(),
          email: root.querySelector('#c-email').value.trim(),
          password: root.querySelector('#c-pass').value,
        });
        ui.bloquearModal(false);
        ui.cerrarModal();
        publicados = null;
        ui.toast('Catálogo online conectado');
        pantalla(cont);
      } catch (err) {
        ui.bloquearModal(false);
        error.textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Conectar';
      }
    });
  });
}
