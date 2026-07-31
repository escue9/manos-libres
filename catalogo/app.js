/**
 * Catálogo público de Manos Libres.
 *
 * No comparte código con el SO. Habla con Supabase por REST plano (PostgREST),
 * sin supabase-js: son dos requests, no hay librería que bajar, y la página
 * tiene que abrir en un celular con mala señal.
 *
 * Lo que puede hacer con la anon key, y nada más:
 *   GET  /rest/v1/catalogo_item   → los ítems activos
 *   POST /rest/v1/pedido_web      → dejar un pedido en el buzón
 *
 * El id del pedido lo genera el cliente. Parece raro, pero anon no tiene SELECT
 * sobre pedido_web —si lo tuviera, cualquiera con el link leería los teléfonos
 * y las direcciones de todos— y por eso el insert no puede devolver la fila.
 * Generarlo acá es lo que permite mostrar el número de pedido.
 */

import { CONFIG } from './config.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const fmtMoneda = new Intl.NumberFormat('es-AR', {
  style: 'currency', currency: 'ARS', maximumFractionDigits: 0,
});

const money = (n) => fmtMoneda.format(Number(n) || 0);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const $ = (sel) => document.querySelector(sel);

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** El "número de pedido" que ve el cliente. Corto, legible por teléfono. */
const codigoDe = (id) => id.replace(/-/g, '').slice(0, 6).toUpperCase();

const configurado = () => Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
const hayWhatsApp = () => Boolean(CONFIG.WHATSAPP);

/**
 * 10 dígitos, sin 0 ni 15. Se perdona el 54, el 9, el 0 y el 15 porque la gente
 * copia el número de su agenda y viene de cualquier forma.
 */
function normalizarTelefono(texto) {
  let d = String(texto ?? '').replace(/\D/g, '');
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9') && d.length === 11) d = d.slice(1);
  if (d.startsWith('0')) d = d.slice(1);

  // El 15 no va adelante: va DESPUÉS de la característica, que tiene 2, 3 o 4
  // dígitos según la ciudad — 011 15 5555-5555, 0221 15 555-5555,
  // 02494 15 55-1234. Buscarlo solo al principio dejaba afuera al número que
  // la mayoría tiene guardado en el teléfono.
  if (d.length === 12) {
    for (const i of [2, 3, 4]) {
      if (d.slice(i, i + 2) === '15') { d = d.slice(0, i) + d.slice(i + 2); break; }
    }
  }
  return d;
}

/**
 * Hoy, en hora local. `toISOString()` devuelve UTC y en Argentina eso ya es
 * mañana a partir de las 21:00: el campo de fecha no dejaba elegir hoy justo
 * en el rato en que la gente pide para esta noche.
 */
