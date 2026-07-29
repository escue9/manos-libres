/**
 * pedidos.js — Venta rápida · Pedidos · Clientes
 * Colores: naranja var(--pedidos) / amarillo var(--clientes)
 *
 * Ver docs/PDR.md §4.2
 *
 * LISTO — Venta rápida (mostrador del CIC y cancha de Uncas)
 *
 * TODO Fase 2:
 *  [ ] Pedidos activos por estado, con alerta de entrega en riesgo
 *  [ ] nuevoPedido(): cliente por teléfono, fecha de entrega, validación de stock
 *  [ ] Agenda semanal por fecha_entrega — la pantalla de cada mañana
 *  [ ] Clientes con segmento: Nuevo / Frecuente ≥2 / Fiel ≥5
 *
 * Reglas:
 *  - Los snapshots de precio y costo son inmutables (PDR §3, pedido_item)
 *  - Un pedido puede tener varios cobros (seña + saldo)
 *  - El movimiento de caja del cobro se genera solo: nunca cargarlo a mano
 */

import { db } from '../db.js';
import { state } from '../state.js';
import { auth } from '../auth.js';
import { ui } from '../ui.js';
import { costoEfectivo } from '../calc.js';

/** Carrito en memoria: producto_id → cantidad. Se vacía al confirmar. */
let carrito = {};

// Fecha local: toISOString() devuelve UTC y una venta de las 21:30 en la cancha
// quedaría fechada mañana.
const hoyISO = () => ui.hoyISO();

/* ------------------------------------------------------------------ */
/*  Transacción de venta                                               */
/* ------------------------------------------------------------------ */

/**
 * Una venta de mostrador es un pedido que nace entregado y cobrado.
 * Encadena, en este orden: pedido → items → cobro → caja → stock.
 *
 * Los snapshots de precio y costo se congelan acá: si mañana sube la harina,
 * el margen de esta venta no cambia (PDR §3).
 */
export async function registrarVenta({ lineas, medio, clienteId = null }) {
  if (!lineas?.length) throw new Error('La venta no tiene productos');

  const total = lineas.reduce((a, l) => a + l.producto.precio_venta * l.cantidad, 0);
  const un = state.unidadNegocio.id;
  const fecha = hoyISO();

  const pedido = await db.from('pedido').insert({
    unidad_negocio_id: un,
    cliente_id: clienteId,
    canal: 'cic_presencial',
    fecha_pedido: fecha,
    fecha_entrega: fecha,
    estado: 'entregado',
    total,
    descuento: 0,
    monto_cobrado: total,
    estado_pago: 'pagado',
    created_by: auth.trabajadoraId,
  });

  await db.from('pedido_item').insert(lineas.map((l) => ({
    pedido_id: pedido.id,
    producto_id: l.producto.id,
    cantidad: l.cantidad,
    precio_unitario: l.producto.precio_venta,   // snapshot
    costo_unitario: costoEfectivo(l.producto),  // snapshot
  })));

  const cobro = await db.from('cobro').insert({
    pedido_id: pedido.id, fecha, monto: total, medio,
  });

  // Automático por la regla 6 de CLAUDE.md: nunca se carga a mano
  await db.from('movimiento_caja').insert({
    unidad_negocio_id: un,
    fecha,
    tipo: 'ingreso',
    origen: 'cobro',
    referencia_id: cobro.id,
    monto: total,
    descripcion: 'Venta rápida',
    medio,
  });

  // Stock: descuenta y deja rastro (regla 7)
  for (const l of lineas) {
    await db.from('producto')
      .update({ stock_actual: (l.producto.stock_actual || 0) - l.cantidad })
      .eq('id', l.producto.id);

    await db.from('movimiento_stock_producto').insert({
      producto_id: l.producto.id,
      fecha: new Date().toISOString(),
      tipo: 'venta',
      cantidad: -l.cantidad,
      referencia_id: pedido.id,
    });
  }

  return { pedido, total };
}

async function totalVendidoHoy() {
  const pedidos = await db.from('pedido').select()
    .eq('fecha_entrega', hoyISO()).eq('estado', 'entregado');
  return pedidos.reduce((a, p) => a + (p.total || 0), 0);
}

