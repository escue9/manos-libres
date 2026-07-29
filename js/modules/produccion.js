/**
 * produccion.js — Insumos · Recetas · Órdenes de producción · Stock terminado
 * Color del módulo: rosa var(--produccion)
 *
 * FASE 1 — ver docs/PDR.md §4.1
 *
 * Las cuatro pantallas viven acá con subnavegación. La lógica de plata está en
 * las funciones exportadas de arriba (registrarCompra, cerrarOrden, ajustes):
 * son las que prueban los tests y las que no pueden estar mal.
 *
 * Reglas que no se negocian:
 *  - No cerrar orden con insumo insuficiente sin ajuste explícito y con motivo
 *  - Todo cambio de stock deja movimiento_stock_*
 *  - El movimiento de caja de la compra se genera solo (regla 6)
 *  - Ocultar costos si !auth.puede('verCostos')
 */

import { db } from '../db.js';
import { state } from '../state.js';
import { auth } from '../auth.js';
import { ui } from '../ui.js';
import * as calc from '../calc.js';

const CATEGORIAS_INSUMO = ['Almacén', 'Carnicería', 'Verdulería', 'Lácteos', 'Packaging', 'Otros'];

const hoyISO = () => ui.hoyISO();
const ahoraISO = () => new Date().toISOString();

/** Agrupa un listado por el valor de un campo. */
function agrupar(filas, campo) {
  return filas.reduce((m, f) => {
    const k = f[campo];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(f);
    return m;
  }, new Map());
}

/* ================================================================== */
/*  Transacciones                                                      */
/* ================================================================== */

/**
 * Registrar una compra de insumo.
 *
 * En este orden, porque cada paso depende del anterior:
 *   a) suma el stock
 *   b) recalcula el costo unitario por promedio ponderado (PDR §5.1)
 *   c) genera el egreso en caja — automático, nunca a mano (regla 6)
 *   d) deja el movimiento de stock (regla 7)
 *   e) recalcula el costo de todos los productos que usan ese insumo
 *   f) devuelve las alertas de margen para avisarlas con nombre y apellido
 */
export async function registrarCompra({ insumoId, cantidad, costoTotal, proveedor = '', fecha = hoyISO(), medio = 'efectivo' }) {
  auth.exigir('gestionarInsumos');

  cantidad = Number(cantidad);
  costoTotal = Number(costoTotal);
  if (!(cantidad > 0)) throw new Error('La cantidad tiene que ser mayor a cero');
  if (!(costoTotal >= 0)) throw new Error('El costo no puede ser negativo');

  const insumo = await db.from('insumo').select().eq('id', insumoId).single();
  if (!insumo) throw new Error('Insumo inexistente');

  const stockPrevio = insumo.stock_actual || 0;
  const costoPrevio = insumo.costo_unitario || 0;
  const costoCompraUnit = costoTotal / cantidad;
  const costoNuevo = calc.costoPonderado(stockPrevio, costoPrevio, cantidad, costoCompraUnit);

  const compra = await db.from('compra_insumo').insert({
    insumo_id: insumoId, fecha, cantidad, costo_total: costoTotal, proveedor,
  });

  await db.from('insumo').update({
    stock_actual: stockPrevio + cantidad,
    costo_unitario: costoNuevo,
    proveedor_habitual: proveedor || insumo.proveedor_habitual || null,
  }).eq('id', insumoId);

  await db.from('movimiento_caja').insert({
    unidad_negocio_id: insumo.unidad_negocio_id,
    fecha,
    tipo: 'egreso',
    origen: 'compra_insumo',
    referencia_id: compra.id,
    monto: costoTotal,
    descripcion: `Compra de ${insumo.nombre}`,
    medio,
  });

  await db.from('movimiento_stock_insumo').insert({
    insumo_id: insumoId,
    fecha: ahoraISO(),
    tipo: 'compra',
    cantidad,
    referencia_id: compra.id,
  });

  const alertas = await recalcularCostos([insumoId]);

  return { compra, costoPrevio, costoNuevo, costoCompraUnit, alertas };
}

/**
 * Recalcula producto.costo_calculado desde la receta.
 *
 * @param {Array|null} insumoIds  si viene, solo toca los productos que usan
 *                                esos insumos. Si es null, recalcula todo.
 * @returns {Array} alertas — productos bajo el margen mínimo o con receta rota
 */
export async function recalcularCostos(insumoIds = null) {
  const [productos, recetas, insumos] = await Promise.all([
    db.from('producto').select(),
    db.from('receta_item').select(),
    db.from('insumo').select(),
  ]);

  const insumosPorId = new Map(insumos.map((i) => [i.id, i]));
  const porProducto = agrupar(recetas, 'producto_id');
  const alertas = [];

  for (const p of productos) {
    const receta = porProducto.get(p.id) || [];

    // Sin receta el costo vuelve a ser el manual (PDR §3, producto)
    if (!receta.length) {
      if (p.costo_calculado != null) {
        await db.from('producto').update({ costo_calculado: null }).eq('id', p.id);
      }
      continue;
    }

    if (insumoIds && !receta.some((r) => insumoIds.includes(r.insumo_id))) continue;

    let costo;
    try {
      costo = calc.costoProducto(receta, insumosPorId, p.rinde_por_lote);
    } catch (e) {
      // Unidades incompatibles: mejor avisar que guardar un costo inventado
      alertas.push({ producto: p.nombre, error: e.message });
      continue;
    }
    if (costo == null) continue;

    await db.from('producto').update({ costo_calculado: costo }).eq('id', p.id);

    const m = calc.margen(p.precio_venta || 0, costo);
    if (p.precio_venta > 0 && m.pct < calc.MARGEN_MINIMO) {
      alertas.push({ producto: p.nombre, margenPct: m.pct });
    }
  }

  return alertas;
}

/**
 * Insumos requeridos vs disponibles para una lista de productos planificados.
 * Es la tabla que se mira ANTES de empezar a cocinar.
 *
 * @param {Array} planificado  [{ producto_id, cantidad }]
 */
export async function requerimientos(planificado) {
  const [productos, recetas, insumos] = await Promise.all([
    db.from('producto').select(),
    db.from('receta_item').select(),
    db.from('insumo').select(),
  ]);

  const insumosPorId = new Map(insumos.map((i) => [i.id, i]));
  const recetasPorProducto = agrupar(recetas, 'producto_id');

  const lineas = planificado
    .map((x) => ({ producto: productos.find((p) => p.id === x.producto_id), cantidad: Number(x.cantidad) || 0 }))
    .filter((x) => x.producto && x.cantidad > 0);

  const consumo = calc.consumoTotal(lineas, recetasPorProducto, insumosPorId);

  return [...consumo.entries()]
    .map(([insumoId, requerido]) => {
      const insumo = insumosPorId.get(insumoId);
      const disponible = insumo.stock_actual || 0;
      return { insumo, requerido, disponible, falta: Math.max(0, requerido - disponible) };
    })
    .sort((a, b) => b.falta - a.falta || a.insumo.nombre.localeCompare(b.insumo.nombre));
}

