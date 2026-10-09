/**
 * produccion.js — Stock · Compras · Recetas · Producción
 * Color del módulo: rosa var(--produccion)
 *
 * FASE 1 — ver docs/PDR.md §4.1 y docs/FASE-1.md
 *
 * Las cuatro pantallas viven acá con subnavegación. La lógica de plata está en
 * las funciones exportadas de arriba (registrarCompra, cerrarOrden, ajustes,
 * reiniciarStock, cargarSemana): son las que prueban los tests, las que no
 * pueden estar mal y las que se llaman sin pantalla desde window.ml.produccion.
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
import {
  demandaPendiente, MEDIOS, CANALES, TIPOS_CLIENTE,
  guardarCliente, crearPedido, entregarPedido, registrarCobro,
} from './pedidos.js';

const CATEGORIAS_INSUMO = ['Almacén', 'Carnicería', 'Verdulería', 'Lácteos', 'Packaging', 'Otros'];

const hoyISO = () => ui.hoyISO();
const ahoraISO = () => ui.ahoraISO();

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

  // El texto del PDR §4.1: "Subió el costo de la carne. La empanada de carne
  // bajó a 18% de margen." La primera mitad solo si de verdad subió
  const subio = costoNuevo > costoPrevio + 1e-9 ? `Subió el costo de ${insumo.nombre.toLocaleLowerCase('es')}. ` : '';
  const alertas = (await recalcularCostos([insumoId]))
    .map((a) => (a.texto ? { ...a, texto: subio + a.texto } : a));

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

    // El margen se mira con lo que cobra quien lo produce adentro: es costo
    const m = calc.margen(p.precio_venta || 0, costo + (p.pago_produccion || 0));
    if (p.precio_venta > 0 && m.pct < calc.MARGEN_MINIMO) {
      alertas.push({ producto: p.nombre, margenPct: m.pct, texto: `${p.nombre} bajó a ${m.pct.toFixed(1)}% de margen.` });
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
  auth.exigir('cargarProduccion');
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

  // La tabla que se mira antes de empezar a cocinar (PDR §4.1, paso 2). Va
  // pegada a la orden para que quien la crea desde la consola la vea sin
  // otra llamada; la pantalla usa solo el id
  const reqs = await requerimientos(lineas.map((i) => ({ producto_id: i.producto_id, cantidad: Number(i.cantidad) })));
  return { ...orden, requerimientos: reqs, faltantes: reqs.filter((r) => r.falta > 0) };
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
  // Las jornadas que crea acá nacen confirmadas, o sea que van derecho a la
  // liquidación sin pasar por el circuito de autoreporte. Sin esta línea, una
  // trabajadora podía autoasignarse días pagos desde la consola: el bloque de
  // equipo estaba oculto en la interfaz, pero la función quedaba abierta.
  auth.exigir('liquidar');

  const orden = await db.from('orden_produccion').select().eq('id', ordenId).single();
  if (!orden) throw new Error('Orden inexistente');

  // Una jornada es un hecho, y estas nacen confirmadas: sin esta guarda se
  // podía planificar la orden del sábado el viernes, asignar a dos personas y
  // liquidar la semana pagando un día que todavía no pasó. Después no había
  // forma de deshacerlo: la jornada quedaba 'pagada' y nada la podía tocar.
  if (orden.fecha > ui.hoyISO()) {
    throw new Error('La orden es de un día que todavía no pasó: asigná el equipo ese día');
  }

  const actuales = await db.from('jornada').select().eq('orden_produccion_id', ordenId);

  for (const j of actuales) {
    if (trabajadoraIds.includes(j.trabajadora_id)) continue;
    if (j.estado_pago === 'pagada') continue;      // ya liquidada: no se toca
    await db.from('jornada').delete().eq('id', j.id);
  }

  for (const id of trabajadoraIds) {
    if (actuales.some((j) => j.trabajadora_id === id)) continue;

    const mismoDia = await db.from('jornada').select().eq('trabajadora_id', id).eq('fecha', orden.fecha);
    if (mismoDia.length) {
      if (!mismoDia[0].orden_produccion_id) {
        await db.from('jornada').update({ orden_produccion_id: ordenId }).eq('id', mismoDia[0].id);
      }
      continue;
    }

    // Desde octubre de 2026 se cobra por producción: la jornada queda como
    // registro de asistencia y no lleva plata. Lo que se cobra sale de
    // pago_produccion al cerrar la orden.
    await db.from('jornada').insert({
      trabajadora_id: id,
      fecha: orden.fecha,
      orden_produccion_id: ordenId,
      tarifa_aplicada: 0,
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
 *   c) congela costo_unitario_snapshot en cada produccion_item — materiales
 *      más lo que cobra quien lo produce
 *   d) deja lo que cobra cada productora en pago_produccion, y su suma como
 *      costo de mano de obra de la orden
 *
 * Si falta insumo no cierra: tira un error con la lista de faltantes. Solo
 * pasa si se le da un motivo de ajuste explícito, y ese ajuste queda
 * registrado con su movimiento de stock (PDR §4.1).
 *
 * Tampoco cierra si no se sabe quién produjo cada línea, o si un producto no
 * tiene definido cuánto se paga por unidad: sería producción que alguien hizo
 * y nadie cobra, y eso no se nota hasta el día de la liquidación.
 *
 * @param {Object} cantidadesReales  produccion_item_id → cantidad real
 * @param {string} motivoAjuste      obligatorio si hay faltantes
 * @param {string|Object} productoras  quién produjo. Un id de trabajadora para
 *        toda la orden, o produccion_item_id → id | [{ trabajadora_id, cantidad }]
 *        para repartir una línea. Si cierra una trabajadora y no se pasa nada,
 *        es ella
 */
export async function cerrarOrden(ordenId, cantidadesReales = {}, { motivoAjuste = null, productoras = null } = {}) {
  auth.exigir('cargarProduccion');
  const orden = await db.from('orden_produccion').select().eq('id', ordenId).single();
  if (!orden) throw new Error('Orden inexistente');
  if (orden.estado !== 'planificada' && orden.estado !== 'en_curso') {
    throw new Error(`La orden está ${orden.estado}`);
  }

  // Se toma la orden ANTES de empezar, no al final. El chequeo de estado y el
  // update de cierre estaban separados por decenas de escrituras: dos taps (o
  // dos pestañas) pasaban los dos y sumaban el doble de producto terminado
  // descontando los insumos una sola vez.
  const tomada = await db.from('orden_produccion')
    .update({ estado: 'en_curso' }).eq('id', ordenId).eq('estado', orden.estado);
  if (!tomada.length) throw new Error('La orden ya la está cerrando alguien más');

  /** Devuelve la orden a su estado anterior si se corta antes de escribir. */
  const soltar = async () => {
    await db.from('orden_produccion').update({ estado: orden.estado }).eq('id', ordenId);
  };

  const [items, productos, recetas, insumos] = await Promise.all([
    db.from('produccion_item').select().eq('orden_produccion_id', ordenId),
    db.from('producto').select(),
    db.from('receta_item').select(),
    db.from('insumo').select(),
  ]);

  const insumosPorId = new Map(insumos.map((i) => [i.id, i]));
  const recetasPorProducto = agrupar(recetas, 'producto_id');

  let lineas;
  try {
    lineas = items.map((it) => {
      const cantidad = cantidadesReales[it.id] != null
        ? Number(cantidadesReales[it.id])
        : it.cantidad_planificada;
      if (!(cantidad >= 0)) throw new Error('La cantidad producida no puede ser negativa');
      return { item: it, producto: productos.find((p) => p.id === it.producto_id), cantidad };
    }).filter((l) => l.producto);
  } catch (e) {
    await soltar();
    throw e;
  }

  // El insumo se descuenta por lo PLANIFICADO, no por lo que salió.
  // Si se planificaron 48 empanadas y salieron 36, la harina de las 48 se usó
  // igual: descontar por 36 dejaba media bolsa fantasma en el sistema cada
  // jornada, y con cantidad real 0 la orden cerraba sin descontar nada.
  const planificado = lineas.map((l) => ({
    producto: l.producto,
    cantidad: Math.max(l.cantidad, l.item.cantidad_planificada || 0),
  }));

  const consumo = calc.consumoTotal(planificado, recetasPorProducto, insumosPorId);

  /* --- el costo a congelar, antes de escribir nada --- */

  // Un snapshot en $0 es un margen falso del 100% que queda grabado para
  // siempre (regla 4): el mismo criterio que el insumo sin costo en calc.js.
  // Va antes de tocar el stock para que el error no deje la orden por la mitad.
  const sinCosto = [];
  const sinPago = [];
  for (const l of lineas) {
    let base;
    try {
      base = calc.costoProducto(
        recetasPorProducto.get(l.producto.id) || [], insumosPorId, l.producto.rinde_por_lote,
      );
    } catch { base = null; }
    if (base == null) base = calc.costoBase(l.producto);
    if (!(base > 0)) sinCosto.push(l.producto.nombre);

    // null es "nadie lo definió", no "se paga cero": un 0 tiene que ser a propósito
    l.pagoUnitario = l.producto.pago_produccion;
    if (l.cantidad > 0 && l.pagoUnitario == null) sinPago.push(l.producto.nombre);
    l.snapshot = base + (l.pagoUnitario || 0);
  }
  if (sinCosto.length) {
    await soltar();
    throw new Error(`Sin costo para congelar: ${sinCosto.join(', ')}. Cargá la receta o el costo manual`);
  }
  if (sinPago.length) {
    await soltar();
    throw new Error(`Falta definir cuánto se paga por unidad de: ${sinPago.join(', ')}`);
  }

  /* --- quién produjo cada línea, antes de escribir nada --- */

  try {
    await repartir(lineas, productoras);
  } catch (e) {
    await soltar();
    throw e;
  }

  /* --- a) insumos: primero verificar, después descontar --- */

  const faltantes = [...consumo.entries()]
    .map(([id, req]) => ({ insumo: insumosPorId.get(id), requerido: req, disponible: insumosPorId.get(id).stock_actual || 0 }))
    .filter((f) => f.requerido > f.disponible + 1e-9);

  if (faltantes.length && !motivoAjuste?.trim()) {
    await soltar();
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

    // Se relee justo antes de escribir: entre el select del principio y este
    // update pudo entrar una compra desde otra pestaña, y esto es un SET
    const actual = await db.from('insumo').select().eq('id', insumoId).single();

    await db.from('insumo')
      .update({ stock_actual: (actual?.stock_actual ?? insumo.stock_actual ?? 0) - cant })
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
    await db.from('produccion_item')
      .update({ cantidad_real: l.cantidad, costo_unitario_snapshot: l.snapshot })
      .eq('id', l.item.id);

    if (!l.cantidad) continue;

    const actualProd = await db.from('producto').select().eq('id', l.producto.id).single();

    await db.from('producto')
      .update({ stock_actual: (actualProd?.stock_actual ?? l.producto.stock_actual ?? 0) + l.cantidad })
      .eq('id', l.producto.id);

    await db.from('movimiento_stock_producto').insert({
      producto_id: l.producto.id,
      fecha: ahoraISO(),
      tipo: 'produccion',
      cantidad: l.cantidad,
      referencia_id: ordenId,
    });
  }

  /* --- d) lo que cobra cada productora --- */

  // Si cierra la administración, entra confirmado. Si cierra una trabajadora,
  // queda a confirmar, igual que el autoreporte de una jornada: es plata que
  // sale de la caja y la aprueba alguien más que quien la cobra.
  const confirmada = auth.puede('liquidar');
  const pagos = lineas.flatMap((l) => (l.reparto || []).map((r) => ({
    trabajadora_id: r.trabajadora_id,
    orden_produccion_id: ordenId,
    produccion_item_id: l.item.id,
    producto_id: l.producto.id,
    fecha: orden.fecha,
    cantidad: r.cantidad,
    pago_unitario: l.pagoUnitario || 0,     // congelado: si mañana sube, esto no cambia
    total: r.cantidad * (l.pagoUnitario || 0),
    origen_carga: confirmada ? 'admin' : 'autoreporte',
    confirmada,
    estado_pago: 'pendiente',
    fecha_pago: null,
  })));
  if (pagos.length) await db.from('pago_produccion').insert(pagos);

  // La mano de obra de la orden es lo que se paga por lo producido. Las
  // jornadas con tarifa son de antes del cambio y se suman por si quedó alguna
  const jornadas = await db.from('jornada').select().eq('orden_produccion_id', ordenId);
  const costoManoObra = pagos.reduce((a, p) => a + p.total, 0)
    + jornadas.filter((j) => j.confirmada).reduce((a, j) => a + (j.tarifa_aplicada || 0), 0);

  await db.from('orden_produccion').update({
    estado: 'cerrada',
    costo_insumos: costoInsumos,
    costo_mano_obra: costoManoObra,
    cerrada_at: ahoraISO(),
  }).eq('id', ordenId);

  return { costoInsumos, costoManoObra, ajustados: faltantes.length, pagos: pagos.length };
}