function hoyISO() {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/* ------------------------------------------------------------------ */
/*  Estado                                                             */
/* ------------------------------------------------------------------ */

/** Los ítems tal como vinieron de catalogo_item. */
let catalogo = [];

/** id de catalogo_item → cantidad. */
const carrito = new Map();

/** 'retira_cic' | 'domicilio' | null */
let modoEntrega = null;

const LIMITE_MS = 60_000;
const CLAVE_LIMITE = 'ml_ultimo_pedido';

/* ------------------------------------------------------------------ */
/*  Supabase por REST                                                  */
/* ------------------------------------------------------------------ */

const cabeceras = () => ({
  apikey: CONFIG.SUPABASE_ANON_KEY,
  Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
});

async function traerCatalogo() {
  const campos = 'id,producto_id,nombre,descripcion,categoria,precio,unidad_venta,foto_url,orden';
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/catalogo_item`
    + `?select=${campos}&activo=eq.true`
    + '&order=categoria.asc,orden.asc,nombre.asc';

  const r = await fetch(url, { headers: cabeceras() });
  if (!r.ok) throw new Error(`catalogo ${r.status}`);
  return r.json();
}

async function depositarPedido(pedido) {
  const r = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/pedido_web`, {
    method: 'POST',
    headers: {
      ...cabeceras(),
      'Content-Type': 'application/json',
      // anon no tiene SELECT sobre la tabla: pedir la fila de vuelta haría
      // fallar el insert entero.
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(pedido),
  });
  if (!r.ok) throw new Error(`pedido_web ${r.status}: ${await r.text()}`);
}

/* ------------------------------------------------------------------ */
/*  Carrito                                                            */
/* ------------------------------------------------------------------ */

const itemPorId = (id) => catalogo.find((i) => i.id === id);

const lineas = () => [...carrito.entries()].map(([id, cantidad]) => {
  const item = itemPorId(id);
  return {
    catalogo_item_id: id,
    producto_id: item?.producto_id ?? null,
    nombre: item?.nombre ?? '',
    cantidad,
    precio: Number(item?.precio) || 0,
  };
});

const totalCarrito = () => lineas().reduce((a, l) => a + l.precio * l.cantidad, 0);
const cantidadTotal = () => [...carrito.values()].reduce((a, n) => a + n, 0);

function cambiar(id, delta) {
  const actual = carrito.get(id) || 0;
  const nuevo = Math.max(0, Math.min(99, actual + delta));
  if (nuevo === 0) carrito.delete(id);
  else carrito.set(id, nuevo);
  pintarItem(id);
  pintarBarra();
}

/* ------------------------------------------------------------------ */
/*  Render del catálogo                                                */
/* ------------------------------------------------------------------ */

function pintarCatalogo() {
  const cont = $('#catalogo');

  if (!catalogo.length) {
    cont.innerHTML = `
      <div class="aviso">
        <h2>Todavía no hay nada publicado</h2>
        <p>Estamos cargando el menú de la semana. Escribinos y te contamos qué hay.</p>
        ${botonWhatsApp('Hola! Quería consultar qué tienen para pedir.')}
      </div>`;
    return;
  }

  const porCategoria = catalogo.reduce((acc, item) => {
    (acc[item.categoria || 'Otros'] ||= []).push(item);
    return acc;
  }, {});

  cont.innerHTML = Object.entries(porCategoria).map(([cat, items]) => `
    <h2 class="categoria">${esc(cat)}</h2>
    <div class="items">${items.map(tarjeta).join('')}</div>
  `).join('');

  cont.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mas], [data-menos]');
    if (!btn) return;
    const fila = btn.closest('[data-id]');
    cambiar(fila.dataset.id, btn.hasAttribute('data-mas') ? 1 : -1);
  });
}

function tarjeta(item) {
  const unidad = item.unidad_venta && item.unidad_venta !== 'unidad'
    ? ` <span class="item__unidad">por ${esc(item.unidad_venta)}</span>` : '';

  return `
    <article class="item" data-id="${esc(item.id)}">
      ${item.foto_url
        ? `<img class="item__foto" src="${esc(item.foto_url)}" alt="" loading="lazy" width="64" height="64">`
        : ''}
      <div class="item__texto">
        <span class="item__nombre">${esc(item.nombre)}</span>
        ${item.descripcion ? `<span class="item__desc">${esc(item.descripcion)}</span>` : ''}
        <span class="item__precio">${money(item.precio)}${unidad}</span>
      </div>
      <div class="stepper">
        <button class="stepper__btn oculto" data-menos
                aria-label="Sacar uno de ${esc(item.nombre)}">−</button>
        <span class="stepper__cant oculto" data-cant>0</span>
        <button class="stepper__btn stepper__btn--mas" data-mas
                aria-label="Agregar ${esc(item.nombre)}">+</button>
      </div>
    </article>`;
}

/** Repinta una sola tarjeta: no hace falta rehacer la lista entera en cada tap. */
function pintarItem(id) {
  const fila = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!fila) return;

  const cant = carrito.get(id) || 0;
  fila.classList.toggle('item--elegido', cant > 0);
  fila.querySelector('[data-menos]').classList.toggle('oculto', cant === 0);

  const nodo = fila.querySelector('[data-cant]');
  nodo.textContent = cant;
  nodo.classList.toggle('oculto', cant === 0);
}

function pintarBarra() {
  const barra = $('#barra');
  const cant = cantidadTotal();

  barra.hidden = false;
  // El hidden se saca primero para que la transición del transform corra.
  requestAnimationFrame(() => barra.classList.toggle('barra--visible', cant > 0));

  $('#barra-items').textContent = cant === 1 ? '1 producto' : `${cant} productos`;
  $('#barra-total').textContent = money(totalCarrito());
  $('#ir-pedido').disabled = cant === 0;
}