/** Crea la orden con sus productos planificados. Nace en 'planificada'. */
export async function crearOrden({ fecha = hoyISO(), items = [], notas = '' }) {
  const lineas = items.filter((i) => Number(i.cantidad) > 0);
  if (!lineas.length) throw new Error('La orden no tiene productos');

  const orden = await db.from('orden_produccion').insert({
    unidad_negocio_id: state.unidadNegocio.id,
    fecha,
    estado: 'planificada',
    costo_insumos: 0,
    costo_mano_obra: 0,
    notas,
  });

  await db.from('produccion_item').insert(lineas.map((i) => ({
    orden_produccion_id: orden.id,
    producto_id: i.producto_id,
    cantidad_planificada: Number(i.cantidad),
    cantidad_real: null,
    costo_unitario_snapshot: null,
  })));

  return orden;
}

/**
 * Sincroniza las trabajadoras de una orden: crea las jornadas que faltan y
 * borra las que se sacaron. La tarifa se congela desde tarifa_historica según
 * la fecha de la orden, no desde trabajadora.tarifa_dia (PDR §3).
 *
 * Respeta la restricción de una jornada por trabajadora por fecha: si ya
 * existe una ese día, se la vincula a la orden en vez de duplicarla.
 */
export async function asignarTrabajadoras(ordenId, trabajadoraIds = []) {
  const orden = await db.from('orden_produccion').select().eq('id', ordenId).single();
  if (!orden) throw new Error('Orden inexistente');

  const actuales = await db.from('jornada').select().eq('orden_produccion_id', ordenId);

  for (const j of actuales) {
    if (trabajadoraIds.includes(j.trabajadora_id)) continue;
    if (j.estado_pago === 'pagada') continue;      // ya liquidada: no se toca
    await db.from('jornada').delete().eq('id', j.id);
  }

  const [trabajadoras, tarifas] = await Promise.all([
    db.from('trabajadora').select(),
    db.from('tarifa_historica').select(),
  ]);

  for (const id of trabajadoraIds) {
    if (actuales.some((j) => j.trabajadora_id === id)) continue;

    const mismoDia = await db.from('jornada').select().eq('trabajadora_id', id).eq('fecha', orden.fecha);
    if (mismoDia.length) {
      if (!mismoDia[0].orden_produccion_id) {
        await db.from('jornada').update({ orden_produccion_id: ordenId }).eq('id', mismoDia[0].id);
      }
      continue;
    }

    const t = trabajadoras.find((x) => x.id === id);
    await db.from('jornada').insert({
      trabajadora_id: id,
      fecha: orden.fecha,
      orden_produccion_id: ordenId,
      tarifa_aplicada: calc.tarifaVigente(
        tarifas.filter((x) => x.trabajadora_id === id), orden.fecha, t?.tarifa_dia || 0,
      ),
      origen_carga: 'admin',
      confirmada: true,
      estado_pago: 'pendiente',
    });
  }

  return db.from('jornada').select().eq('orden_produccion_id', ordenId);
}

/**
 * Cierra la orden con la cantidad REAL producida.
 *
 *   a) descuenta los insumos según receta, con merma
 *   b) suma el producto terminado
 *   c) congela costo_unitario_snapshot en cada produccion_item
 *   d) imputa el costo de las jornadas vinculadas
 *
 * Si falta insumo no cierra: tira un error con la lista de faltantes. Solo
 * pasa si se le da un motivo de ajuste explícito, y ese ajuste queda
 * registrado con su movimiento de stock (PDR §4.1).
 *
 * @param {Object} cantidadesReales  produccion_item_id → cantidad real
 * @param {string} motivoAjuste      obligatorio si hay faltantes
 */
export async function cerrarOrden(ordenId, cantidadesReales = {}, { motivoAjuste = null } = {}) {
  const orden = await db.from('orden_produccion').select().eq('id', ordenId).single();
  if (!orden) throw new Error('Orden inexistente');
  if (orden.estado === 'cerrada') throw new Error('La orden ya está cerrada');

  const [items, productos, recetas, insumos] = await Promise.all([
    db.from('produccion_item').select().eq('orden_produccion_id', ordenId),
    db.from('producto').select(),
    db.from('receta_item').select(),
    db.from('insumo').select(),
  ]);

  const insumosPorId = new Map(insumos.map((i) => [i.id, i]));
  const recetasPorProducto = agrupar(recetas, 'producto_id');

  const lineas = items.map((it) => {
    const cantidad = cantidadesReales[it.id] != null
      ? Number(cantidadesReales[it.id])
      : it.cantidad_planificada;
    return { item: it, producto: productos.find((p) => p.id === it.producto_id), cantidad };
  }).filter((l) => l.producto);

  const consumo = calc.consumoTotal(lineas, recetasPorProducto, insumosPorId);

  /* --- a) insumos: primero verificar, después descontar --- */

  const faltantes = [...consumo.entries()]
    .map(([id, req]) => ({ insumo: insumosPorId.get(id), requerido: req, disponible: insumosPorId.get(id).stock_actual || 0 }))
    .filter((f) => f.requerido > f.disponible + 1e-9);

  if (faltantes.length && !motivoAjuste?.trim()) {
    const err = new Error(`Falta stock de: ${faltantes.map((f) => f.insumo.nombre).join(', ')}`);
    err.faltantes = faltantes;
    throw err;
  }

  for (const f of faltantes) {
    await ajustarStockInsumo(f.insumo.id, f.requerido, motivoAjuste);
    f.insumo.stock_actual = f.requerido;   // el objeto en memoria queda al día
  }

  let costoInsumos = 0;

  for (const [insumoId, cant] of consumo) {
    const insumo = insumosPorId.get(insumoId);
    costoInsumos += cant * (insumo.costo_unitario || 0);

    await db.from('insumo')
      .update({ stock_actual: (insumo.stock_actual || 0) - cant })
      .eq('id', insumoId);

    await db.from('movimiento_stock_insumo').insert({
      insumo_id: insumoId,
      fecha: ahoraISO(),
      tipo: 'produccion',
      cantidad: -cant,
      referencia_id: ordenId,
    });
  }

  /* --- b y c) producto terminado, con el costo congelado --- */

  for (const l of lineas) {
    let snapshot;
    try {
      snapshot = calc.costoProducto(
        recetasPorProducto.get(l.producto.id) || [], insumosPorId, l.producto.rinde_por_lote,
      );
    } catch { snapshot = null; }
    if (snapshot == null) snapshot = calc.costoEfectivo(l.producto);

    await db.from('produccion_item')
      .update({ cantidad_real: l.cantidad, costo_unitario_snapshot: snapshot })
      .eq('id', l.item.id);

    if (!l.cantidad) continue;

    await db.from('producto')
      .update({ stock_actual: (l.producto.stock_actual || 0) + l.cantidad })
      .eq('id', l.producto.id);

    await db.from('movimiento_stock_producto').insert({
      producto_id: l.producto.id,
      fecha: ahoraISO(),
      tipo: 'produccion',
      cantidad: l.cantidad,
      referencia_id: ordenId,
    });
  }

  /* --- d) mano de obra: solo las jornadas confirmadas --- */

  const jornadas = await db.from('jornada').select().eq('orden_produccion_id', ordenId);
  const costoManoObra = jornadas
    .filter((j) => j.confirmada)
    .reduce((a, j) => a + (j.tarifa_aplicada || 0), 0);

  await db.from('orden_produccion').update({
    estado: 'cerrada',
    costo_insumos: costoInsumos,
    costo_mano_obra: costoManoObra,
    cerrada_at: ahoraISO(),
  }).eq('id', ordenId);

  return { costoInsumos, costoManoObra, ajustados: faltantes.length };
}