/**
 * Normaliza `productoras` y lo deja en cada línea como `reparto`:
 * [{ trabajadora_id, cantidad }] que suma exactamente la cantidad real.
 *
 * Una trabajadora solo puede cargarse a sí misma. Repartir una línea con una
 * compañera sería escribir plata a nombre de otra, y eso lo hace la
 * administración (el servidor tampoco se lo deja insertar).
 */
async function repartir(lineas, productoras) {
  const admin = auth.puede('liquidar');
  const propia = !admin ? auth.trabajadoraId : null;
  if (!admin && !propia) throw new Error('No se sabe quién está cerrando la orden');

  const trabajadoras = new Map((await db.from('trabajadora').select()).map((t) => [t.id, t]));

  for (const l of lineas) {
    if (!(l.cantidad > 0)) { l.reparto = []; continue; }

    let dato = typeof productoras === 'string' ? productoras : productoras?.[l.item.id];
    if (dato == null) dato = propia;
    if (dato == null) throw new Error(`Falta decir quién produjo ${l.producto.nombre}`);

    const reparto = (Array.isArray(dato) ? dato : [{ trabajadora_id: dato, cantidad: l.cantidad }])
      .map((r) => ({ trabajadora_id: r.trabajadora_id, cantidad: Number(r.cantidad) }))
      .filter((r) => r.cantidad !== 0);

    for (const r of reparto) {
      if (!trabajadoras.has(r.trabajadora_id)) throw new Error(`${l.producto.nombre}: esa trabajadora no existe`);
      if (!(r.cantidad > 0)) throw new Error(`${l.producto.nombre}: las cantidades repartidas tienen que ser mayores a cero`);
      if (!admin && r.trabajadora_id !== propia) {
        throw new Error('Solo podés cargar tu propia producción: lo de otra lo carga la administración');
      }
    }
    if (new Set(reparto.map((r) => r.trabajadora_id)).size !== reparto.length) {
      throw new Error(`${l.producto.nombre}: la misma persona aparece dos veces en el reparto`);
    }
    const suma = reparto.reduce((a, r) => a + r.cantidad, 0);
    if (Math.abs(suma - l.cantidad) > 1e-9) {
      throw new Error(`${l.producto.nombre}: salieron ${l.cantidad} y el reparto suma ${suma}`);
    }
    l.reparto = reparto;
  }
}

/**
 * Cuánto se le paga a quien produce una unidad de este producto.
 *
 * Es plata del equipo y también costo: entra en el costo efectivo, así que el
 * margen cambia en el acto y se avisa si quedó bajo el mínimo. Lo ya producido
 * no se toca: cada pago_produccion congeló el monto del día en que se cerró.
 */
export async function fijarPagoProduccion(productoId, monto) {
  auth.exigir('liquidar');

  const valor = Number(monto);
  if (monto === '' || monto == null || !(valor >= 0)) {
    throw new Error('El pago por unidad tiene que ser un número: cero o más');
  }
  const p = await db.from('producto').select().eq('id', productoId).single();
  if (!p) throw new Error('Producto inexistente');

  await db.from('producto').update({ pago_produccion: valor }).eq('id', productoId);

  const costo = calc.costoEfectivo({ ...p, pago_produccion: valor });
  const m = calc.margen(p.precio_venta || 0, costo);
  const flojo = p.precio_venta > 0 && calc.costoBase(p) > 0 && m.pct < calc.MARGEN_MINIMO;

  return {
    costo,
    margenPct: m.pct,
    alerta: flojo
      ? { producto: p.nombre, margenPct: m.pct, texto: `${p.nombre} bajó a ${m.pct.toFixed(1)}% de margen.` }
      : null,
  };
}

/**
 * Bloque "Quiénes trabajan" de la orden.
 *
 * DECISIÓN DE PRIVACIDAD — la regla 8 protege la tarifa, los días acumulados y
 * la liquidación de cada trabajadora. No dice que no puedan saber con quién
 * están cocinando: están todas en la misma cocina y se ven.
 *
 * El riesgo real es otro: si una trabajadora puede recorrer las órdenes viejas,
 * cada una con su fecha, reconstruye la asistencia completa de las demás. Eso sí
 * son "los días de otra".
 *
 * Por eso el corte es por estado de la orden, no por rol:
 *   - orden abierta  → se ven los nombres. Es la coordinación del día, que de
 *                      todos modos tienen delante de los ojos
 *   - orden cerrada  → el bloque desaparece para quien no sea admin. Ahí es
 *                      historial, y el historial es lo que permite reconstruir
 *
 * Asignar sigue siendo solo del admin: la trabajadora ve los nombres, no los toca.
 */