/* ------------------------------------------------------------------ */
/*  Hoja del formulario                                                */
/* ------------------------------------------------------------------ */

function abrirHoja() {
  pintarResumen();
  $('#fondo').hidden = false;
  $('#hoja').hidden = false;
  document.body.classList.add('con-sheet');
  $('#f-nombre').focus({ preventScroll: true });
}

function cerrarHoja() {
  $('#fondo').hidden = true;
  $('#hoja').hidden = true;
  document.body.classList.remove('con-sheet');
  mostrarError(null);
}

function pintarResumen() {
  $('#resumen').innerHTML = `
    ${lineas().map((l) => `
      <div class="resumen__linea">
        <span>${l.cantidad}× ${esc(l.nombre)}</span>
        <span class="num">${money(l.precio * l.cantidad)}</span>
      </div>`).join('')}
    <div class="resumen__total">
      <strong>Total</strong>
      <strong class="num">${money(totalCarrito())}</strong>
    </div>`;
}

function mostrarError(texto) {
  const p = $('#error');
  p.hidden = !texto;
  p.textContent = texto || '';
  if (texto) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function elegirModo(modo) {
  modoEntrega = modo;
  document.querySelectorAll('.opcion').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.modo === modo));
  });
  const campo = $('#campo-dir');
  campo.classList.toggle('oculto', modo !== 'domicilio');
  if (modo === 'domicilio') $('#f-dir').focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ */
/*  Enviar                                                             */
/* ------------------------------------------------------------------ */

/** Devuelve el pedido listo para insertar, o un string con el error. */
function armarPedido() {
  const nombre = $('#f-nombre').value.trim();
  if (nombre.length < 2) return 'Necesitamos tu nombre para saber de quién es el pedido.';

  const telefono = normalizarTelefono($('#f-tel').value);
  if (!/^\d{10}$/.test(telefono)) {
    return 'El WhatsApp tiene que ser de 10 números, sin el 0 ni el 15. Por ejemplo 2494551234.';
  }

  if (!modoEntrega) return 'Elegí si lo retirás en el CIC o si te lo llevamos.';

  const direccion = $('#f-dir').value.trim();
  if (modoEntrega === 'domicilio' && direccion.length < 5) {
    return 'Para llevártelo necesitamos la dirección completa.';
  }

  if (!carrito.size) return 'Todavía no elegiste nada.';

  const fecha = $('#f-fecha').value;

  return {
    id: uuid(),
    nombre,
    telefono,
    modo_entrega: modoEntrega,
    direccion: modoEntrega === 'domicilio' ? direccion : null,
    fecha_deseada: fecha || null,
    notas: $('#f-notas').value.trim() || null,
    items: lineas(),
    total: totalCarrito(),
  };
}

async function enviar(e) {
  e.preventDefault();
  mostrarError(null);

  // El honeypot. Silencio: si le decimos que falló, el bot reintenta.
  if ($('#f-empresa').value) {
    pantallaListo(uuid(), null);
    return;
  }

  const desde = Number(localStorage.getItem(CLAVE_LIMITE) || 0);
  if (Date.now() - desde < LIMITE_MS) {
    mostrarError('Recién mandaste un pedido. Esperá un minuto o escribinos por WhatsApp.');
    return;
  }

  const pedido = armarPedido();
  if (typeof pedido === 'string') { mostrarError(pedido); return; }

  const btn = $('#enviar');
  btn.disabled = true;
  btn.textContent = 'Enviando…';

  try {
    if (!configurado()) throw new Error('sin configurar');
    await depositarPedido(pedido);
    localStorage.setItem(CLAVE_LIMITE, String(Date.now()));
    cerrarHoja();
    pantallaListo(pedido.id, pedido);
  } catch (err) {
    // Sin conexión o con el insert fallado el cliente no ve un error sin salida:
    // el pedido se cierra por WhatsApp, que es como se cierra igual.
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'Enviar el pedido';
    ofrecerWhatsApp(pedido);
  }
}

function ofrecerWhatsApp(pedido) {
  if (!hayWhatsApp()) {
    mostrarError('No pudimos enviar el pedido. Probá de nuevo en un minuto.');
    return;
  }
  mostrarError('No pudimos enviar el pedido desde acá. Mandanoslo por WhatsApp y lo tomamos igual.');
  $('#enviar').outerHTML = `
    <a class="btn-wa" id="enviar" href="${enlaceWhatsApp(textoPedido(pedido))}"
       target="_blank" rel="noopener">Pedir por WhatsApp</a>`;
}