/* ------------------------------------------------------------------ */
/*  Hoja de cobro                                                      */
/* ------------------------------------------------------------------ */

const MEDIOS = [
  { id: 'efectivo', etiqueta: 'Efectivo',
    svg: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/>' },
  { id: 'transferencia', etiqueta: 'Transfer.',
    svg: '<path d="M4 8h13M14 5l3 3-3 3"/><path d="M20 16H7M10 19l-3-3 3-3"/>' },
  { id: 'mercadopago', etiqueta: 'Mercado Pago',
    svg: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 10h20"/>' },
];

/** Convierte el carrito en las líneas que espera registrarVenta(). */
function lineasDelCarrito() {
  return Object.entries(carrito).map(([id, cantidad]) => ({
    producto: state.productoPorId(id),
    cantidad,
  }));
}

function abrirCobro(total, onListo) {
  // Clientes ya cargados, para no tener que escribir el nombre
  const frecuentes = state.clientes.slice(0, 3);
  let medio = null;
  let clienteId = null;

  ui.abrirModal(`
    <div class="cobro__label center">Total a cobrar</div>
    <div class="cobro__total">${ui.money(total)}</div>

    ${frecuentes.length ? `
      <div class="cobro__label" style="margin-bottom:var(--sp-2)">¿Para quién? (opcional)</div>
      <div class="chips" id="chips">
        <button class="chip sel" data-cli="">Sin nombre</button>
        ${frecuentes.map((c) => `<button class="chip" data-cli="${c.id}">${ui.esc(c.nombre)}</button>`).join('')}
      </div>` : ''}

    <div class="medios">
      ${MEDIOS.map((m) => `
        <button class="medio" data-medio="${m.id}">
          <svg viewBox="0 0 24 24">${m.svg}</svg>${m.etiqueta}
        </button>`).join('')}
    </div>

    <button class="btn--confirmar" id="confirmar" disabled>Confirmar venta</button>
    <button class="btn btn--ghost btn--block" data-close
            style="margin-top:var(--sp-2);border:none">Cancelar</button>
  `, (root) => {
    const btn = root.querySelector('#confirmar');

    root.querySelector('#chips')?.addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      root.querySelectorAll('.chip').forEach((x) => x.classList.remove('sel'));
      c.classList.add('sel');
      clienteId = c.dataset.cli || null;
    });

    root.querySelectorAll('.medio').forEach((m) => m.addEventListener('click', () => {
      root.querySelectorAll('.medio').forEach((x) => x.classList.remove('sel'));
      m.classList.add('sel');
      medio = m.dataset.medio;
      btn.disabled = false;
    }));

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Guardando…';
      try {
        await registrarVenta({ lineas: lineasDelCarrito(), medio, clienteId });
        ui.cerrarModal();
        onListo(total);
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        btn.textContent = 'Confirmar venta';
        ui.toast('No se pudo registrar la venta', true);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Vista                                                              */
/* ------------------------------------------------------------------ */

export async function render(vista) {
  carrito = {};
  const productos = state.productos.filter((p) => p.activo);

  if (!productos.length) {
    document.body.classList.remove('venta-activa');
    vista.innerHTML = ui.vacio({
      modulo: 'pedidos', icono: '\u{1F4E6}', titulo: 'Sin productos',
      texto: 'Cargá productos en el catálogo para poder vender.', fase: 'Fase 1',
    });
    return;
  }

  vista.classList.add('view--venta');
  document.body.classList.add('venta-activa');

  const porCategoria = productos.reduce((acc, p) => {
    (acc[p.categoria] ||= []).push(p);
    return acc;
  }, {});

  vista.innerHTML = `
    <div class="venta-header">
      <h1>Venta rápida</h1>
      <div class="venta-header__hoy">
        <span>Hoy</span>
        <b class="num" id="ventas-hoy">${ui.money(await totalVendidoHoy())}</b>
      </div>
    </div>

    ${Object.entries(porCategoria).map(([cat, items]) => `
      <div class="categoria-titulo">${ui.esc(cat)}</div>
      <div class="productos-grid">${items.map(tarjeta).join('')}</div>
    `).join('')}

    <div class="venta-barra" id="barra">
      <div class="venta-barra__top">
        <div class="venta-barra__items" id="items">Sin items</div>
        <div class="venta-barra__total" id="total">${ui.money(0)}</div>
      </div>
      <button class="btn--cobrar" id="cobrar" disabled>Cobrar</button>
    </div>`;

  cablear(vista);
}

function tarjeta(p) {
  const stock = p.stock_actual || 0;
  return `
    <button class="producto-card" data-id="${p.id}">
      <span class="producto-card__cantidad num">0</span>
      <span class="producto-card__nombre">${ui.esc(p.nombre)}</span>
      <span>
        <span class="producto-card__precio">${ui.money(p.precio_venta)}</span><br>
        <span class="producto-card__stock${stock <= 0 ? ' agotado' : ''}">${
          stock > 0 ? `quedan ${stock}` : 'sin stock cargado'
        }</span>
      </span>
      <span class="producto-card__menos" data-menos>−</span>
    </button>`;
}

function cablear(vista) {
  const barra = vista.querySelector('#barra');
  const elItems = vista.querySelector('#items');
  const elTotal = vista.querySelector('#total');
  const btnCobrar = vista.querySelector('#cobrar');

  const total = () => Object.entries(carrito)
    .reduce((a, [id, q]) => a + state.productoPorId(id).precio_venta * q, 0);
  const unidades = () => Object.values(carrito).reduce((a, q) => a + q, 0);

  function pintar() {
    const t = total(), n = unidades();
    elTotal.textContent = ui.money(t);
    elItems.textContent = n ? `${n} ${n === 1 ? 'item' : 'items'}` : 'Sin items';
    barra.classList.toggle('live', n > 0);
    btnCobrar.disabled = !n;
    vista.querySelectorAll('.producto-card').forEach((b) => {
      const q = carrito[b.dataset.id] || 0;
      b.classList.toggle('on', q > 0);
      b.querySelector('.producto-card__cantidad').textContent = q;
    });
  }

  function sumar(id, delta) {
    const q = (carrito[id] || 0) + delta;
    if (q <= 0) delete carrito[id]; else carrito[id] = q;
    navigator.vibrate?.(10);
    pintar();
  }

  vista.addEventListener('click', (e) => {
    const card = e.target.closest('.producto-card');
    if (!card) return;
    sumar(card.dataset.id, e.target.closest('[data-menos]') ? -1 : 1);
  });

  // Mantener apretado también resta: no hay que apuntar al botón chico
  let timer = null;
  vista.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.producto-card');
    if (!card) return;
    timer = setTimeout(() => { sumar(card.dataset.id, -1); timer = null; }, 480);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach((ev) =>
    vista.addEventListener(ev, () => { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true }));

  btnCobrar.addEventListener('click', () => {
    if (!unidades()) return;
    abrirCobro(total(), async (cobrado) => {
      carrito = {};
      await state.cargar();                                   // refresca el stock
      vista.querySelector('#ventas-hoy').textContent = ui.money(await totalVendidoHoy());
      vista.querySelectorAll('.producto-card').forEach((b) => {
        const st = state.productoPorId(b.dataset.id)?.stock_actual || 0;
        const s = b.querySelector('.producto-card__stock');
        s.textContent = st > 0 ? `quedan ${st}` : 'sin stock cargado';
        s.classList.toggle('agotado', st <= 0);
      });
      pintar();
      ui.toast(`Venta registrada · ${ui.money(cobrado)}`);
    });
  });

  pintar();
}

/* ------------------------------------------------------------------ */

export async function renderClientes(vista) {
  vista.innerHTML = ui.vacio({
    modulo: 'clientes',
    icono: '\u{1F465}',
    titulo: 'Clientes',
    texto: 'Quién compra, cada cuánto y cuánto gasta. Sirve para saber a quién '
         + 'conviene avisarle cuando hay producción.',
    fase: 'Fase 2',
  });
}