function bloqueEquipo(orden, asignadas) {
  const esAdmin = auth.puede('verEquipoCompleto');
  const cerrada = orden.estado === 'cerrada' || orden.estado === 'cancelada';

  if (!esAdmin && cerrada) return '';
  if (!state.trabajadoras.length) {
    return esAdmin
      ? '<div class="bloque"><div class="bloque__titulo">Quiénes trabajan</div>'
        + '<p class="faint" style="margin:0">No hay trabajadoras cargadas.</p></div>'
      : '';
  }

  if (esAdmin) {
    return `
      <div class="bloque">
        <div class="bloque__titulo">Quiénes trabajan</div>
        <div class="chips" id="o-equipo">
          ${state.trabajadoras.map((t) => `
            <button class="chip ${asignadas.has(t.id) ? 'sel' : ''}" data-trab="${t.id}">${ui.esc(t.nombre)}</button>
          `).join('')}
        </div>
        <p class="faint" style="margin:var(--sp-2) 0 0">Cada una suma su jornada del día con la tarifa congelada.</p>
      </div>`;
  }

  // Trabajadora, orden abierta: solo lectura y solo las asignadas
  const equipo = state.trabajadoras.filter((t) => asignadas.has(t.id));
  if (!equipo.length) return '';

  return `
    <div class="bloque">
      <div class="bloque__titulo">Quiénes trabajan hoy</div>
      <div class="chips">
        ${equipo.map((t) => `<span class="chip sel">${ui.esc(t.nombre)}</span>`).join('')}
      </div>
    </div>`;
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

export async function ajustarStockInsumo(insumoId, nuevoStock, motivo, referenciaId = null) {
  auth.exigir('cargarProduccion');
  if (!motivo?.trim()) throw new Error('El ajuste necesita un motivo');
  if (!(Number(nuevoStock) >= 0)) throw new Error('El stock no puede quedar negativo');
  const insumo = await db.from('insumo').select().eq('id', insumoId).single();
  if (!insumo) throw new Error('Insumo inexistente');

  const delta = Number(nuevoStock) - (insumo.stock_actual || 0);
  await db.from('insumo').update({ stock_actual: Number(nuevoStock) }).eq('id', insumoId);
  await db.from('movimiento_stock_insumo').insert({
    insumo_id: insumoId, fecha: ahoraISO(), tipo: 'ajuste', cantidad: delta, motivo: motivo.trim(),
    referencia_id: referenciaId,
  });
  return delta;
}

export async function ajustarStockProducto(productoId, nuevoStock, motivo, referenciaId = null) {
  auth.exigir('cargarProduccion');
  if (!motivo?.trim()) throw new Error('El ajuste necesita un motivo');
  if (!(Number(nuevoStock) >= 0)) throw new Error('El stock no puede quedar negativo');
  const producto = await db.from('producto').select().eq('id', productoId).single();
  if (!producto) throw new Error('Producto inexistente');

  const delta = Number(nuevoStock) - (producto.stock_actual || 0);
  await db.from('producto').update({ stock_actual: Number(nuevoStock) }).eq('id', productoId);
  await db.from('movimiento_stock_producto').insert({
    producto_id: productoId, fecha: ahoraISO(), tipo: 'ajuste', cantidad: delta, motivo: motivo.trim(),
    referencia_id: referenciaId,
  });
  return delta;
}

/**
 * Edita un insumo. Si cambia la unidad de medida, convierte el stock y el
 * costo en vez de dejar el número viejo con el significado nuevo.
 *
 * Pasar "Harina 000" de kg a g dejaba $1.200 por GRAMO y 25 gramos de stock:
 * la empanada pasaba a costar $50.217 y el margen a −6.177%. El costo por
 * unidad se mueve al revés que la cantidad — mil gramos por kilo significa
 * mil veces más cantidad y mil veces menos costo por unidad.
 */
export async function guardarInsumo(insumoId, datos) {
  auth.exigir('gestionarInsumos');

  const previo = await db.from('insumo').select().eq('id', insumoId).single();
  if (!previo) throw new Error('Insumo inexistente');

  const cambia = datos.unidad_medida && datos.unidad_medida !== previo.unidad_medida;

  if (cambia && !calc.sonCompatibles(previo.unidad_medida, datos.unidad_medida)) {
    throw new Error(
      `No se puede pasar de ${previo.unidad_medida} a ${datos.unidad_medida}: `
      + 'dalo de baja y cargá un insumo nuevo',
    );
  }

  const patch = { ...datos };
  if (cambia) {
    const factor = calc.convertir(1, previo.unidad_medida, datos.unidad_medida);
    patch.stock_actual = (previo.stock_actual || 0) * factor;
    patch.costo_unitario = (previo.costo_unitario || 0) / factor;
  }

  await db.from('insumo').update(patch).eq('id', insumoId);
  return recalcularCostos([insumoId]);
}

/** Reemplaza la receta completa de un producto y recalcula su costo. */
export async function guardarReceta(productoId, items, rindePorLote) {
  auth.exigir('gestionarInsumos');

  const rinde = Number(rindePorLote);
  if (!(rinde > 0)) throw new Error('El rinde por lote tiene que ser mayor a cero');

  // De la base y no de state: el importador crea insumos y arma la receta en la
  // misma pasada, y state.insumos todavía no los tiene
  const insumos = new Map((await db.from('insumo').select()).map((i) => [i.id, i]));
  for (const it of items) {
    const insumo = insumos.get(it.insumo_id);
    if (!insumo) throw new Error('Hay una línea sin insumo');
    if (!(Number(it.cantidad) > 0)) throw new Error(`Falta la cantidad de ${insumo.nombre}`);
    if (!calc.sonCompatibles(it.unidad_medida, insumo.unidad_medida)) {
      throw new Error(`${insumo.nombre} se mide en ${insumo.unidad_medida}: no se puede cargar en ${it.unidad_medida}`);
    }
    // Una merma de 900% multiplica el costo por diez; una negativa lo parte
    const merma = Number(it.merma_pct) || 0;
    if (merma < 0 || merma >= 100) {
      throw new Error(`La merma de ${insumo.nombre} tiene que estar entre 0 y 99%`);
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

/**
 * Alta de insumo. Nace con stock y costo en cero: los dos salen de la primera
 * compra, así el costo es el precio real que se pagó y no uno estimado.
 */
export async function crearInsumo({ nombre, categoria = 'Otros', unidad_medida, stock_minimo = 0, proveedor_habitual = null }) {
  auth.exigir('gestionarInsumos');

  nombre = nombre?.trim();
  if (!nombre) throw new Error('Falta el nombre del insumo');
  if (!calc.UNIDADES.includes(unidad_medida)) {
    throw new Error(`Unidad desconocida: ${unidad_medida}. Tiene que ser ${calc.UNIDADES.join(', ')}`);
  }

  const existentes = await db.from('insumo').select();
  if (existentes.some((i) => clave(i.nombre) === clave(nombre))) {
    throw new Error(`Ya hay un insumo que se llama ${nombre}`);
  }

  const un = state.unidadNegocio?.id ?? (await db.from('unidad_negocio').select().single())?.id;
  return db.from('insumo').insert({
    unidad_negocio_id: un,
    nombre, categoria, unidad_medida,
    stock_minimo: Number(stock_minimo) || 0,
    proveedor_habitual,
    costo_unitario: 0, stock_actual: 0, activo: true,
  });
}

/**
 * Alta de producto. Nace con stock cero y sin costo propio: el costo sale de
 * la receta (costo_calculado), no de un número estimado. Tampoco nace con pago
 * por producción: null es "nadie lo definió", y cerrarOrden no deja producirlo
 * hasta que alguien lo fije. Un 0 tiene que ser a propósito.
 *
 * El precio es lo que se le cobra al público: por eso pide editarPrecios y no
 * gestionarInsumos.
 */
export async function crearProducto({ nombre, categoria = 'Otros', unidad_venta = 'unidad', precio_venta, stock_minimo = 0 }) {
  auth.exigir('editarPrecios');

  nombre = nombre?.trim();
  if (!nombre) throw new Error('Falta el nombre del producto');
  const precio = Number(precio_venta);
  if (precio_venta === '' || precio_venta == null || !(precio >= 0)) {
    throw new Error(`${nombre}: el precio tiene que ser un número, cero o más`);
  }

  const existentes = await db.from('producto').select();
  if (existentes.some((p) => clave(p.nombre) === clave(nombre))) {
    throw new Error(`Ya hay un producto que se llama ${nombre}`);
  }

  const un = state.unidadNegocio?.id ?? (await db.from('unidad_negocio').select().single())?.id;
  return db.from('producto').insert({
    unidad_negocio_id: un,
    nombre,
    categoria: String(categoria || 'Otros').trim() || 'Otros',
    unidad_venta: String(unidad_venta || 'unidad').trim() || 'unidad',
    precio_venta: precio,
    costo_manual: null, costo_calculado: null, pago_produccion: null,
    stock_actual: 0,
    stock_minimo: Number(stock_minimo) || 0,
    rinde_por_lote: 1,
    activo: true,
  });
}

/**
 * Cambia el precio de venta y devuelve cómo quedó el margen.
 *
 * No toca ningún snapshot (regla 4): lo ya vendido conserva el precio con el
 * que se vendió en su pedido_item. El precio nuevo rige desde el próximo pedido.
 */
export async function guardarPrecio(productoId, precio) {
  auth.exigir('editarPrecios');

  const valor = Number(precio);
  if (precio === '' || precio == null || !(valor >= 0)) {
    throw new Error('El precio tiene que ser un número: cero o más');
  }
  const p = await db.from('producto').select().eq('id', productoId).single();
  if (!p) throw new Error('Producto inexistente');

  await db.from('producto').update({ precio_venta: valor }).eq('id', productoId);

  // El mismo criterio que fijarPagoProduccion: sin costo cargado no hay margen
  // que avisar, y un 100% inventado no es una buena noticia
  const costo = calc.costoEfectivo(p);
  const m = calc.margen(valor, costo);
  const flojo = valor > 0 && calc.costoBase(p) > 0 && m.pct < calc.MARGEN_MINIMO;

  return {
    precioPrevio: p.precio_venta,
    precio: valor,
    margenPct: calc.costoBase(p) > 0 ? m.pct : null,
    alerta: flojo
      ? { producto: p.nombre, margenPct: m.pct, texto: `${p.nombre} bajó a ${m.pct.toFixed(1)}% de margen.` }
      : null,
  };
}

/**
 * Mercadería que ya estaba en la cocina y no se compró esta semana: la harina
 * que quedó del receso, un maple de huevos que trajo alguien.
 *
 * Es un ajuste con costo, no una compra. Suma stock con su movimiento 'ajuste'
 * y motivo (regla 7) y mueve el costo por promedio ponderado igual que una
 * compra, pero NO genera egreso en caja: esa plata no salió esta semana, y
 * cargarla como compra la contaría en un cierre que no la gastó.
 *
 * `costoUnitario` viene en `unidadMedida` ($8 por g) y se pasa a la unidad del
 * insumo ($8.000 por kg): el valor total de lo cargado no cambia.
 */
export async function cargarStockInicial({ insumoId, cantidad, unidadMedida = null, costoUnitario, motivo }) {
  auth.exigir('gestionarInsumos');

  motivo = String(motivo || '').trim();
  if (!motivo) throw new Error('El stock inicial necesita un motivo');
  cantidad = Number(cantidad);
  const costo = Number(costoUnitario);
  if (!(cantidad > 0)) throw new Error('La cantidad tiene que ser mayor a cero');
  if (costoUnitario === '' || costoUnitario == null || !(costo >= 0)) {
    throw new Error('Falta el costo unitario o es negativo');
  }

  const insumo = await db.from('insumo').select().eq('id', insumoId).single();
  if (!insumo) throw new Error('Insumo inexistente');

  const cant = unidadMedida ? calc.convertir(cantidad, unidadMedida, insumo.unidad_medida) : cantidad;
  const costoUnit = (cantidad * costo) / cant;

  const stockPrevio = insumo.stock_actual || 0;
  const costoNuevo = calc.costoPonderado(stockPrevio, insumo.costo_unitario || 0, cant, costoUnit);

  await db.from('insumo').update({
    stock_actual: stockPrevio + cant,
    costo_unitario: costoNuevo,
  }).eq('id', insumoId);

  await db.from('movimiento_stock_insumo').insert({
    insumo_id: insumoId, fecha: ahoraISO(), tipo: 'ajuste', cantidad: cant, motivo,
    referencia_id: null,
  });

  const alertas = await recalcularCostos([insumoId]);
  return { cantidad: cant, costoPrevio: insumo.costo_unitario || 0, costoNuevo, alertas };
}

/** Un ajuste con la forma del importador. Las dos funciones de abajo hacen el trabajo. */
export async function ajustarStock({ tabla, id, cantidad_nueva, motivo }) {
  if (tabla === 'insumo') return ajustarStockInsumo(id, cantidad_nueva, motivo);
  if (tabla === 'producto') return ajustarStockProducto(id, cantidad_nueva, motivo);
  throw new Error(`No se ajusta stock de "${tabla}": tiene que ser insumo o producto`);
}

/**
 * Pone en cero todo el stock, insumos y producto terminado, con un ajuste por
 * cada fila que no estaba en cero. Es para volver de un receso: lo que dice el
 * sistema ya no es lo que hay en la heladera.
 *
 * No toca costo_unitario: el último costo conocido sigue siendo la mejor
 * referencia, y con stock en cero la próxima compra lo reemplaza entero
 * (costoPonderado). Tampoco toca caja: un ajuste mueve cantidades, no plata.
 */
export async function reiniciarStock(motivo) {
  auth.exigir('gestionarInsumos');
  if (!motivo?.trim()) throw new Error('El reinicio necesita un motivo');

  const [insumos, productos] = await Promise.all([db.from('insumo').select(), db.from('producto').select()]);
  let nInsumos = 0, nProductos = 0;

  // Todos los ajustes del reinicio comparten referencia: así se los encuentra
  // juntos después, y se distinguen de un ajuste suelto con el mismo motivo
  const referencia = crypto.randomUUID();

  for (const i of insumos) {
    if (!(i.stock_actual || 0)) continue;
    await ajustarStockInsumo(i.id, 0, motivo, referencia);
    nInsumos++;
  }
  for (const p of productos) {
    if (!(p.stock_actual || 0)) continue;
    await ajustarStockProducto(p.id, 0, motivo, referencia);
    nProductos++;
  }

  return { insumos: nInsumos, productos: nProductos, referencia };
}

/* ================================================================== */
/*  Importador semanal                                                 */
/* ================================================================== */

/** Para comparar nombres sin que una mayúscula o un espacio los separen. */
const clave = (s) => String(s ?? '').trim().toLocaleLowerCase('es');

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Busca una fila por id o por nombre. El JSON puede nombrar los insumos por su
 * nombre porque los insumos nuevos todavía no tienen id cuando se escribe.
 */
function resolver(filas, ref, que) {
  const id = ref[`${que}_id`];
  const nombre = ref[que];
  if (id) {
    const f = filas.find((x) => x.id === id);
    if (!f) throw new Error(`No existe el ${que} con id ${id}`);
    return f;
  }
  if (!nombre) throw new Error(`Falta el ${que} (por nombre o por ${que}_id)`);
  const hits = filas.filter((x) => clave(x.nombre) === clave(nombre));
  if (!hits.length) throw new Error(`No existe el ${que} "${nombre}"`);
  if (hits.length > 1) throw new Error(`Hay ${hits.length} ${que}s que se llaman "${nombre}": usá ${que}_id`);
  return hits[0];
}

/**
 * Valida una semana entera sin escribir nada.
 *
 * Simula en memoria lo que van a hacer las funciones de verdad, en el mismo
 * orden: el reinicio pone el stock en cero, las compras lo suben y mueven el
 * costo, las recetas reemplazan a las que había y las producciones consumen.
 * Así se detecta un faltante en la tercera producción antes de escribir la
 * primera compra.
 *
 * IndexedDB no da una transacción que abarque todas las tablas: si cargarSemana
 * fallara a mitad de camino quedarían compras con su egreso en caja y sin la
 * producción que les sigue. Por eso todo lo que puede fallar se mira acá.
 *
 * @returns {Object} el plan ya resuelto: ids en lugar de nombres, cantidades
 *                   en la unidad del insumo
 * @throws  Error con `.errores` — la lista completa, no solo el primero
 */
export async function validarSemana(semana) {
  const errores = [];
  const anotar = (donde, e) => errores.push(`${donde}: ${e.message || e}`);

  if (!semana || typeof semana !== 'object') throw new Error('La semana tiene que ser un objeto');

  const [insumosDb, productos, recetasDb, trabajadoras, clientes] = await Promise.all([
    db.from('insumo').select(),
    db.from('producto').select(),
    db.from('receta_item').select(),
    db.from('trabajadora').select(),
    db.from('cliente').select(),
  ]);

  // Copias: la simulación no puede tocar las filas que devolvió la base.
  // En las recetas simuladas `insumo_id` apunta al objeto insumo y no a su id,
  // porque los insumos nuevos todavía no tienen id
  const insumos = insumosDb.map((i) => ({ ...i }));
  const productosSim = productos.map((p) => ({ ...p }));
  const recetas = new Map();
  for (const [prodId, items] of agrupar(recetasDb, 'producto_id')) {
    recetas.set(prodId, items
      .map((it) => ({ ...it, insumo_id: insumos.find((i) => i.id === it.insumo_id) }))
      .filter((it) => it.insumo_id));
  }

  const plan = {
    reinicio: null, insumos_nuevos: [], productos_nuevos: [], precios: [], compras: [],
    stock_inicial: [], recetas: [], pagos: [], producciones: [], ventas: [],
  };

  /* --- reinicio --- */
  if (semana.reinicio) {
    if (!semana.reinicio.motivo?.trim()) errores.push('reinicio: falta el motivo');
    else plan.reinicio = { motivo: semana.reinicio.motivo.trim() };
    insumos.forEach((i) => { i.stock_actual = 0; });
    productosSim.forEach((p) => { p.stock_actual = 0; });
  }

  /* --- insumos nuevos --- */
  (semana.insumos_nuevos || []).forEach((n, k) => {
    const donde = `insumos_nuevos[${k}]`;
    const nombre = n?.nombre?.trim();
    if (!nombre) return errores.push(`${donde}: falta el nombre`);
    if (!calc.UNIDADES.includes(n.unidad_medida)) {
      return errores.push(`${donde} (${nombre}): unidad desconocida "${n.unidad_medida}"`);
    }
    if (insumos.some((i) => clave(i.nombre) === clave(nombre))) {
      return errores.push(`${donde}: ya existe un insumo "${nombre}"`);
    }
    const sim = { id: null, nombre, unidad_medida: n.unidad_medida, stock_actual: 0, costo_unitario: 0 };
    insumos.push(sim);
    plan.insumos_nuevos.push({ datos: { ...n, nombre }, sim });
  });

  /* --- productos nuevos --- */
  // Nacen sin id. Las recetas simuladas se guardan por id de producto, así que
  // cada uno lleva uno provisorio hasta que el alta le ponga el de verdad
  (semana.productos_nuevos || []).forEach((n, k) => {
    const donde = `productos_nuevos[${k}]`;
    const nombre = n?.nombre?.trim();
    if (!nombre) return errores.push(`${donde}: falta el nombre`);
    const precio = Number(n.precio_venta);
    if (n.precio_venta === '' || n.precio_venta == null || !(precio >= 0)) {
      return errores.push(`${donde} (${nombre}): falta el precio de venta o es negativo`);
    }
    if (productosSim.some((p) => clave(p.nombre) === clave(nombre))) {
      return errores.push(`${donde}: ya existe un producto "${nombre}"`);
    }
    const sim = {
      id: `nuevo:${k}`, nombre, precio_venta: precio, stock_actual: 0, rinde_por_lote: 1,
      costo_manual: null, costo_calculado: null, pago_produccion: null,
    };
    productosSim.push(sim);
    plan.productos_nuevos.push({ datos: { ...n, nombre, precio_venta: precio }, sim });
  });

  /* --- precios --- */
  (semana.precios || []).forEach((g, k) => {
    const donde = `precios[${k}]`;
    try {
      const producto = resolver(productosSim, g, 'producto');
      const precio = Number(g.precio_venta);
      if (g.precio_venta === '' || g.precio_venta == null || !(precio >= 0)) {
        throw new Error(`${producto.nombre}: precio_venta tiene que ser cero o más`);
      }
      producto.precio_venta = precio;
      plan.precios.push({ producto, precio });
    } catch (e) { anotar(donde, e); }
  });

  /* --- compras --- */
  (semana.compras || []).forEach((c, k) => {
    const donde = `compras[${k}]`;
    try {
      const insumo = resolver(insumos, c, 'insumo');
      const costoTotal = Number(c.costo_total);
      let cantidad = Number(c.cantidad);
      if (!(cantidad > 0)) throw new Error('la cantidad tiene que ser mayor a cero');
      if (!(costoTotal >= 0)) throw new Error('falta el costo total o es negativo');
      if (c.fecha != null && !FECHA_ISO.test(c.fecha)) throw new Error(`fecha "${c.fecha}" no es AAAA-MM-DD`);
      // "500 g" de un insumo que se mide en kg: se pasa a la unidad del insumo
      if (c.unidad_medida) cantidad = calc.convertir(cantidad, c.unidad_medida, insumo.unidad_medida);

      insumo.costo_unitario = calc.costoPonderado(insumo.stock_actual || 0, insumo.costo_unitario || 0, cantidad, costoTotal / cantidad);
      insumo.stock_actual = (insumo.stock_actual || 0) + cantidad;
      plan.compras.push({ insumo, cantidad, costo_total: costoTotal, proveedor: c.proveedor || '', fecha: c.fecha, medio: c.medio });
    } catch (e) { anotar(donde, e); }
  });

  /* --- stock inicial: lo que ya estaba en la cocina --- */
  (semana.stock_inicial || []).forEach((s0, k) => {
    const donde = `stock_inicial[${k}]`;
    try {
      const insumo = resolver(insumos, s0, 'insumo');
      const cantidad = Number(s0.cantidad);
      const costo = Number(s0.costo_unitario);
      if (!(cantidad > 0)) throw new Error('la cantidad tiene que ser mayor a cero');
      if (s0.costo_unitario === '' || s0.costo_unitario == null || !(costo >= 0)) {
        throw new Error('falta el costo unitario o es negativo');
      }
      if (!s0.motivo?.trim()) throw new Error(`${insumo.nombre}: falta el motivo`);
      // Igual que cargarStockInicial: el costo viene en la unidad que se indicó
      const cant = s0.unidad_medida ? calc.convertir(cantidad, s0.unidad_medida, insumo.unidad_medida) : cantidad;
      insumo.costo_unitario = calc.costoPonderado(insumo.stock_actual || 0, insumo.costo_unitario || 0, cant, (cantidad * costo) / cant);
      insumo.stock_actual = (insumo.stock_actual || 0) + cant;
      plan.stock_inicial.push({
        insumo, cantidad, unidad_medida: s0.unidad_medida || null, costo_unitario: costo, motivo: s0.motivo.trim(),
      });
    } catch (e) { anotar(donde, e); }
  });

  /* --- recetas --- */
  (semana.recetas || []).forEach((r, k) => {
    const donde = `recetas[${k}]`;
    try {
      const producto = resolver(productosSim, r, 'producto');
      const rinde = Number(r.rinde_por_lote ?? producto.rinde_por_lote);
      if (!(rinde > 0)) throw new Error(`${producto.nombre}: el rinde por lote tiene que ser mayor a cero`);
      if (!r.items?.length) throw new Error(`${producto.nombre}: la receta no tiene insumos`);

      const items = r.items.map((it, j) => {
        const insumo = resolver(insumos, it, 'insumo');
        const unidad = it.unidad_medida || insumo.unidad_medida;
        if (!(Number(it.cantidad) > 0)) throw new Error(`item ${j}: falta la cantidad de ${insumo.nombre}`);
        if (!calc.sonCompatibles(unidad, insumo.unidad_medida)) {
          throw new Error(`item ${j}: ${insumo.nombre} se mide en ${insumo.unidad_medida}, no en ${unidad}`);
        }
        const merma = Number(it.merma_pct) || 0;
        if (merma < 0 || merma >= 100) throw new Error(`item ${j}: la merma de ${insumo.nombre} tiene que estar entre 0 y 99%`);
        return { insumo, cantidad: Number(it.cantidad), unidad_medida: unidad, merma_pct: merma };
      });

      producto.rinde_por_lote = rinde;
      recetas.set(producto.id, items.map((it) => ({ ...it, insumo_id: it.insumo })));
      plan.recetas.push({ producto, rinde, items });
    } catch (e) { anotar(donde, e); }
  });

  /* --- cuánto se paga por unidad --- */
  (semana.pagos || []).forEach((g, k) => {
    const donde = `pagos[${k}]`;
    try {
      const producto = resolver(productosSim, g, 'producto');
      const monto = Number(g.pago_produccion);
      if (g.pago_produccion === '' || g.pago_produccion == null || !(monto >= 0)) {
        throw new Error(`${producto.nombre}: pago_produccion tiene que ser cero o más`);
      }
      producto.pago_produccion = monto;
      plan.pagos.push({ producto, monto });
    } catch (e) { anotar(donde, e); }
  });

  /* --- producciones --- */
  const porObjeto = new Map(insumos.map((i) => [i, i]));

  (semana.producciones || []).forEach((p, k) => {
    const donde = `producciones[${k}]`;
    try {
      if (p.fecha != null && !FECHA_ISO.test(p.fecha)) throw new Error(`fecha "${p.fecha}" no es AAAA-MM-DD`);
      if (!p.items?.length) throw new Error('la producción no tiene productos');

      // Quién produjo: por item, o una para toda la producción
      const general = (p.trabajadora || p.trabajadora_id) ? resolver(trabajadoras, p, 'trabajadora') : null;

      // Un producto aparece una sola vez por orden: si lo hicieron dos personas
      // vienen dos items y se juntan en una línea con su reparto
      const porProducto = new Map();
      p.items.forEach((it, j) => {
        const producto = resolver(productosSim, it, 'producto');
        const cantidad = Number(it.cantidad);
        if (!(cantidad > 0)) throw new Error(`item ${j}: la cantidad de ${producto.nombre} tiene que ser mayor a cero`);
        const quien = (it.trabajadora || it.trabajadora_id) ? resolver(trabajadoras, it, 'trabajadora') : general;
        if (!quien) throw new Error(`item ${j}: falta quién produjo ${producto.nombre} (trabajadora)`);

        if (!porProducto.has(producto)) porProducto.set(producto, { producto, cantidad: 0, reparto: new Map() });
        const linea = porProducto.get(producto);
        linea.cantidad += cantidad;
        linea.reparto.set(quien, (linea.reparto.get(quien) || 0) + cantidad);
      });
      const lineas = [...porProducto.values()];

      for (const l of lineas) {
        if (l.producto.pago_produccion == null) {
          throw new Error(`${l.producto.nombre}: falta cuánto se paga por unidad (sección pagos)`);
        }
      }

      const consumo = calc.consumoTotal(lineas, recetas, porObjeto);

      for (const l of lineas) {
        const receta = recetas.get(l.producto.id) || [];
        if (receta.length) {
          // Tira si un insumo de la receta sigue sin costo después de las compras
          calc.costoProducto(receta, porObjeto, l.producto.rinde_por_lote);
        } else if (!(l.producto.costo_manual > 0)) {
          throw new Error(`${l.producto.nombre} no tiene receta ni costo manual: no hay costo para congelar`);
        }
      }

      const faltantes = [...consumo.entries()].filter(([i, req]) => req > (i.stock_actual || 0) + 1e-9);
      if (faltantes.length && !p.motivo_ajuste?.trim()) {
        throw new Error('falta stock de ' + faltantes
          .map(([i, req]) => `${i.nombre} (hacen falta ${+req.toFixed(3)} ${i.unidad_medida}, hay ${+(i.stock_actual || 0).toFixed(3)})`)
          .join(', ') + '. Comprá lo que falta o poné motivo_ajuste');
      }

      for (const [i, req] of consumo) i.stock_actual = Math.max(i.stock_actual || 0, req) - req;
      lineas.forEach((l) => { l.producto.stock_actual = (l.producto.stock_actual || 0) + l.cantidad; });

      plan.producciones.push({ fecha: p.fecha, notas: p.notas || '', motivo_ajuste: p.motivo_ajuste?.trim() || null, lineas });
    } catch (e) { anotar(donde, e); }
  });

  /* --- ventas --- */
  // Ven el producto terminado que sumaron las producciones. Una venta entregada
  // descuenta stock; si lo deja negativo es que falta cargar producción, y en
  // una carga semanal eso es un error de la planilla, no una venta de mostrador
  const clientesSim = clientes.map((c) => ({ ...c }));
  const tiposCliente = TIPOS_CLIENTE.map((x) => x.id);
  const canales = CANALES.map((x) => x.id);
  const medios = MEDIOS.map((x) => x.id);

  (semana.ventas || []).forEach((v, k) => {
    const donde = `ventas[${k}]`;
    try {
      const nombre = v?.cliente?.nombre?.trim();
      if (!nombre) throw new Error('falta el nombre del cliente');
      const tipo = v.cliente.tipo || 'particular';
      if (!tiposCliente.includes(tipo)) throw new Error(`${nombre}: tipo de cliente "${tipo}" no existe (${tiposCliente.join(', ')})`);
      const canal = v.canal || 'otro';
      if (!canales.includes(canal)) throw new Error(`canal "${canal}" no existe (${canales.join(', ')})`);
      if (!FECHA_ISO.test(v.fecha_entrega || '')) throw new Error(`fecha_entrega "${v.fecha_entrega}" no es AAAA-MM-DD`);
      if (!v.items?.length) throw new Error(`${nombre}: la venta no tiene productos`);

      let cliente = clientesSim.find((c) => clave(c.nombre) === clave(nombre));
      if (!cliente) {
        cliente = { id: null, nombre, telefono: v.cliente.telefono || '', tipo, nuevo: true };
        clientesSim.push(cliente);
      }

      const items = v.items.map((it, j) => {
        const producto = resolver(productosSim, it, 'producto');
        const cantidad = Number(it.cantidad);
        if (!(cantidad > 0)) throw new Error(`item ${j}: la cantidad de ${producto.nombre} tiene que ser mayor a cero`);
        const precio = it.precio != null ? Number(it.precio) : producto.precio_venta;
        if (!(precio > 0)) throw new Error(`item ${j}: ${producto.nombre} no tiene precio de venta`);
        // El pedido congela costo (regla 4): sin receta ni costo manual quedaría
        // un margen del 100% grabado para siempre
        if (!recetas.get(producto.id)?.length && !(producto.costo_manual > 0) && !(producto.costo_calculado > 0)) {
          throw new Error(`item ${j}: ${producto.nombre} no tiene receta ni costo: no hay costo para congelar`);
        }
        return { producto, cantidad, precio, precioExplicito: it.precio != null };
      });
      const total = items.reduce((a, it) => a + it.cantidad * it.precio, 0);

      const cobros = (v.cobros || []).map((c, j) => {
        const monto = Number(c.monto);
        if (!(monto > 0)) throw new Error(`cobro ${j}: el monto tiene que ser mayor a cero`);
        const medio = c.medio || 'efectivo';
        if (!medios.includes(medio)) throw new Error(`cobro ${j}: medio "${medio}" no existe (${medios.join(', ')})`);
        const fecha = c.fecha || v.fecha_entrega;
        if (!FECHA_ISO.test(fecha)) throw new Error(`cobro ${j}: fecha "${fecha}" no es AAAA-MM-DD`);
        return { monto, medio, fecha };
      });
      const cobrado = cobros.reduce((a, c) => a + c.monto, 0);
      if (cobrado > total + 1e-6) throw new Error(`${nombre}: los cobros (${cobrado}) superan el total (${total})`);

      const entregado = !!v.entregado;
      if (entregado) {
        // Se mira por producto y no por línea: dos líneas del mismo suman
        const pide = new Map();
        items.forEach((it) => pide.set(it.producto, (pide.get(it.producto) || 0) + it.cantidad));
        const cortos = [...pide].filter(([p, q]) => q > (p.stock_actual || 0) + 1e-9);
        if (cortos.length) {
          throw new Error('deja stock negativo: ' + cortos
            .map(([p, q]) => `${p.nombre} (se venden ${q}, hay ${+(p.stock_actual || 0).toFixed(3)})`)
            .join(', ') + '. Falta cargar producción');
        }
        pide.forEach((q, p) => { p.stock_actual = (p.stock_actual || 0) - q; });
      }

      plan.ventas.push({
        cliente, canal, fecha_entrega: v.fecha_entrega, entregado, items, cobros, total,
        notas: String(v.notas || '').trim(),
      });
    } catch (e) { anotar(donde, e); }
  });

  if (errores.length) {
    const err = new Error(`La semana no se cargó. ${errores.length} problema${errores.length > 1 ? 's' : ''}:\n- ${errores.join('\n- ')}`);
    err.errores = errores;
    throw err;
  }
  return plan;
}

/**
 * Carga una semana de cocina de una sola vez, en este orden: reinicio de
 * stock, insumos nuevos, productos nuevos, precios, compras, stock inicial,
 * recetas, pagos, producciones y ventas. Es la puerta para cargar desde la
 * consola o desde otra sesión, sin pasar por las pantallas.
 *
 * Valida todo antes de escribir (validarSemana): si algo está mal no se
 * escribe nada y el error trae la lista completa.
 *
 * Cada paso llama a la misma función que usa la pantalla, así que las reglas
 * son las mismas: la compra genera su egreso en caja, la orden congela el
 * costo, el ajuste deja movimiento con motivo.
 *
 * Forma del JSON — los insumos y productos se nombran por `nombre` o por `_id`:
 *
 *   {
 *     reinicio:       { motivo },
 *     insumos_nuevos:   [{ nombre, categoria, unidad_medida, stock_minimo }],
 *     productos_nuevos: [{ nombre, categoria, unidad_venta, precio_venta, stock_minimo }],
 *     precios:          [{ producto, precio_venta }],
 *     compras:          [{ insumo, cantidad, unidad_medida?, costo_total, proveedor, fecha, medio? }],
 *     stock_inicial:    [{ insumo, cantidad, unidad_medida?, costo_unitario, motivo }],
 *     recetas:          [{ producto, rinde_por_lote, items: [{ insumo, cantidad, unidad_medida, merma_pct }] }],
 *     pagos:            [{ producto, pago_produccion }],
 *     producciones:     [{ fecha, notas, trabajadora?, motivo_ajuste?,
 *                          items: [{ producto, cantidad, trabajadora? }] }],
 *     ventas:           [{ cliente: { nombre, telefono?, tipo }, canal, fecha_entrega, entregado,
 *                          items: [{ producto, cantidad, precio? }],
 *                          cobros: [{ monto, medio, fecha }], notas? }]
 *   }
 *
 * `stock_inicial` es mercadería que ya estaba: suma stock y costo, sin caja.
 * En `ventas` el cliente se busca por nombre y se crea si no existe; una venta
 * entregada sin cobros queda impaga. Puede tener fecha pasada.
 *
 * `trabajadora` (o `trabajadora_id`) dice quién produjo: una para toda la
 * producción o una por item. Si un producto lo hicieron dos, van dos items.
 *
 * Con `{ soloValidar: true }` devuelve el plan sin escribir.
 */
export async function cargarSemana(semana, { soloValidar = false } = {}) {
  auth.exigir('gestionarInsumos');
  // Fijar pagos y cerrar órdenes a nombre de otras es de la administración
  if (semana?.pagos?.length || semana?.producciones?.length) auth.exigir('liquidar');
  // El precio es lo que paga el público: lo cambia quien puede cambiar precios
  if (semana?.productos_nuevos?.length || semana?.precios?.length) auth.exigir('editarPrecios');
  if (semana?.ventas?.length) { auth.exigir('cargarPedidos'); auth.exigir('gestionarClientes'); }
  if (!state.unidadNegocio) await state.cargar();

  const plan = await validarSemana(semana);
  if (soloValidar) return { plan };

  const resumen = {
    reinicio: null, insumos: [], productos: [], precios: [], compras: [], stockInicial: [], recetas: [],
    pagos: [], ordenes: [], ventas: null, alertas: [], egresos: [], stock: null,
  };

  if (plan.reinicio) resumen.reinicio = await reiniciarStock(plan.reinicio.motivo);

  // Los insumos nuevos de la simulación no tenían id: se lo pone el alta
  for (const n of plan.insumos_nuevos) {
    const creado = await crearInsumo(n.datos);
    n.sim.id = creado.id;     // las compras y recetas del plan apuntan a este objeto
    resumen.insumos.push(creado.nombre);
  }

  // Lo mismo con los productos: el id provisorio de la simulación se reemplaza
  for (const n of plan.productos_nuevos) {
    const creado = await crearProducto(n.datos);
    n.sim.id = creado.id;
    resumen.productos.push(creado.nombre);
  }

  for (const g of plan.precios) {
    const r = await guardarPrecio(g.producto.id, g.precio);
    resumen.precios.push({ producto: g.producto.nombre, precioPrevio: r.precioPrevio, precio: r.precio });
  }

  for (const c of plan.compras) {
    const r = await registrarCompra({
      insumoId: c.insumo.id, cantidad: c.cantidad, costoTotal: c.costo_total,
      proveedor: c.proveedor, ...(c.fecha && { fecha: c.fecha }), ...(c.medio && { medio: c.medio }),
    });
    resumen.compras.push({ insumo: c.insumo.nombre, cantidad: c.cantidad, costoPrevio: r.costoPrevio, costoNuevo: r.costoNuevo });
    resumen.egresos.push({ insumo: c.insumo.nombre, fecha: r.compra.fecha, monto: c.costo_total, referencia_id: r.compra.id });
  }

  for (const s0 of plan.stock_inicial) {
    const r = await cargarStockInicial({
      insumoId: s0.insumo.id, cantidad: s0.cantidad, unidadMedida: s0.unidad_medida,
      costoUnitario: s0.costo_unitario, motivo: s0.motivo,
    });
    resumen.stockInicial.push({ insumo: s0.insumo.nombre, cantidad: r.cantidad, costoNuevo: r.costoNuevo });
  }

  for (const r of plan.recetas) {
    await guardarReceta(r.producto.id, r.items.map((it) => ({
      insumo_id: it.insumo.id, cantidad: it.cantidad, unidad_medida: it.unidad_medida, merma_pct: it.merma_pct,
    })), r.rinde);
    resumen.recetas.push(r.producto.nombre);
  }

  for (const g of plan.pagos) {
    await fijarPagoProduccion(g.producto.id, g.monto);
    resumen.pagos.push({ producto: g.producto.nombre, pago_produccion: g.monto });
  }

  for (const p of plan.producciones) {
    const orden = await crearOrden({
      ...(p.fecha && { fecha: p.fecha }), notas: p.notas,
      items: p.lineas.map((l) => ({ producto_id: l.producto.id, cantidad: l.cantidad })),
    });
    const items = await db.from('produccion_item').select().eq('orden_produccion_id', orden.id);
    const productoras = Object.fromEntries(items.map((it) => {
      const l = p.lineas.find((x) => x.producto.id === it.producto_id);
      return [it.id, [...l.reparto].map(([t, cantidad]) => ({ trabajadora_id: t.id, cantidad }))];
    }));
    const cierre = await cerrarOrden(orden.id, {}, { motivoAjuste: p.motivo_ajuste, productoras });
    resumen.ordenes.push({ id: orden.id, fecha: orden.fecha, costoInsumos: cierre.costoInsumos, costoManoObra: cierre.costoManoObra, ajustados: cierre.ajustados });
  }

  // Cada venta pasa por las mismas funciones que la pantalla de Pedidos: el
  // pedido congela precio y costo, entregar descuenta stock y cobrar genera el
  // ingreso en caja. Entregada sin cobros queda impaga: suma a la rentabilidad
  // y no a la caja (regla 5)
  const ventas = { pedidos: [], totalVendido: 0, totalCobrado: 0, saldoPorCliente: {} };
  for (const v of plan.ventas) {
    if (!v.cliente.id) {
      // Puede haberlo creado una venta anterior de esta misma carga
      const ya = (await db.from('cliente').select()).find((c) => clave(c.nombre) === clave(v.cliente.nombre));
      v.cliente.id = ya?.id ?? (await guardarCliente({
        nombre: v.cliente.nombre, telefono: v.cliente.telefono, tipo: v.cliente.tipo,
      })).id;
    }
    const { pedido } = await crearPedido({
      clienteId: v.cliente.id, canal: v.canal,
      fechaPedido: v.fecha_entrega, fechaEntrega: v.fecha_entrega,
      items: v.items.map((it) => ({
        producto_id: it.producto.id, cantidad: it.cantidad, ...(it.precioExplicito && { precio: it.precio }),
      })),
      notas: v.notas,
    });
    if (v.entregado) await entregarPedido(pedido.id, { fecha: v.fecha_entrega });
    for (const c of v.cobros) await registrarCobro(pedido.id, c);

    const fin = await db.from('pedido').select().eq('id', pedido.id).single();
    const saldo = Math.max(0, (fin.total || 0) - (fin.monto_cobrado || 0));
    ventas.pedidos.push({
      id: fin.id, cliente: v.cliente.nombre, fecha: v.fecha_entrega, estado: fin.estado,
      total: fin.total, cobrado: fin.monto_cobrado || 0, saldo, estadoPago: fin.estado_pago,
    });
    ventas.totalVendido += fin.total || 0;
    ventas.totalCobrado += fin.monto_cobrado || 0;
    ventas.saldoPorCliente[v.cliente.nombre] = (ventas.saldoPorCliente[v.cliente.nombre] || 0) + saldo;
  }
  if (plan.ventas.length) resumen.ventas = ventas;

  // Las alertas finales, con todas las compras y recetas ya aplicadas
  resumen.alertas = await recalcularCostos();

  // Cómo quedó todo, para controlar contra la heladera
  const [insumosFin, productosFin] = await Promise.all([
    db.from('insumo').select().order('nombre'), db.from('producto').select().order('nombre'),
  ]);
  resumen.stock = {
    insumos: insumosFin.map((i) => ({ nombre: i.nombre, stock: i.stock_actual, unidad: i.unidad_medida, costo_unitario: i.costo_unitario })),
    productos: productosFin.map((p) => ({ nombre: p.nombre, stock: p.stock_actual })),
  };
  resumen.totalEgresos = resumen.egresos.reduce((a, e) => a + e.monto, 0);

  await state.invalidar();
  return resumen;
}

/* ================================================================== */
/*  Vista                                                              */
/* ================================================================== */

/**
 * Los cuatro segmentos. Compras y Recetas son plata: la trabajadora no los ve
 * (regla 8). Stock y Producción sí, porque cuenta lo que hay y cocina.
 */
const SUBVISTAS = [
  { id: 'stock',      etiqueta: 'Stock' },
  { id: 'compras',    etiqueta: 'Compras',    permiso: 'gestionarInsumos' },
  { id: 'recetas',    etiqueta: 'Recetas',    permiso: 'gestionarInsumos' },
  { id: 'produccion', etiqueta: 'Producción' },
];

/** Se recuerda entre renders: volver de un modal no te saca de la pestaña. */
let subvista = 'stock';

const verCostos = () => auth.puede('verCostos');
const gestiona = () => auth.puede('gestionarInsumos');

export async function render(vista) {
  const visibles = SUBVISTAS.filter((s) => !s.permiso || auth.puede(s.permiso));
  // Si cambió la sesión, la pestaña recordada puede no corresponderle al rol nuevo
  if (!visibles.some((s) => s.id === subvista)) subvista = visibles[0].id;

  vista.innerHTML = `
    <div class="between" style="margin-bottom:var(--sp-4)">
      <h1 style="margin:0">Producción</h1>
    </div>
    <div class="subnav" id="subnav">
      ${visibles.map((s) => `
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
  if (subvista === 'compras') return pantallaCompras(cont);
  if (subvista === 'recetas') return pantallaRecetas(cont);
  if (subvista === 'produccion') return pantallaOrdenes(cont);
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

/**
 * Cablea un botón de guardar deshabilitándolo mientras corre.
 *
 * Un doble tap dispara dos transacciones en paralelo, y las dos leen antes de
 * que ninguna escriba. En el editor de recetas eso guardaba la receta dos
 * veces y duplicaba el costo del producto — que después se congela en los
 * snapshots y ya no se puede corregir sin tocar la base a mano.
 */
function alGuardar(btn, fn, textoOcupado = 'Guardando…') {
  if (!btn) return;
  const original = btn.textContent;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = textoOcupado;
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

/* ------------------------------------------------------------------ */
/*  1 · Stock — insumos y producto terminado                           */
/* ------------------------------------------------------------------ */

async function pantallaStock(cont) {
  const insumos = state.insumos.filter((i) => i.activo !== false);
  const productos = state.productos.filter((p) => p.activo);
  const bajos = insumos.filter((i) => (i.stock_actual || 0) <= (i.stock_minimo || 0)).length;
  const valor = productos.reduce((a, p) => a + (p.stock_actual || 0) * calc.costoEfectivo(p), 0);

  cont.innerHTML = `
    <h2 style="margin:0 0 var(--sp-3)">Producto terminado</h2>
    ${productos.length ? `
      ${verCostos() ? `
        <div class="stat" style="margin-bottom:var(--sp-3)">
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
      <p class="faint" style="margin:var(--sp-2) 0 0">Tocá un producto para ajustar lo que hay de verdad.</p>
    ` : '<p class="faint">Todavía no hay productos.</p>'}

    <h2 style="margin:var(--sp-6) 0 var(--sp-3)">Insumos</h2>
    ${insumos.length ? `
      ${bajos ? `<div class="alerta alerta--warn">${bajos === 1
          ? 'Hay 1 insumo en el mínimo o por debajo.'
          : `Hay ${bajos} insumos en el mínimo o por debajo.`}</div>` : ''}
      ${porCategoria(insumos).map(([cat, filas]) => `
        <div class="categoria-titulo">${ui.esc(cat || 'Sin categoría')}</div>
        <div class="lista">${filas.map(filaInsumo).join('')}</div>
      `).join('')}
    ` : ui.vacio({
      modulo: 'produccion', icono: '\u{1F9C2}', titulo: 'Sin insumos cargados',
      texto: 'Cargá la harina, la carne y el resto con su costo real. De ahí sale el costo de cada producto.',
      fase: gestiona() ? '' : 'Lo carga la administración',
    })}

    ${gestiona() ? `
      <div class="stack" style="margin-top:var(--sp-6)">
        <button class="btn btn--block" id="st-nuevo">Nuevo insumo</button>
        <button class="btn btn--danger btn--block" id="st-reiniciar">Reiniciar stock</button>
      </div>` : ''}`;

  cont.querySelectorAll('[data-insumo]').forEach((el) =>
    el.addEventListener('click', () => modalAccionesInsumo(el.dataset.insumo)));

  cont.querySelectorAll('[data-stock]').forEach((el) => el.addEventListener('click', () => {
    const p = state.productoPorId(el.dataset.stock);
    modalAjuste({
      titulo: `Ajustar ${p.nombre}`,
      actual: `${p.stock_actual || 0} ${p.unidad_venta === 'unidad' ? 'unidades' : p.unidad_venta}`,
      valor: p.stock_actual || 0,
      onGuardar: (nuevo, motivo) => ajustarStockProducto(p.id, nuevo, motivo),
    });
  }));

  cont.querySelector('#st-nuevo')?.addEventListener('click', () => modalInsumo());
  cont.querySelector('#st-reiniciar')?.addEventListener('click', modalReiniciarStock);
}

/**
 * Pone todo en cero con un motivo escrito. Es para volver de un receso: lo que
 * dice el sistema ya no es lo que hay en la heladera.
 */
function modalReiniciarStock() {
  const nI = state.insumos.filter((i) => i.stock_actual).length;
  const nP = state.productos.filter((p) => p.stock_actual).length;
  if (!nI && !nP) return ui.toast('Todo el stock ya está en cero');

  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

  ui.abrirModal(`
    <h3>Reiniciar stock</h3>
    <p class="dim" style="margin-top:calc(var(--sp-2) * -1)">
      Pone en cero ${plural(nI, 'insumo', 'insumos')} y ${plural(nP, 'producto', 'productos')}.
      Cada uno queda con su ajuste y este motivo. No toca la caja ni los costos.</p>
    <div class="stack" style="margin-top:var(--sp-4)">
      <div class="field">
        <label for="rs-motivo">Motivo</label>
        <input class="input" id="rs-motivo" placeholder="Vuelta del receso, conteo en cero…">
      </div>
      <button class="btn btn--danger btn--block" id="rs-ok">Poner todo en cero</button>
      <button class="btn btn--block" data-close>Cancelar</button>
    </div>
  `, (root) => {
    alGuardar(root.querySelector('#rs-ok'), async () => {
      try {
        const r = await reiniciarStock(root.querySelector('#rs-motivo').value);
        ui.cerrarModal();
        await refrescar();
        ui.toast(`Stock en cero · ${plural(r.insumos, 'insumo', 'insumos')} y ${plural(r.productos, 'producto', 'productos')}`);
      } catch (e) {
        ui.toast(e.message || 'No se pudo reiniciar', true);
      }
    }, 'Reiniciando…');
  });
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
    root.querySelector('#a-compra')?.addEventListener('click', () => hojaCompra({ insumoId: i.id }));
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
    alGuardar(root.querySelector('#f-guardar'), async () => {
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
          await crearInsumo(datos);
        } else {
          await guardarInsumo(insumo.id, datos);
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

/* ------------------------------------------------------------------ */
/*  2 · Compras                                                        */
/* ------------------------------------------------------------------ */

async function pantallaCompras(cont) {
  const desde = hoyISO(ui.inicioSemana());
  const hasta = hoyISO(ui.finSemana());
  const compras = (await db.from('compra_insumo').select().gte('fecha', desde).lte('fecha', hasta))
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || String(b.created_at).localeCompare(String(a.created_at)));
  const total = compras.reduce((a, c) => a + (c.costo_total || 0), 0);

  cont.innerHTML = `
    <button class="btn btn--primary btn--block" data-accent="produccion" id="cp-nueva">Registrar compra</button>

    <div class="between" style="margin:var(--sp-5) 0 var(--sp-3)">
      <span class="dim">${ui.rangoSemana()}</span>
      ${compras.length ? `<b class="num">${ui.money(total)}</b>` : ''}
    </div>

    ${compras.length ? `<div class="lista">${compras.map((c) => {
      const i = state.insumoPorId(c.insumo_id);
      return `
        <div class="fila">
          <div class="fila__main">
            <div class="fila__titulo">${ui.esc(i?.nombre || 'Insumo borrado')}</div>
            <div class="fila__meta">
              <span class="num">${ui.cantidad(c.cantidad, i?.unidad_medida)}</span>
              <span class="dim">·</span>${ui.fecha(c.fecha)}
              ${c.proveedor ? `<span class="dim">·</span>${ui.esc(c.proveedor)}` : ''}
            </div>
          </div>
          <div class="fila__lado"><span class="num">${ui.money(c.costo_total)}</span></div>
        </div>`;
    }).join('')}</div>`
    : '<p class="faint" style="margin:0">Esta semana no hay compras cargadas.</p>'}`;

  cont.querySelector('#cp-nueva').addEventListener('click', () => hojaCompra());
}

/**
 * La hoja de compra. Se abre desde Compras (eligiendo el insumo) o desde la
 * ficha de un insumo en Stock (ya elegido).
 *
 * El insumo se busca escribiendo; si no existe se da de alta al vuelo, porque
 * la compra se carga con el ticket en la mano y no hay que ir a otra pantalla.
 * La cantidad puede ir en otra unidad de la misma familia: 500 g de algo que se
 * mide en kg se guarda como 0,5 kg.
 */
function hojaCompra({ insumoId = null } = {}) {
  let sel = insumoId ? state.insumoPorId(insumoId) : null;
  let nuevo = null;            // nombre del insumo a crear, si no existe
  let medio = 'efectivo';

  ui.abrirModal(`
    <h3>Registrar compra</h3>
    <div class="stack" style="margin-top:var(--sp-4)">
      <div id="hc-insumo"></div>
      <div class="row" id="hc-alta" hidden>
        <div class="field grow">
          <label for="hc-cat">Categoría</label>
          <select class="input" id="hc-cat">${CATEGORIAS_INSUMO.map((c) => `<option>${c}</option>`).join('')}</select>
        </div>
        <div class="field grow">
          <label for="hc-base">Se mide en</label>
          <select class="input" id="hc-base">${calc.UNIDADES.map((u) => `<option>${u}</option>`).join('')}</select>
        </div>
      </div>
      <div class="row">
        <div class="field grow">
          <label for="hc-cant">Cantidad</label>
          <input class="input" id="hc-cant" type="number" inputmode="decimal" min="0" step="any" placeholder="0">
        </div>
        <div class="field">
          <label for="hc-um">Unidad</label>
          <select class="input" id="hc-um"></select>
        </div>
      </div>
      <div class="field">
        <label for="hc-total">Costo total</label>
        <input class="input" id="hc-total" type="number" inputmode="decimal" min="0" step="any" placeholder="0">
      </div>
      <div class="calculo" id="hc-calc">—</div>
      <div class="row">
        <div class="field grow">
          <label for="hc-prov">Proveedor</label>
          <input class="input" id="hc-prov" placeholder="opcional">
        </div>
        <div class="field grow">
          <label for="hc-fecha">Fecha</label>
          <input class="input" id="hc-fecha" type="date" value="${hoyISO()}">
        </div>
      </div>
      <div class="medios" id="hc-medios" style="margin:0">
        ${MEDIOS.map((m) => `
          <button class="medio ${m.id === medio ? 'sel' : ''}" data-medio="${m.id}">
            <svg viewBox="0 0 24 24">${m.svg}</svg>${m.etiqueta}
          </button>`).join('')}
      </div>
      <p class="faint" style="margin:0">Se descuenta solo de la caja como egreso.</p>
      <button class="btn btn--primary btn--block" data-accent="produccion" id="hc-guardar">Registrar compra</button>
    </div>
  `, (root) => {
    const $ = (q) => root.querySelector(q);
    const cant = $('#hc-cant'), total = $('#hc-total'), um = $('#hc-um'), salida = $('#hc-calc');

    /** La unidad en la que se guarda: la del insumo, o la elegida para el nuevo. */
    const base = () => sel?.unidad_medida || (nuevo ? $('#hc-base').value : null);

    function pintarUnidades() {
      const b = base();
      const previa = um.value;
      const opciones = b ? calc.unidadesCompatibles(b) : calc.UNIDADES;
      um.innerHTML = opciones.map((u) => `<option ${u === (opciones.includes(previa) ? previa : b) ? 'selected' : ''}>${u}</option>`).join('');
    }

    function pintarInsumo() {
      const caja = $('#hc-insumo');
      $('#hc-alta').hidden = !nuevo;

      if (sel || nuevo) {
        caja.innerHTML = `
          <div class="between">
            <div style="min-width:0">
              <div class="dim" style="font-size:.78rem">${nuevo ? 'Insumo nuevo' : 'Insumo'}</div>
              <b>${ui.esc(sel?.nombre || nuevo)}</b>
              ${sel ? `<span class="faint num"> · hay ${ui.cantidad(sel.stock_actual || 0, sel.unidad_medida)}</span>` : ''}
            </div>
            ${insumoId ? '' : '<button class="btn btn--ghost" id="hc-cambiar">Cambiar</button>'}
          </div>`;
        $('#hc-cambiar')?.addEventListener('click', () => { sel = null; nuevo = null; pintarInsumo(); });
        if (sel && !$('#hc-prov').value) $('#hc-prov').value = sel.proveedor_habitual || '';
      } else {
        caja.innerHTML = `
          <div class="field">
            <label for="hc-buscar">Insumo</label>
            <input class="input" id="hc-buscar" placeholder="Buscá o escribí uno nuevo" autocomplete="off">
          </div>
          <div class="chips" id="hc-res" style="margin-top:var(--sp-2)"></div>`;
        const buscar = $('#hc-buscar');
        const pintarResultados = () => {
          const q = buscar.value.trim();
          const k = q.toLocaleLowerCase('es');
          const hits = state.insumos
            .filter((i) => i.activo !== false && i.nombre.toLocaleLowerCase('es').includes(k))
            .slice(0, 12);
          const exacto = hits.some((i) => i.nombre.toLocaleLowerCase('es') === k);
          $('#hc-res').innerHTML = hits.map((i) => `<button class="chip" data-id="${i.id}">${ui.esc(i.nombre)}</button>`).join('')
            + (q && !exacto ? `<button class="chip" data-crear>+ Crear «${ui.esc(q)}»</button>` : '');
        };
        buscar.addEventListener('input', pintarResultados);
        $('#hc-res').addEventListener('click', (e) => {
          const chip = e.target.closest('.chip');
          if (!chip) return;
          if (chip.dataset.id) sel = state.insumoPorId(chip.dataset.id);
          else nuevo = buscar.value.trim();
          pintarInsumo();
          cant.focus();
        });
        pintarResultados();
      }
      pintarUnidades();
      preview();
    }

    function preview() {
      const b = base();
      const c = Number(cant.value), t = Number(total.value);
      if (!b || !(c > 0) || !(total.value !== '' && t >= 0)) { salida.textContent = '—'; return; }
      const enBase = calc.convertir(c, um.value, b);
      const unit = t / enBase;
      const previo = sel?.costo_unitario || 0;
      const costoNuevo = calc.costoPonderado(sel?.stock_actual || 0, previo, enBase, unit);
      salida.innerHTML = `
        <div>Pagás <b class="num">${ui.money(unit)}</b> por ${ui.esc(b)}</div>
        ${sel ? `<div class="faint">El costo del insumo queda en
          <b class="num">${ui.money(costoNuevo)}</b>${previo ? ` (venía de ${ui.money(previo)})` : ''}</div>` : ''}`;
    }

    [cant, total, um].forEach((el) => el.addEventListener('input', preview));
    $('#hc-base').addEventListener('change', () => { pintarUnidades(); preview(); });

    $('#hc-medios').addEventListener('click', (e) => {
      const b = e.target.closest('[data-medio]');
      if (!b) return;
      medio = b.dataset.medio;
      root.querySelectorAll('[data-medio]').forEach((x) => x.classList.toggle('sel', x === b));
    });

    alGuardar($('#hc-guardar'), async () => {
      if (!sel && !nuevo) return ui.toast('Elegí el insumo', true);
      if (!(Number(cant.value) > 0)) return ui.toast('Falta la cantidad', true);
      if (total.value === '' || !(Number(total.value) >= 0)) return ui.toast('Falta el costo total', true);

      try {
        if (nuevo) {
          // Se crea recién al guardar. Si después falla la compra, el insumo ya
          // queda elegido para reintentar sin duplicarlo
          sel = await crearInsumo({ nombre: nuevo, categoria: $('#hc-cat').value, unidad_medida: $('#hc-base').value });
          nuevo = null;
          await state.cargar();
        }
        const { alertas, costoNuevo } = await registrarCompra({
          insumoId: sel.id,
          cantidad: calc.convertir(Number(cant.value), um.value, sel.unidad_medida),
          costoTotal: total.value,
          proveedor: $('#hc-prov').value.trim(),
          fecha: $('#hc-fecha').value || hoyISO(),
          medio,
        });
        ui.cerrarModal();
        await refrescar();
        if (alertas.length) modalAlertasMargen(alertas);
        else ui.toast(`Compra registrada · ${ui.money(costoNuevo)} por ${ui.unidadCorta(sel.unidad_medida)}`);
      } catch (err) {
        console.error(err);
        pintarInsumo();
        ui.toast(err.message || 'No se pudo registrar la compra', true);
      }
    });

    pintarInsumo();
    if (!sel) $('#hc-buscar')?.focus();
  });
}

/** El aviso del PDR §4.1: qué producto quedó flojo y cuánto. */
function modalAlertasMargen(alertas, titulo = 'Compra registrada') {
  if (!verCostos()) return ui.toast(titulo);

  const soloErrores = alertas.every((a) => a.error);

  ui.abrirModal(`
    <h3>${ui.esc(titulo)}</h3>
    <p class="dim" style="margin-top:calc(var(--sp-2) * -1)">${soloErrores
      ? 'Falta cargar algo para poder costear:'
      : 'Subió un costo y hay productos para revisar:'}</p>
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
        <input class="input" id="aj-cant" type="number" inputmode="decimal" step="any" min="0" value="${valor}">
      </div>
      <div class="field">
        <label for="aj-motivo">Motivo</label>
        <input class="input" id="aj-motivo" placeholder="Se rompió, se contó mal, sobró de ayer…">
      </div>
      <p class="faint" style="margin:0">Todo ajuste queda registrado con su motivo.</p>
      <button class="btn btn--primary btn--block" data-accent="produccion" id="aj-guardar">Guardar ajuste</button>
    </div>
  `, (root) => {
    alGuardar(root.querySelector('#aj-guardar'), async () => {
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
/*  3 · Recetas                                                        */
/* ------------------------------------------------------------------ */

async function pantallaRecetas(cont) {
  const productos = state.productos.filter((p) => p.activo);
  const recetas = agrupar(await db.from('receta_item').select(), 'producto_id');

  // El alta pide precio, y el precio es de quien puede cambiar precios
  const puedeAlta = auth.puede('editarPrecios');

  if (!productos.length) {
    cont.innerHTML = ui.vacio({
      modulo: 'produccion', icono: '\u{1F4D6}', titulo: 'Sin productos',
      texto: 'Primero tienen que existir los productos para poder darles receta.',
    });
    if (puedeAlta) fab(cont, modalNuevoProducto, 'Nuevo producto');
    return;
  }

  cont.innerHTML = `
    <p class="faint" style="margin:0 0 var(--sp-3)">
      Qué lleva cada producto por lote.${verCostos() ? ' De acá sale el costo unitario.' : ''}
    </p>
    <div class="lista">${productos.map((p) => filaReceta(p, recetas.get(p.id) || [])).join('')}</div>`;

  cont.querySelectorAll('[data-receta]').forEach((el) =>
    el.addEventListener('click', () => editorReceta(el.dataset.receta, recetas.get(el.dataset.receta) || [])));

  if (puedeAlta) fab(cont, modalNuevoProducto, 'Nuevo producto');
}

/**
 * Alta de producto. Pide lo mínimo para que exista: nombre, rubro y precio.
 * El costo y la paga salen de la receta, así que al guardar se abre el editor
 * de receta del producto recién creado: es el paso que sigue siempre.
 */
function modalNuevoProducto() {
  const rubros = [...new Set(state.productos.map((p) => p.categoria).filter(Boolean))].sort();

  ui.abrirModal(`
    <h3>Nuevo producto</h3>
    <div class="stack">
      <div class="field">
        <label for="np-nombre">Nombre</label>
        <input class="input" id="np-nombre" autocomplete="off" placeholder="Empanada de roquefort">
      </div>
      <div class="field">
        <label for="np-rubro">Rubro</label>
        <input class="input" id="np-rubro" list="np-rubros" autocomplete="off" placeholder="Empanadas">
        <datalist id="np-rubros">${rubros.map((r) => `<option value="${ui.esc(r)}">`).join('')}</datalist>
      </div>
      <div class="row">
        <div class="field grow">
          <label for="np-precio">Precio de venta</label>
          <input class="input" id="np-precio" type="number" inputmode="decimal" step="any" min="0">
        </div>
        <div class="field grow">
          <label for="np-minimo">Stock mínimo</label>
          <input class="input" id="np-minimo" type="number" inputmode="numeric" min="0" value="0">
        </div>
      </div>
      <p class="faint" style="margin:0">Nace sin stock y sin costo. Después de guardarlo
        se abre su receta: de ahí sale el costo y lo que se paga por unidad.</p>
      <p class="faint" id="np-error" style="color:var(--danger);margin:0"></p>
      <button class="btn btn--primary btn--block" data-accent="produccion" id="np-ok">Guardar producto</button>
    </div>
  `, (root) => {
    alGuardar(root.querySelector('#np-ok'), async () => {
      const error = root.querySelector('#np-error');
      error.textContent = '';
      try {
        const creado = await crearProducto({
          nombre: root.querySelector('#np-nombre').value,
          categoria: root.querySelector('#np-rubro').value || 'Otros',
          precio_venta: root.querySelector('#np-precio').value,
          stock_minimo: root.querySelector('#np-minimo').value,
        });
        ui.cerrarModal();
        await refrescar();
        ui.toast(`${creado.nombre} creado`);
        editorReceta(creado.id, []);
      } catch (e) {
        error.textContent = e.message;
      }
    });
  });
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
          ${verCostos() ? (p.pago_produccion == null
            ? '<span class="dim">·</span><span class="danger">sin paga</span>'
            : `<span class="dim">·</span>paga <span class="num">${ui.money(p.pago_produccion)}</span>`) : ''}
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
  const editaPrecio = auth.puede('editarPrecios');

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
      <p class="dim">Todavía no hay insumos cargados. Registrá una compra en la
      pestaña Compras y volvé a entrar acá.</p>
      <button class="btn btn--block" data-close>Cerrar</button>`);
  }

  ui.abrirModal(`
    <h3>${ui.esc(p.nombre)}</h3>
    ${editaPrecio ? `
      <div class="field" style="margin-bottom:var(--sp-4)">
        <label for="r-precio">Precio de venta</label>
        <input class="input" id="r-precio" type="number" inputmode="decimal" step="any" min="0"
               value="${p.precio_venta ?? ''}">
        <span class="faint">Rige desde el próximo pedido: lo ya vendido conserva su precio.</span>
      </div>` : ''}
    <div class="field" style="margin-bottom:var(--sp-4)">
      <label for="r-rinde">Una vuelta de receta rinde</label>
      <input class="input" id="r-rinde" type="number" inputmode="numeric" min="1" value="${rinde}" ${soloLectura ? 'disabled' : ''}>
    </div>
    <div class="field" style="margin-bottom:var(--sp-4)">
      <label for="r-pago">Se le paga a quien lo produce, por unidad</label>
      <input class="input" id="r-pago" type="number" inputmode="decimal" step="any" min="0"
             placeholder="Sin definir" value="${p.pago_produccion ?? ''}" ${soloLectura ? 'disabled' : ''}>
      <span class="faint">Es costo: entra en el margen. Sin definir, la orden de este producto no cierra.</span>
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

    const campoPago = root.querySelector('#r-pago');
    const pagoActual = () => (campoPago.value === '' ? null : Number(campoPago.value));
    const campoPrecio = root.querySelector('#r-precio');
    const precioActual = () => (campoPrecio && campoPrecio.value !== '' ? Number(campoPrecio.value) : (p.precio_venta || 0));

    function pintarCosto() {
      if (!verCostos()) { salida.innerHTML = '<span class="faint">Merma en % · el costo lo ve la administración</span>'; return; }

      // Sin receta, los materiales son el costo manual
      let materiales;
      if (lineas.length) {
        try {
          materiales = calc.costoProducto(lineas, state.insumosMap, rinde);
        } catch (e) {
          salida.innerHTML = `<span class="danger">${ui.esc(e.message)}</span>`;
          return;
        }
      } else {
        materiales = p.costo_manual || 0;
        if (!materiales) { salida.innerHTML = '<span class="faint">Agregá insumos para ver el costo.</span>'; return; }
      }

      const paga = pagoActual() || 0;
      const costo = materiales + paga;
      const precio = precioActual();
      const m = calc.margen(precio, costo);
      const flojo = precio > 0 && m.pct < calc.MARGEN_MINIMO;
      salida.innerHTML = `
        <div>Cuesta <b class="num">${ui.money(costo)}</b> por unidad</div>
        <div class="faint">Materiales <span class="num">${ui.money(materiales)}</span>${lineas.length ? '' : ' (costo manual)'}
          + paga <span class="num">${ui.money(paga)}</span></div>
        ${precio > 0 ? `<div class="faint">Se vende a <span class="num">${ui.money(precio)}</span> ·
          margen <b class="num ${flojo ? 'danger' : ''}">${ui.pct(m.pct)}</b></div>` : ''}`;
    }

    campoPago.addEventListener('input', pintarCosto);
    campoPrecio?.addEventListener('input', pintarCosto);

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

    alGuardar(root.querySelector('#r-guardar'), async () => {
      try {
        // El precio primero: así la alerta de margen de la receta ya lo usa
        if (campoPrecio && campoPrecio.value !== '' && Number(campoPrecio.value) !== p.precio_venta) {
          await guardarPrecio(productoId, campoPrecio.value);
        }
        const alertas = await guardarReceta(productoId, lineas, rinde);
        // La paga va aparte: es plata del equipo, con su propio permiso
        const paga = pagoActual();
        if (paga != null && paga !== p.pago_produccion) {
          const { alerta } = await fijarPagoProduccion(productoId, paga);
          if (alerta && !alertas.some((a) => a.producto === alerta.producto)) alertas.push(alerta);
        }
        ui.cerrarModal();
        await refrescar();
        if (alertas.length) modalAlertasMargen(alertas, 'Receta guardada');
        else ui.toast('Receta guardada');
      } catch (e) {
        ui.toast(e.message || 'No se pudo guardar la receta', true);
      }
    });

    pintarLineas();
  });
}

/* ------------------------------------------------------------------ */
/*  4 · Producción — órdenes                                           */
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

async function modalNuevaOrden() {
  const productos = state.productos.filter((p) => p.activo);

  // Los pedidos abiertos ya dicen qué hay que cocinar: se precarga lo que falta
  // para cumplirlos (PDR §4.2, paso 4). Es un número editable, no una orden.
  const demanda = new Map((await demandaPendiente()).map((d) => [d.producto_id, d]));
  const hayDemanda = [...demanda.values()].some((d) => d.falta > 0);

  ui.abrirModal(`
    <h3>Nueva orden</h3>
    <div class="stack" style="margin-top:var(--sp-4)">
      <div class="field">
        <label for="o-fecha">Fecha de cocina</label>
        <input class="input" id="o-fecha" type="date" value="${hoyISO()}">
      </div>
      <div>
        <label class="dim" style="font-size:.78rem">Qué se va a producir</label>
        ${hayDemanda ? '<p class="faint" style="margin:var(--sp-1) 0 0">Viene precargado lo que falta para los pedidos abiertos.</p>' : ''}
        <div class="stack" style="margin-top:var(--sp-2)">
          ${productos.map((p) => {
            const d = demanda.get(p.id);
            return `
            <div class="between" data-prod="${p.id}">
              <div style="min-width:0">
                <div>${ui.esc(p.nombre)}</div>
                ${d?.falta > 0 ? `<div class="faint">${d.pedido} pedidas · hay ${d.stock}</div>` : ''}
              </div>
              <input class="input cant-chica" type="number" inputmode="numeric" min="0" placeholder="0"
                     value="${d?.falta > 0 ? d.falta : ''}"
                     aria-label="Cantidad de ${ui.esc(p.nombre)}">
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="field">
        <label for="o-notas">Notas</label>
        <input class="input" id="o-notas" placeholder="opcional">
      </div>
      <button class="btn btn--primary btn--block" data-accent="produccion" id="o-crear">Crear orden</button>
    </div>
  `, (root) => {
    alGuardar(root.querySelector('#o-crear'), async () => {
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

      ${bloqueEquipo(orden, asignadas)}

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

    root.querySelector('#o-cerrar')?.addEventListener('click', () => modalCerrarOrden(ordenId, items, reqs, { asignadas }));

    root.querySelector('#o-cancelar')?.addEventListener('click', async () => {
      ui.cerrarModal();
      if (!await ui.confirmar('¿Cancelar esta orden?', 'Cancelar orden')) return;
      await db.from('orden_produccion').update({ estado: 'cancelada' }).eq('id', ordenId);
      await refrescar();
      ui.toast('Orden cancelada');
    });
  });
}

/**
 * El cierre: cuánto salió de cada cosa y quién lo hizo, que es lo que cobra.
 *
 * La administración elige la productora de cada línea —por defecto la que
 * está asignada a la orden, si hay una sola— y puede repartir una línea entre
 * dos. Una trabajadora cierra a su nombre, y su producción queda a confirmar.
 *
 * @param {Object} previo  { reales, productoras, asignadas } para volver a
 *                         abrir sin perder lo cargado
 */
function modalCerrarOrden(ordenId, items, reqs, previo = {}) {
  const { reales: valores = null, productoras: repPrevio = null, asignadas = new Set() } = previo;
  const faltantesPrevios = reqs.filter((r) => r.falta > 0);
  const valorDe = (i) => (valores?.[i.id] != null ? valores[i.id] : i.cantidad_planificada);
  const admin = auth.puede('liquidar');
  const equipo = state.trabajadoras;
  const unica = asignadas.size === 1 ? [...asignadas][0] : '';

  const opciones = (sel) => `
    <option value="">¿Quién lo hizo?</option>
    ${equipo.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${ui.esc(t.nombre)}</option>`).join('')}`;

  const filaReparto = (sel = '', cant = '', primera = false) => `
    <div class="row reparto__fila" data-fila>
      <select class="input grow" data-quien aria-label="Quién lo hizo">${opciones(sel)}</select>
      ${primera
        ? '<span class="faint reparto__resto">el resto</span>'
        : `<input class="input cant-chica" type="number" inputmode="numeric" min="1" value="${cant}" data-cuanto aria-label="Cuántas">
           <button class="btn btn--ghost" data-sacar aria-label="Sacar">×</button>`}
    </div>`;

  const repartoInicial = (i) => {
    const prev = repPrevio?.[i.id];
    if (Array.isArray(prev) && prev.length) {
      return prev.map((r, k) => filaReparto(r.trabajadora_id, r.cantidad, k === 0)).join('');
    }
    return filaReparto(typeof prev === 'string' ? prev : unica, '', true);
  };

  ui.abrirModal(`
    <h3>¿Cuánto salió?</h3>
    <p class="faint" style="margin-top:calc(var(--sp-2) * -1)">
      La cantidad real, no la planificada. Se paga lo que salió.</p>

    <div class="stack" style="margin-top:var(--sp-4)">
      ${items.map((i) => {
        const p = state.productoPorId(i.producto_id);
        const sinPaga = p?.pago_produccion == null;
        return `
          <div class="bloque reparto" data-item="${i.id}">
            <div class="between">
              <div style="min-width:0">
                <div>${ui.esc(p?.nombre || '—')}</div>
                <div class="faint">${sinPaga
                  ? '<span class="danger">sin paga definida</span>'
                  : `se paga <span class="num">${ui.money(p.pago_produccion)}</span> c/u`}</div>
              </div>
              <input class="input cant-chica" type="number" inputmode="numeric" min="0" data-real
                     value="${valorDe(i)}" aria-label="Salieron de ${ui.esc(p?.nombre || '')}">
            </div>
            ${sinPaga && admin ? `
              <div class="field" style="margin-top:var(--sp-2)">
                <label>Paga por unidad</label>
                <input class="input" type="number" inputmode="decimal" step="any" min="0" data-paga="${p.id}" placeholder="Definila para cerrar">
              </div>` : ''}
            ${sinPaga && !admin ? `
              <div class="alerta alerta--warn" style="margin-top:var(--sp-2)">
                Falta definir cuánto se paga. Avisale a la administración.</div>` : ''}
            ${admin ? `
              <div class="stack reparto__filas" style="margin-top:var(--sp-2)">${repartoInicial(i)}</div>
              <button class="btn btn--ghost btn--block" data-repartir style="margin-top:var(--sp-2)">+ Repartir con otra</button>
            ` : ''}
          </div>`;
      }).join('')}

      ${admin ? '' : `<p class="faint" style="margin:0">Se carga a tu nombre y queda a confirmar por la administración.</p>`}

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
    root.addEventListener('click', (e) => {
      const mas = e.target.closest('[data-repartir]');
      if (mas) {
        mas.previousElementSibling.insertAdjacentHTML('beforeend', filaReparto());
        return;
      }
      const sacar = e.target.closest('[data-sacar]');
      if (sacar) sacar.closest('[data-fila]').remove();
    });

    /** Lo que hay en pantalla, tal cual, para cerrar o para volver a abrir. */
    function leer() {
      const reales = {};
      const productoras = {};
      for (const el of root.querySelectorAll('[data-item]')) {
        const real = Number(el.querySelector('[data-real]').value) || 0;
        reales[el.dataset.item] = real;
        if (!admin) continue;
        const filas = [...el.querySelectorAll('[data-fila]')].map((f) => ({
          trabajadora_id: f.querySelector('[data-quien]').value,
          cantidad: Number(f.querySelector('[data-cuanto]')?.value) || 0,
        }));
        // La primera se lleva lo que no se repartió
        const otras = filas.slice(1).reduce((a, r) => a + r.cantidad, 0);
        filas[0].cantidad = real - otras;
        productoras[el.dataset.item] = filas;
      }
      return { reales, productoras };
    }

    alGuardar(root.querySelector('#cz-guardar'), async () => {
      const { reales, productoras } = leer();

      if (admin) {
        for (const el of root.querySelectorAll('[data-item]')) {
          if (!reales[el.dataset.item]) continue;
          const nombre = el.querySelector('.between div div').textContent;
          if (productoras[el.dataset.item].some((r) => !r.trabajadora_id)) {
            return ui.toast(`Falta quién hizo ${nombre}`, true);
          }
          if (productoras[el.dataset.item][0].cantidad <= 0) {
            return ui.toast(`${nombre}: lo repartido supera lo que salió`, true);
          }
        }
      }

      try {
        for (const campo of root.querySelectorAll('[data-paga]')) {
          if (campo.value !== '') await fijarPagoProduccion(campo.dataset.paga, campo.value);
        }
        if (root.querySelector('[data-paga]')) await state.cargar();

        const r = await cerrarOrden(ordenId, reales, {
          motivoAjuste: root.querySelector('#cz-motivo')?.value || null,
          productoras: admin ? productoras : null,
        });
        ui.cerrarModal();
        await refrescar();
        ui.toast(verCostos()
          ? `Orden cerrada · insumos ${ui.money(r.costoInsumos)} · paga ${ui.money(r.costoManoObra)}`
          : 'Orden cerrada · tu producción queda a confirmar');
      } catch (e) {
        // Si salió MÁS de lo planificado aparecen faltantes que la tabla de
        // arriba no mostraba, y el campo de motivo no se había renderizado:
        // sin esto quedaba un callejón sin salida y había que mentir el número
        if (e.faltantes?.length && !root.querySelector('#cz-motivo')) {
          ui.toast('Salió más de lo planificado: falta insumo', true);
          return modalCerrarOrden(ordenId, items, e.faltantes.map((f) => ({ ...f, falta: 1 })),
            { reales, productoras, asignadas });
        }
        ui.toast(e.message || 'No se pudo cerrar', true);
      }
    });
  });
}