/* ------------------------------------------------------------------ */
/*  WhatsApp                                                           */
/* ------------------------------------------------------------------ */

const enlaceWhatsApp = (texto) =>
  `https://wa.me/${CONFIG.WHATSAPP}?text=${encodeURIComponent(texto)}`;

function botonWhatsApp(texto, etiqueta = 'Escribirnos por WhatsApp') {
  if (!hayWhatsApp()) return '';
  return `<a class="btn-wa" href="${esc(enlaceWhatsApp(texto))}" target="_blank" rel="noopener">${esc(etiqueta)}</a>`;
}

function textoPedido(pedido, codigo = null) {
  const entrega = pedido.modo_entrega === 'domicilio'
    ? `Envío a domicilio: ${pedido.direccion}`
    : 'Retiro en el CIC';

  return [
    codigo ? `Hola! Hice el pedido ${codigo} por la web.` : 'Hola! Quería hacer este pedido:',
    '',
    ...pedido.items.map((l) => `• ${l.cantidad}× ${l.nombre}`),
    '',
    `Total: ${money(pedido.total)}`,
    entrega,
    pedido.fecha_deseada ? `Para el ${pedido.fecha_deseada}` : null,
    pedido.notas ? `Nota: ${pedido.notas}` : null,
    '',
    `Soy ${pedido.nombre}.`,
  ].filter((l) => l !== null).join('\n');
}

/* ------------------------------------------------------------------ */
/*  Confirmación                                                       */
/* ------------------------------------------------------------------ */

function pantallaListo(id, pedido) {
  const codigo = codigoDe(id);
  const texto = pedido
    ? textoPedido(pedido, codigo)
    : `Hola! Hice el pedido ${codigo} por la web.`;

  $('#barra').hidden = true;
  window.scrollTo({ top: 0 });

  $('#app').innerHTML = `
    <section class="listo envoltorio">
      <div class="listo__tilde" aria-hidden="true">✓</div>
      <h2>¡Listo, ${esc(pedido?.nombre?.split(' ')[0] || 'gracias')}!</h2>
      <p class="listo__bajada">
        Nos llegó tu pedido. Te confirmamos por WhatsApp el horario y cómo pagarlo.
      </p>
      <div class="listo__codigo">${esc(codigo)}</div>

      <div class="listo__acciones">
        ${botonWhatsApp(texto)}
        <button class="btn-secundario" onclick="location.reload()">Hacer otro pedido</button>
      </div>
    </section>

    <footer class="pie envoltorio">
      Un proyecto de <strong>Mirmidones Asociación Civil</strong>
    </footer>`;
}

/* ------------------------------------------------------------------ */
/*  Arranque                                                           */
/* ------------------------------------------------------------------ */

function sinCatalogo() {
  $('#catalogo').innerHTML = `
    <div class="aviso">
      <h2>No pudimos cargar el menú</h2>
      <p>Puede ser la señal. Probá de nuevo, o escribinos y te pasamos qué hay hoy.</p>
      <button class="btn-secundario" onclick="location.reload()"
              style="margin-bottom:var(--sp-2)">Reintentar</button>
      ${botonWhatsApp('Hola! Quería consultar qué tienen para pedir.')}
    </div>`;
}

async function arrancar() {
  $('#ir-pedido').addEventListener('click', abrirHoja);
  $('#fondo').addEventListener('click', cerrarHoja);
  $('#form').addEventListener('submit', enviar);

  document.querySelectorAll('.opcion').forEach((b) => {
    b.addEventListener('click', () => elegirModo(b.dataset.modo));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#hoja').hidden) cerrarHoja();
  });

  // No se puede pedir para ayer.
  $('#f-fecha').min = hoyISO();

  if (!configurado()) {
    console.warn('catalogo: falta completar SUPABASE_URL y SUPABASE_ANON_KEY en config.js');
    sinCatalogo();
    return;
  }

  try {
    catalogo = await traerCatalogo();
    pintarCatalogo();
  } catch (err) {
    console.error(err);
    sinCatalogo();
  }
}

arrancar();