/* --- ajustes de stock: siempre con motivo (regla 7) ---
 *
 * A propósito NO llevan auth.exigir(). Dos razones:
 *
 * 1. cerrarOrden() llama a ajustarStockInsumo() cuando hay faltante, y cerrar
 *    órdenes sí lo puede hacer una trabajadora. Guardar la función rompería
 *    ese flujo legítimo.
 * 2. Un ajuste mueve cantidades, no plata: no toca costo_unitario ni precios,
 *    y siempre deja un movimiento_stock_* con motivo obligatorio. El daño
 *    posible es acotado y auditable.
 *
 * El acceso por interfaz igual está restringido: la pantalla de Insumos
 * completa está detrás de gestionarInsumos.
 */

export async function ajustarStockInsumo(insumoId, nuevoStock, motivo) {
  if (!motivo?.trim()) throw new Error('El ajuste necesita un motivo');
  const insumo = await db.from('insumo').select().eq('id', insumoId).single();
  if (!insumo) throw new Error('Insumo inexistente');

  const delta = Number(nuevoStock) - (insumo.stock_actual || 0);
  await db.from('insumo').update({ stock_actual: Number(nuevoStock) }).eq('id', insumoId);
  await db.from('movimiento_stock_insumo').insert({
    insumo_id: insumoId, fecha: ahoraISO(), tipo: 'ajuste', cantidad: delta, motivo: motivo.trim(),
  });
  return delta;
}

export async function ajustarStockProducto(productoId, nuevoStock, motivo) {
  if (!motivo?.trim()) throw new Error('El ajuste necesita un motivo');
  const producto = await db.from('producto').select().eq('id', productoId).single();
  if (!producto) throw new Error('Producto inexistente');

  const delta = Number(nuevoStock) - (producto.stock_actual || 0);
  await db.from('producto').update({ stock_actual: Number(nuevoStock) }).eq('id', productoId);
  await db.from('movimiento_stock_producto').insert({
    producto_id: productoId, fecha: ahoraISO(), tipo: 'ajuste', cantidad: delta, motivo: motivo.trim(),
  });
  return delta;
}

/** Reemplaza la receta completa de un producto y recalcula su costo. */
export async function guardarReceta(productoId, items, rindePorLote) {
  auth.exigir('gestionarInsumos');

  const rinde = Number(rindePorLote);
  if (!(rinde > 0)) throw new Error('El rinde por lote tiene que ser mayor a cero');

  const insumos = new Map(state.insumos.map((i) => [i.id, i]));
  for (const it of items) {
    const insumo = insumos.get(it.insumo_id);
    if (!insumo) throw new Error('Hay una línea sin insumo');
    if (!(Number(it.cantidad) > 0)) throw new Error(`Falta la cantidad de ${insumo.nombre}`);
    if (!calc.sonCompatibles(it.unidad_medida, insumo.unidad_medida)) {
      throw new Error(`${insumo.nombre} se mide en ${insumo.unidad_medida}: no se puede cargar en ${it.unidad_medida}`);
    }
  }

  await db.from('receta_item').delete().eq('producto_id', productoId);
  if (items.length) {
    await db.from('receta_item').insert(items.map((it) => ({
      producto_id: productoId,
      insumo_id: it.insumo_id,
      cantidad: Number(it.cantidad),
      unidad_medida: it.unidad_medida,
      merma_pct: Number(it.merma_pct) || 0,
    })));
  }
  await db.from('producto').update({ rinde_por_lote: rinde }).eq('id', productoId);

  return recalcularCostos();
}

/* ================================================================== */
/*  Vista                                                              */
/* ================================================================== */

const SUBVISTAS = [
  { id: 'insumos', etiqueta: 'Insumos' },
  { id: 'recetas', etiqueta: 'Recetas' },
  { id: 'ordenes', etiqueta: 'Órdenes' },
  { id: 'stock',   etiqueta: 'Stock' },
];

/** Se recuerda entre renders: volver de un modal no te saca de la pestaña. */
let subvista = 'insumos';

const verCostos = () => auth.puede('verCostos');
const gestiona = () => auth.puede('gestionarInsumos');

export async function render(vista) {
  vista.innerHTML = `
    <div class="between" style="margin-bottom:var(--sp-4)">
      <h1 style="margin:0">Producción</h1>
    </div>
    <div class="subnav" id="subnav">
      ${SUBVISTAS.map((s) => `
        <button data-sub="${s.id}" class="${s.id === subvista ? 'active' : ''}">${s.etiqueta}</button>
      `).join('')}
    </div>
    <div id="sub"></div>`;

  vista.querySelector('#subnav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sub]');
    if (!b || b.dataset.sub === subvista) return;
    subvista = b.dataset.sub;
    render(vista);
  });

  await pintarSub(vista.querySelector('#sub'));
}

async function pintarSub(cont) {
  if (subvista === 'insumos') return pantallaInsumos(cont);
  if (subvista === 'recetas') return pantallaRecetas(cont);
  if (subvista === 'ordenes') return pantallaOrdenes(cont);
  return pantallaStock(cont);
}

/**
 * Botón flotante de la acción principal de cada pantalla.
 * Va dentro de la vista, no en el body: así desaparece solo al cambiar de tab.
 */
function fab(cont, onClick, titulo) {
  const b = document.createElement('button');
  b.className = 'fab';
  b.dataset.accent = 'produccion';
  b.setAttribute('aria-label', titulo);
  b.textContent = '+';
  b.addEventListener('click', onClick);
  cont.appendChild(b);
}

/** Recarga los datos y vuelve a pintar la vista activa. */
async function refrescar() {
  await state.invalidar();
}

/* ------------------------------------------------------------------ */
/*  1 · Insumos                                                        */
/* ------------------------------------------------------------------ */

async function pantallaInsumos(cont) {
  const insumos = state.insumos.filter((i) => i.activo !== false);

  if (!insumos.length) {
    cont.innerHTML = ui.vacio({
      modulo: 'produccion', icono: '\u{1F9C2}', titulo: 'Sin insumos cargados',
      texto: 'Cargá la harina, la carne y el resto con su costo real. De ahí sale '
           + 'el costo de cada producto.',
      fase: gestiona() ? '' : 'Lo carga la administración',
    });
    if (gestiona()) fab(cont, () => modalInsumo(), 'Nuevo insumo');
    return;
  }

  const bajos = insumos.filter((i) => (i.stock_actual || 0) <= (i.stock_minimo || 0)).length;

  cont.innerHTML = `
    ${bajos ? `<div class="alerta alerta--warn">${bajos === 1
        ? 'Hay 1 insumo en el mínimo o por debajo.'
        : `Hay ${bajos} insumos en el mínimo o por debajo.`}</div>` : ''}
    ${porCategoria(insumos).map(([cat, filas]) => `
      <div class="categoria-titulo">${ui.esc(cat || 'Sin categoría')}</div>
      <div class="lista">${filas.map(filaInsumo).join('')}</div>
    `).join('')}`;

  cont.querySelectorAll('[data-insumo]').forEach((el) =>
    el.addEventListener('click', () => modalAccionesInsumo(el.dataset.insumo)));

  if (gestiona()) fab(cont, () => modalInsumo(), 'Nuevo insumo');
}

/** Agrupa por categoría respetando el orden de la góndola, no el alfabético. */
function porCategoria(insumos) {
  return [...agrupar(insumos, 'categoria').entries()].sort((a, b) => {
    const ia = CATEGORIAS_INSUMO.indexOf(a[0]);
    const ib = CATEGORIAS_INSUMO.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

function filaInsumo(i) {
  const stock = i.stock_actual || 0;
  const min = i.stock_minimo || 0;
  return `
    <button class="fila" data-insumo="${i.id}">
      <div class="fila__main">
        <div class="fila__titulo">${ui.esc(i.nombre)}</div>
        <div class="fila__meta">
          <span class="num">${ui.cantidad(stock, i.unidad_medida)}</span>
          ${verCostos() && i.costo_unitario
            ? `<span class="dim">·</span><span class="num">${ui.money(i.costo_unitario)}/${ui.esc(ui.unidadCorta(i.unidad_medida))}</span>`
            : ''}
        </div>
        ${ui.nivelStock(stock, min)}
      </div>
      <div class="fila__lado">${ui.badgeStock(stock, min)}</div>
    </button>`;
}

function modalAccionesInsumo(id) {
  const i = state.insumoPorId(id);
  if (!i) return;

  ui.abrirModal(`
    <h3>${ui.esc(i.nombre)}</h3>
    <p class="faint" style="margin-top:calc(var(--sp-2) * -1)">
      ${ui.esc(i.categoria || 'Sin categoría')} ·
      <span class="num">${ui.cantidad(i.stock_actual || 0, i.unidad_medida)}</span> en stock
      ${verCostos() && i.costo_unitario ? ` · <span class="num">${ui.money(i.costo_unitario)}</span> por ${ui.esc(i.unidad_medida)}` : ''}
    </p>
    <div class="stack" style="margin-top:var(--sp-4)">
      ${gestiona() ? `<button class="btn btn--primary btn--block" data-accent="produccion" id="a-compra">Registrar compra</button>` : ''}
      <button class="btn btn--block" id="a-ajuste">Ajustar stock</button>
      ${gestiona() ? `<button class="btn btn--block" id="a-editar">Editar insumo</button>` : ''}
    </div>
  `, (root) => {
    root.querySelector('#a-compra')?.addEventListener('click', () => modalCompra(i.id));
    root.querySelector('#a-ajuste').addEventListener('click', () => modalAjusteInsumo(i.id));
    root.querySelector('#a-editar')?.addEventListener('click', () => modalInsumo(i));
  });
}

function modalInsumo(insumo = null) {
  const esNuevo = !insumo;
  ui.abrirModal(`
    <h3>${esNuevo ? 'Nuevo insumo' : 'Editar insumo'}</h3>
    <div class="stack" style="margin-top:var(--sp-4)">
      <div class="field">
        <label for="f-nombre">Nombre</label>
        <input class="input" id="f-nombre" placeholder="Harina 000" value="${ui.esc(insumo?.nombre || '')}">
      </div>
      <div class="row">
        <div class="field grow">
          <label for="f-cat">Categoría</label>
          <select class="input" id="f-cat">
            ${CATEGORIAS_INSUMO.map((c) => `<option ${c === insumo?.categoria ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="field grow">
          <label for="f-um">Se mide en</label>
          <select class="input" id="f-um">
            ${calc.UNIDADES.map((u) => `<option ${u === insumo?.unidad_medida ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row">
        <div class="field grow">
          <label for="f-min">Stock mínimo</label>
          <input class="input" id="f-min" type="number" inputmode="decimal" min="0" value="${insumo?.stock_minimo ?? 0}">
        </div>
        <div class="field grow">
          <label for="f-prov">Proveedor</label>
          <input class="input" id="f-prov" placeholder="opcional" value="${ui.esc(insumo?.proveedor_habitual || '')}">
        </div>
      </div>
      ${esNuevo ? `<p class="faint" style="margin:0">
        El stock y el costo se cargan después con "Registrar compra": así el costo
        sale del precio real que pagaste.</p>` : ''}
      <button class="btn btn--primary btn--block" data-accent="produccion" id="f-guardar">Guardar</button>
    </div>
  `, (root) => {
    root.querySelector('#f-guardar').addEventListener('click', async () => {
      const nombre = root.querySelector('#f-nombre').value.trim();
      if (!nombre) return ui.toast('Falta el nombre', true);

      const datos = {
        nombre,
        categoria: root.querySelector('#f-cat').value,
        unidad_medida: root.querySelector('#f-um').value,
        stock_minimo: Number(root.querySelector('#f-min').value) || 0,
        proveedor_habitual: root.querySelector('#f-prov').value.trim() || null,
      };

      try {
        if (esNuevo) {
          await db.from('insumo').insert({
            unidad_negocio_id: state.unidadNegocio.id,
            ...datos, costo_unitario: 0, stock_actual: 0, activo: true,
          });
        } else {
          await db.from('insumo').update(datos).eq('id', insumo.id);
          // Cambiar la unidad de medida mueve el costo de todas las recetas
          await recalcularCostos([insumo.id]);
        }
        ui.cerrarModal();
        await refrescar();
        ui.toast(esNuevo ? 'Insumo creado' : 'Insumo actualizado');
      } catch (e) {
        console.error(e);
        ui.toast(e.message || 'No se pudo guardar', true);
      }
    });
  });
}

function modalCompra(insumoId) {
  const i = state.insumoPorId(insumoId);

  ui.abrirModal(`
    <h3>Compra de ${ui.esc(i.nombre)}</h3>
    <div class="stack" style="margin-top:var(--sp-4)">
      <div class="row">
        <div class="field grow">
          <label for="c-cant">Cantidad (${ui.esc(i.unidad_medida)})</label>
          <input class="input" id="c-cant" type="number" inputmode="decimal" min="0" step="any" placeholder="0">
        </div>
        <div class="field grow">
          <label for="c-total">Costo total</label>
          <input class="input" id="c-total" type="number" inputmode="decimal" min="0" step="any" placeholder="0">
        </div>
      </div>
      <div class="calculo" id="c-unit">—</div>
      <div class="row">
        <div class="field grow">
          <label for="c-prov">Proveedor</label>
          <input class="input" id="c-prov" placeholder="opcional" value="${ui.esc(i.proveedor_habitual || '')}">
        </div>
        <div class="field grow">
          <label for="c-fecha">Fecha</label>
          <input class="input" id="c-fecha" type="date" value="${hoyISO()}">
        </div>
      </div>
      <div class="field">
        <label for="c-medio">Se pagó con</label>
        <select class="input" id="c-medio">
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
          <option value="mercadopago">Mercado Pago</option>
        </select>
      </div>
      <p class="faint" style="margin:0">Se descuenta solo de la caja como egreso.</p>
      <button class="btn btn--primary btn--block" data-accent="produccion" id="c-guardar">Registrar compra</button>
    </div>
  `, (root) => {
    const cant = root.querySelector('#c-cant');
    const total = root.querySelector('#c-total');
    const salida = root.querySelector('#c-unit');

    function preview() {
      const c = Number(cant.value), t = Number(total.value);
      if (!(c > 0) || !(t >= 0)) { salida.textContent = '—'; return; }
      const unit = t / c;
      const previo = i.costo_unitario || 0;
      const nuevo = calc.costoPonderado(i.stock_actual || 0, previo, c, unit);
      salida.innerHTML = `
        <div>Pagás <b class="num">${ui.money(unit)}</b> por ${ui.esc(i.unidad_medida)}</div>
        <div class="faint">El costo del insumo queda en
          <b class="num">${ui.money(nuevo)}</b>${previo ? ` (venía de ${ui.money(previo)})` : ''}</div>`;
    }
    cant.addEventListener('input', preview);
    total.addEventListener('input', preview);

    root.querySelector('#c-guardar').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const { alertas } = await registrarCompra({
          insumoId,
          cantidad: cant.value,
          costoTotal: total.value,
          proveedor: root.querySelector('#c-prov').value.trim(),
          fecha: root.querySelector('#c-fecha').value || hoyISO(),
          medio: root.querySelector('#c-medio').value,
        });
        ui.cerrarModal();
        await refrescar();
        if (alertas.length) modalAlertasMargen(alertas);
        else ui.toast('Compra registrada');
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        ui.toast(err.message || 'No se pudo registrar la compra', true);
      }
    });
  });
}

/** El aviso del PDR §4.1: qué producto quedó flojo y cuánto. */
function modalAlertasMargen(alertas) {
  if (!verCostos()) return ui.toast('Compra registrada');

  ui.abrirModal(`
    <h3>Compra registrada</h3>
    <p class="dim" style="margin-top:calc(var(--sp-2) * -1)">Subió un costo y hay productos para revisar:</p>
    <div class="stack" style="margin-top:var(--sp-4)">
      ${alertas.map((a) => `
        <div class="alerta alerta--${a.error ? 'danger' : 'warn'}">
          <b>${ui.esc(a.producto)}</b> —
          ${a.error ? ui.esc(a.error) : `bajó a <b class="num">${ui.pct(a.margenPct)}</b> de margen`}
        </div>`).join('')}
      <button class="btn btn--block" data-close>Entendido</button>
    </div>
  `);
}

function modalAjusteInsumo(insumoId) {
  const i = state.insumoPorId(insumoId);
  modalAjuste({
    titulo: `Ajustar ${i.nombre}`,
    actual: ui.cantidad(i.stock_actual || 0, i.unidad_medida),
    valor: i.stock_actual || 0,
    onGuardar: (nuevo, motivo) => ajustarStockInsumo(insumoId, nuevo, motivo),
  });
}

/** Hoja de ajuste de stock. El motivo es obligatorio, acá y en productos. */
function modalAjuste({ titulo, actual, valor, onGuardar }) {
  ui.abrirModal(`
    <h3>${ui.esc(titulo)}</h3>
    <p class="faint" style="margin-top:calc(var(--sp-2) * -1)">Ahora figura ${ui.esc(actual)}</p>
    <div class="stack" style="margin-top:var(--sp-4)">
      <div class="field">
        <label for="aj-cant">Cantidad real contada</label>
        <input class="input" id="aj-cant" type="number" inputmode="decimal" step="any" value="${valor}">
      </div>
      <div class="field">
        <label for="aj-motivo">Motivo</label>
        <input class="input" id="aj-motivo" placeholder="Se rompió, se contó mal, sobró de ayer…">
      </div>
      <p class="faint" style="margin:0">Todo ajuste queda registrado con su motivo.</p>
      <button class="btn btn--primary btn--block" data-accent="produccion" id="aj-guardar">Guardar ajuste</button>
    </div>
  `, (root) => {
    root.querySelector('#aj-guardar').addEventListener('click', async () => {
      try {
        await onGuardar(Number(root.querySelector('#aj-cant').value), root.querySelector('#aj-motivo').value);
        ui.cerrarModal();
        await refrescar();
        ui.toast('Stock ajustado');
      } catch (e) {
        ui.toast(e.message || 'No se pudo ajustar', true);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/*  2 · Recetas                                                        */
/* ------------------------------------------------------------------ */

async function pantallaRecetas(cont) {
  const productos = state.productos.filter((p) => p.activo);
  const recetas = agrupar(await db.from('receta_item').select(), 'producto_id');

  if (!productos.length) {
    cont.innerHTML = ui.vacio({
      modulo: 'produccion', icono: '\u{1F4D6}', titulo: 'Sin productos',
      texto: 'Primero tienen que existir los productos para poder darles receta.',
    });
    return;
  }

  cont.innerHTML = `
    <p class="faint" style="margin:0 0 var(--sp-3)">
      Qué lleva cada producto por lote.${verCostos() ? ' De acá sale el costo unitario.' : ''}
    </p>
    <div class="lista">${productos.map((p) => filaReceta(p, recetas.get(p.id) || [])).join('')}</div>`;

  cont.querySelectorAll('[data-receta]').forEach((el) =>
    el.addEventListener('click', () => editorReceta(el.dataset.receta, recetas.get(el.dataset.receta) || [])));
}

function filaReceta(p, receta) {
  const costo = calc.costoEfectivo(p);
  const m = calc.margen(p.precio_venta || 0, costo);
  const flojo = p.precio_venta > 0 && m.pct < calc.MARGEN_MINIMO;

  return `
    <button class="fila" data-receta="${p.id}">
      <div class="fila__main">
        <div class="fila__titulo">${ui.esc(p.nombre)}</div>
        <div class="fila__meta">
          ${receta.length
            ? `${receta.length} ${receta.length === 1 ? 'insumo' : 'insumos'} · rinde ${p.rinde_por_lote || 1}`
            : '<span class="dim">sin receta</span>'}
          ${verCostos() && costo ? `<span class="dim">·</span><span class="num">${ui.money(costo)} c/u</span>` : ''}
        </div>
      </div>
      <div class="fila__lado">
        ${auth.puede('verMargenes') && p.precio_venta > 0 && costo
          ? `<span class="badge badge--${flojo ? 'warn' : 'ok'}">${ui.pct(m.pct)}</span>`
          : (receta.length ? '' : '<span class="badge">—</span>')}
      </div>
    </button>`;
}

function editorReceta(productoId, recetaOriginal) {
  const p = state.productoPorId(productoId);
  const soloLectura = !gestiona();

  // Copia de trabajo: nada se guarda hasta apretar Guardar
  let lineas = recetaOriginal.map((r) => ({
    insumo_id: r.insumo_id,
    cantidad: r.cantidad,
    unidad_medida: r.unidad_medida || state.insumoPorId(r.insumo_id)?.unidad_medida,
    merma_pct: r.merma_pct || 0,
  }));
  let rinde = p.rinde_por_lote || 1;

  if (!state.insumos.length) {
    return ui.abrirModal(`
      <h3>${ui.esc(p.nombre)}</h3>
      <p class="dim">Todavía no hay insumos cargados. Cargalos en la pestaña
      Insumos y volvé a entrar acá.</p>
      <button class="btn btn--block" data-close>Cerrar</button>`);
  }

  ui.abrirModal(`
    <h3>${ui.esc(p.nombre)}</h3>
    <div class="field" style="margin-bottom:var(--sp-4)">
      <label for="r-rinde">Una vuelta de receta rinde</label>
      <input class="input" id="r-rinde" type="number" inputmode="numeric" min="1" value="${rinde}" ${soloLectura ? 'disabled' : ''}>
    </div>

    <div id="r-lineas" class="stack"></div>
    ${soloLectura ? '' : '<button class="btn btn--block" id="r-agregar" style="margin-top:var(--sp-3)">+ Agregar insumo</button>'}

    <div class="calculo" id="r-costo" style="margin-top:var(--sp-4)"></div>

    ${soloLectura ? '<button class="btn btn--block" data-close style="margin-top:var(--sp-4)">Cerrar</button>' : `
      <button class="btn btn--primary btn--block" data-accent="produccion" id="r-guardar"
              style="margin-top:var(--sp-4)">Guardar receta</button>`}
  `, (root) => {
    const cont = root.querySelector('#r-lineas');
    const salida = root.querySelector('#r-costo');

    function pintarLineas() {
      cont.innerHTML = lineas.length ? lineas.map((l, idx) => {
        const insumo = state.insumoPorId(l.insumo_id);
        const unidades = calc.unidadesCompatibles(insumo?.unidad_medida);
        return `
          <div class="receta-linea" data-idx="${idx}">
            <select class="input" data-campo="insumo_id" ${soloLectura ? 'disabled' : ''}>
              ${state.insumos.map((i) => `<option value="${i.id}" ${i.id === l.insumo_id ? 'selected' : ''}>${ui.esc(i.nombre)}</option>`).join('')}
            </select>
            <div class="receta-linea__nums">
              <input class="input" type="number" inputmode="decimal" step="any" min="0"
                     data-campo="cantidad" value="${l.cantidad}" aria-label="Cantidad" ${soloLectura ? 'disabled' : ''}>
              <select class="input" data-campo="unidad_medida" ${soloLectura ? 'disabled' : ''}>
                ${unidades.map((u) => `<option ${u === l.unidad_medida ? 'selected' : ''}>${u}</option>`).join('')}
              </select>
              <input class="input" type="number" inputmode="decimal" step="any" min="0"
                     data-campo="merma_pct" value="${l.merma_pct}" aria-label="Merma %" ${soloLectura ? 'disabled' : ''}>
              ${soloLectura ? '' : '<button class="btn btn--danger" data-quitar aria-label="Quitar">×</button>'}
            </div>
          </div>`;
      }).join('') : '<p class="faint" style="margin:0">Sin insumos todavía.</p>';

      pintarCosto();
    }

    function pintarCosto() {
      if (!verCostos()) { salida.innerHTML = '<span class="faint">Merma en % · el costo lo ve la administración</span>'; return; }
      if (!lineas.length) { salida.innerHTML = '<span class="faint">Agregá insumos para ver el costo.</span>'; return; }

      let costo;
      try {
        costo = calc.costoProducto(lineas, state.insumosMap, rinde);
      } catch (e) {
        salida.innerHTML = `<span class="danger">${ui.esc(e.message)}</span>`;
        return;
      }
      const m = calc.margen(p.precio_venta || 0, costo);
      const flojo = p.precio_venta > 0 && m.pct < calc.MARGEN_MINIMO;
      salida.innerHTML = `
        <div>Cuesta <b class="num">${ui.money(costo)}</b> por unidad</div>
        ${p.precio_venta > 0 ? `<div class="faint">Se vende a <span class="num">${ui.money(p.precio_venta)}</span> ·
          margen <b class="num ${flojo ? 'danger' : ''}">${ui.pct(m.pct)}</b></div>` : ''}`;
    }

    cont.addEventListener('input', (e) => {
      const fila = e.target.closest('[data-idx]');
      if (!fila) return;
      const l = lineas[Number(fila.dataset.idx)];
      const campo = e.target.dataset.campo;
      if (campo === 'insumo_id') {
        l.insumo_id = e.target.value;
        l.unidad_medida = state.insumoPorId(l.insumo_id)?.unidad_medida;
        pintarLineas();                       // cambian las unidades posibles
        return;
      }
      l[campo] = campo === 'unidad_medida' ? e.target.value : Number(e.target.value);
      pintarCosto();
    });

    cont.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-quitar]');
      if (!btn) return;
      lineas.splice(Number(btn.closest('[data-idx]').dataset.idx), 1);
      pintarLineas();
    });

    root.querySelector('#r-rinde')?.addEventListener('input', (e) => {
      rinde = Number(e.target.value) || 1;
      pintarCosto();
    });

    root.querySelector('#r-agregar')?.addEventListener('click', () => {
      const i = state.insumos[0];
      lineas.push({ insumo_id: i.id, cantidad: 0, unidad_medida: i.unidad_medida, merma_pct: 0 });
      pintarLineas();
    });

    root.querySelector('#r-guardar')?.addEventListener('click', async () => {
      try {
        const alertas = await guardarReceta(productoId, lineas, rinde);
        ui.cerrarModal();
        await refrescar();
        if (alertas.length) modalAlertasMargen(alertas);
        else ui.toast('Receta guardada');
      } catch (e) {
        ui.toast(e.message || 'No se pudo guardar la receta', true);
      }
    });

    pintarLineas();
  });
}

/* ------------------------------------------------------------------ */
/*  3 · Órdenes de producción                                          */
/* ------------------------------------------------------------------ */

const ESTADO_ORDEN = {
  planificada: { etiqueta: 'Planificada', badge: '' },
  en_curso:    { etiqueta: 'En curso',    badge: 'badge--warn' },
  cerrada:     { etiqueta: 'Cerrada',     badge: 'badge--ok' },
  cancelada:   { etiqueta: 'Cancelada',   badge: 'badge--danger' },
};

async function pantallaOrdenes(cont) {
  const ordenes = await db.from('orden_produccion').select().order('fecha', { ascending: false });
  const items = agrupar(await db.from('produccion_item').select(), 'orden_produccion_id');

  if (!ordenes.length) {
    cont.innerHTML = ui.vacio({
      modulo: 'produccion', icono: '\u{1F373}', titulo: 'Sin órdenes',
      texto: 'Una orden es una jornada de cocina: qué se planifica hacer, quiénes '
           + 'trabajan y qué salió al final.',
    });
    fab(cont, () => modalNuevaOrden(), 'Nueva orden');
    return;
  }

  cont.innerHTML = `<div class="lista">${ordenes.map((o) => {
    const its = items.get(o.id) || [];
    const total = its.reduce((a, i) => a + (i.cantidad_real ?? i.cantidad_planificada ?? 0), 0);
    const e = ESTADO_ORDEN[o.estado] || ESTADO_ORDEN.planificada;
    return `
      <button class="fila" data-orden="${o.id}">
        <div class="fila__main">
          <div class="fila__titulo">${ui.fecha(o.fecha)} · ${its.length} ${its.length === 1 ? 'producto' : 'productos'}</div>
          <div class="fila__meta">
            <span class="num">${total}</span> unidades
            ${o.estado === 'cerrada' && verCostos()
              ? `<span class="dim">·</span><span class="num">${ui.money((o.costo_insumos || 0) + (o.costo_mano_obra || 0))}</span>`
              : ''}
          </div>
        </div>
        <div class="fila__lado"><span class="badge ${e.badge}">${e.etiqueta}</span></div>
      </button>`;
  }).join('')}</div>`;

  cont.querySelectorAll('[data-orden]').forEach((el) =>
    el.addEventListener('click', () => modalOrden(el.dataset.orden)));

  fab(cont, () => modalNuevaOrden(), 'Nueva orden');
}

function modalNuevaOrden() {
  const productos = state.productos.filter((p) => p.activo);

  ui.abrirModal(`
    <h3>Nueva orden</h3>
    <div class="stack" style="margin-top:var(--sp-4)">
      <div class="field">
        <label for="o-fecha">Fecha de cocina</label>
        <input class="input" id="o-fecha" type="date" value="${hoyISO()}">
      </div>
      <div>
        <label class="dim" style="font-size:.78rem">Qué se va a producir</label>
        <div class="stack" style="margin-top:var(--sp-2)">
          ${productos.map((p) => `
            <div class="between" data-prod="${p.id}">
              <span>${ui.esc(p.nombre)}</span>
              <input class="input cant-chica" type="number" inputmode="numeric" min="0" placeholder="0"
                     aria-label="Cantidad de ${ui.esc(p.nombre)}">
            </div>`).join('')}
        </div>
      </div>
      <div class="field">
        <label for="o-notas">Notas</label>
        <input class="input" id="o-notas" placeholder="opcional">
      </div>
      <button class="btn btn--primary btn--block" data-accent="produccion" id="o-crear">Crear orden</button>
    </div>
  `, (root) => {
    root.querySelector('#o-crear').addEventListener('click', async () => {
      const items = [...root.querySelectorAll('[data-prod]')].map((el) => ({
        producto_id: el.dataset.prod,
        cantidad: Number(el.querySelector('input').value) || 0,
      }));
      try {
        const orden = await crearOrden({
          fecha: root.querySelector('#o-fecha').value || hoyISO(),
          notas: root.querySelector('#o-notas').value.trim(),
          items,
        });
        ui.cerrarModal();
        await refrescar();
        modalOrden(orden.id);
      } catch (e) {
        ui.toast(e.message || 'No se pudo crear la orden', true);
      }
    });
  });
}

async function modalOrden(ordenId) {
  const orden = await db.from('orden_produccion').select().eq('id', ordenId).single();
  const items = await db.from('produccion_item').select().eq('orden_produccion_id', ordenId);
  const jornadas = await db.from('jornada').select().eq('orden_produccion_id', ordenId);
  const cerrada = orden.estado === 'cerrada' || orden.estado === 'cancelada';

  const reqs = cerrada ? [] : await requerimientos(
    items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad_planificada })),
  );
  const hayFaltante = reqs.some((r) => r.falta > 0);
  const e = ESTADO_ORDEN[orden.estado] || ESTADO_ORDEN.planificada;

  // Quién trabajó ese día solo lo ve quien ve al equipo completo (regla 8):
  // para una trabajadora, la lista de nombres ya sería ver los días de otra.
  // El autoreporte de la propia jornada es de la fase 3.
  const asignadas = new Set(jornadas.map((j) => j.trabajadora_id));

  ui.abrirModal(`
    <div class="between">
      <h3 style="margin:0">Cocina del ${ui.fecha(orden.fecha)}</h3>
      <span class="badge ${e.badge}">${e.etiqueta}</span>
    </div>
    ${orden.notas ? `<p class="faint">${ui.esc(orden.notas)}</p>` : ''}

    <div class="bloque">
      <div class="bloque__titulo">Producción</div>
      <table class="table">
        <tbody>
          ${items.map((i) => {
            const p = state.productoPorId(i.producto_id);
            return `<tr>
              <td>${ui.esc(p?.nombre || '—')}</td>
              <td class="num right">${i.cantidad_real != null
                ? `${i.cantidad_real} <span class="faint">de ${i.cantidad_planificada}</span>`
                : i.cantidad_planificada}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    ${cerrada ? '' : `
      <div class="bloque">
        <div class="bloque__titulo">Insumos que hacen falta</div>
        ${reqs.length ? `
          <table class="table">
            <thead><tr><th>Insumo</th><th class="right">Hace falta</th><th class="right">Hay</th></tr></thead>
            <tbody>
              ${reqs.map((r) => `
                <tr class="${r.falta > 0 ? 'fila--falta' : ''}">
                  <td>${ui.esc(r.insumo.nombre)}</td>
                  <td class="num right">${ui.cantidad(r.requerido, r.insumo.unidad_medida)}</td>
                  <td class="num right">${ui.cantidad(r.disponible, r.insumo.unidad_medida)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          ${hayFaltante ? '<div class="alerta alerta--danger">Falta insumo para lo planificado. Comprá o ajustá el stock antes de cerrar.</div>' : ''}
        ` : '<p class="faint" style="margin:0">Ninguno de estos productos tiene receta cargada.</p>'}
      </div>

      ${auth.puede('verEquipoCompleto') ? `
        <div class="bloque">
          <div class="bloque__titulo">Quiénes trabajan</div>
          ${state.trabajadoras.length ? `
            <div class="chips" id="o-equipo">
              ${state.trabajadoras.map((t) => `
                <button class="chip ${asignadas.has(t.id) ? 'sel' : ''}" data-trab="${t.id}">${ui.esc(t.nombre)}</button>
              `).join('')}
            </div>
            <p class="faint" style="margin:var(--sp-2) 0 0">Cada una suma su jornada del día con la tarifa congelada.</p>
          ` : '<p class="faint" style="margin:0">No hay trabajadoras cargadas.</p>'}
        </div>` : ''}

      <div class="stack" style="margin-top:var(--sp-5)">
        <button class="btn btn--primary btn--block" data-accent="produccion" id="o-cerrar">Cerrar orden</button>
        <button class="btn btn--danger btn--block" id="o-cancelar">Cancelar orden</button>
      </div>`}

    ${orden.estado === 'cerrada' && verCostos() ? `
      <div class="bloque">
        <div class="bloque__titulo">Costo de la jornada</div>
        <div class="between"><span class="dim">Insumos</span><b class="num">${ui.money(orden.costo_insumos || 0)}</b></div>
        <div class="between"><span class="dim">Mano de obra</span><b class="num">${ui.money(orden.costo_mano_obra || 0)}</b></div>
        <div class="between" style="border-top:1px solid var(--border);margin-top:var(--sp-2);padding-top:var(--sp-2)">
          <span>Total</span><b class="num">${ui.money((orden.costo_insumos || 0) + (orden.costo_mano_obra || 0))}</b>
        </div>
      </div>` : ''}
  `, (root) => {
    root.querySelector('#o-equipo')?.addEventListener('click', async (ev) => {
      const chip = ev.target.closest('[data-trab]');
      if (!chip) return;
      chip.classList.toggle('sel');
      const ids = [...root.querySelectorAll('[data-trab].sel')].map((c) => c.dataset.trab);
      try {
        await asignarTrabajadoras(ordenId, ids);
      } catch (err) {
        chip.classList.toggle('sel');
        ui.toast(err.message || 'No se pudo asignar', true);
      }
    });

    root.querySelector('#o-cerrar')?.addEventListener('click', () => modalCerrarOrden(ordenId, items, reqs));

    root.querySelector('#o-cancelar')?.addEventListener('click', async () => {
      ui.cerrarModal();
      if (!await ui.confirmar('¿Cancelar esta orden?', 'Cancelar orden')) return;
      await db.from('orden_produccion').update({ estado: 'cancelada' }).eq('id', ordenId);
      await refrescar();
      ui.toast('Orden cancelada');
    });
  });
}

function modalCerrarOrden(ordenId, items, reqs) {
  const faltantesPrevios = reqs.filter((r) => r.falta > 0);

  ui.abrirModal(`
    <h3>¿Cuánto salió?</h3>
    <p class="faint" style="margin-top:calc(var(--sp-2) * -1)">
      La cantidad real, no la planificada. La diferencia queda registrada.</p>

    <div class="stack" style="margin-top:var(--sp-4)">
      ${items.map((i) => {
        const p = state.productoPorId(i.producto_id);
        return `
          <div class="between" data-item="${i.id}">
            <span>${ui.esc(p?.nombre || '—')}</span>
            <input class="input cant-chica" type="number" inputmode="numeric" min="0"
                   value="${i.cantidad_planificada}" aria-label="Salieron de ${ui.esc(p?.nombre || '')}">
          </div>`;
      }).join('')}

      ${faltantesPrevios.length ? `
        <div class="alerta alerta--danger">
          No alcanza el stock de ${faltantesPrevios.map((f) => ui.esc(f.insumo.nombre)).join(', ')}.
          Para cerrar igual hay que ajustar el stock y decir por qué.
        </div>
        <div class="field">
          <label for="cz-motivo">Motivo del ajuste</label>
          <input class="input" id="cz-motivo" placeholder="Se había cargado mal, se usó de otra cocina…">
        </div>` : ''}

      <button class="btn btn--primary btn--block" data-accent="produccion" id="cz-guardar">Cerrar orden</button>
    </div>
  `, (root) => {
    root.querySelector('#cz-guardar').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const reales = {};
      root.querySelectorAll('[data-item]').forEach((el) => {
        reales[el.dataset.item] = Number(el.querySelector('input').value) || 0;
      });

      btn.disabled = true;
      try {
        const r = await cerrarOrden(ordenId, reales, {
          motivoAjuste: root.querySelector('#cz-motivo')?.value || null,
        });
        ui.cerrarModal();
        await refrescar();
        ui.toast(verCostos()
          ? `Orden cerrada · insumos ${ui.money(r.costoInsumos)}`
          : 'Orden cerrada');
      } catch (e) {
        btn.disabled = false;
        ui.toast(e.message || 'No se pudo cerrar', true);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/*  4 · Stock terminado                                                */
/* ------------------------------------------------------------------ */

async function pantallaStock(cont) {
  const productos = state.productos.filter((p) => p.activo);

  if (!productos.length) {
    cont.innerHTML = ui.vacio({
      modulo: 'produccion', icono: '\u{1F4E6}', titulo: 'Sin productos',
      texto: 'Acá se ve qué hay hecho de cada cosa.',
    });
    return;
  }

  const valor = productos.reduce((a, p) => a + (p.stock_actual || 0) * calc.costoEfectivo(p), 0);

  cont.innerHTML = `
    ${verCostos() ? `
      <div class="stat" style="margin-bottom:var(--sp-4)">
        <div class="label">Valor del stock terminado</div>
        <div class="value">${ui.money(valor)}</div>
      </div>` : ''}

    <table class="table table--stack">
      <thead>
        <tr><th>Producto</th><th class="right">Stock</th><th class="right">Mínimo</th><th></th></tr>
      </thead>
      <tbody>
        ${productos.map((p) => `
          <tr data-stock="${p.id}">
            <td data-label="Producto">${ui.esc(p.nombre)}</td>
            <td data-label="Stock" class="num right">${p.stock_actual || 0}</td>
            <td data-label="Mínimo" class="num right">${p.stock_minimo || 0}</td>
            <td data-label="Estado" class="right">${ui.badgeStock(p.stock_actual || 0, p.stock_minimo || 0)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="faint">Tocá un producto para ajustar lo que hay de verdad.</p>`;

  cont.querySelectorAll('[data-stock]').forEach((el) => el.addEventListener('click', () => {
    const p = state.productoPorId(el.dataset.stock);
    modalAjuste({
      titulo: `Ajustar ${p.nombre}`,
      actual: `${p.stock_actual || 0} ${p.unidad_venta === 'unidad' ? 'unidades' : p.unidad_venta}`,
      valor: p.stock_actual || 0,
      onGuardar: (nuevo, motivo) => ajustarStockProducto(p.id, nuevo, motivo),
    });
  }));
}
