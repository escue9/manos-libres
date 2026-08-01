/**
 * pedidos.js — Pedidos · Agenda de entregas · Venta rápida · Clientes
 * Colores: naranja var(--pedidos) / amarillo var(--clientes)
 *
 * FASE 2 — ver docs/PDR.md §4.2
 *
 * Cuatro pantallas: las tres del tab Pedidos con subnavegación (pedidos,
 * agenda, venta rápida) y la de Clientes, que es su propio tab.
 *
 * La lógica de plata está en las funciones exportadas de arriba —crearPedido,
 * entregarPedido, registrarCobro, anularPedido, registrarVenta—: son las que
 * prueban los tests y las que no pueden estar mal.
 *
 * Reglas que sostienen este módulo:
 *  - Los snapshots de precio y costo son inmutables (regla 4). Se congelan al
 *    cargar el pedido y no se vuelven a tocar, ni siquiera al editarlo
 *  - El stock se descuenta al ENTREGAR, no al cargar el pedido. La venta rápida
 *    entrega en el acto, así que descuenta en el acto
 *  - Un pedido puede tener varios cobros (seña + saldo). El estado de pago es
 *    derivado: sale de la suma de cobros, nunca se escribe a mano
 *  - El movimiento de caja del cobro se genera solo (regla 6)
 *  - Rentabilidad y caja son cosas distintas (regla 5): entregar suma a la
 *    ganancia, cobrar suma a la caja. Son dos botones separados a propósito
 */

import { db } from '../db.js';
import { state } from '../state.js';
import { auth } from '../auth.js';
import { ui } from '../ui.js';
import * as calc from '../calc.js';
import * as nube from '../nube.js';
import * as canalWeb from './canal-web.js';

/** Tolerancia de centavo para comparar plata. Misma razón que en calc.js. */
const EPS = 1e-6;

// Fecha local: toISOString() devuelve UTC y una venta de las 21:30 en la cancha
// quedaría fechada mañana.
const hoyISO = () => ui.hoyISO();
const ahoraISO = () => ui.ahoraISO();

/**
 * Por dónde ENTRÓ el pedido. No confundir con `MODOS_ENTREGA`, que es cómo
 * llega al cliente: hasta la v3 del esquema `canal` mezclaba las dos cosas y
 * un pedido del catálogo web entregado a domicilio no tenía cómo describirse.
 */
export const CANALES = [
  { id: 'whatsapp',        etiqueta: 'WhatsApp' },
  { id: 'instagram',       etiqueta: 'Instagram' },
  { id: 'catalogo_web',    etiqueta: 'Catálogo web' },
  { id: 'mostrador_cic',   etiqueta: 'Mostrador CIC' },
  { id: 'mostrador_uncas', etiqueta: 'Mostrador Uncas' },
  { id: 'otro',            etiqueta: 'Otro' },
];

/** Cómo LLEGA al cliente. Retiro y domicilio son dos trabajos distintos. */
export const MODOS_ENTREGA = [
  { id: 'en_el_acto', etiqueta: 'En el acto',  corto: 'En el acto' },
  { id: 'retira_cic', etiqueta: 'Retira en el CIC', corto: 'Retira' },
  { id: 'domicilio',  etiqueta: 'Envío a domicilio', corto: 'Domicilio' },
];

export const etiquetaEntrega = (id) =>
  MODOS_ENTREGA.find((m) => m.id === id)?.corto || 'Retira';

export const TIPOS_CLIENTE = [
  { id: 'particular',  etiqueta: 'Particular' },
  { id: 'club',        etiqueta: 'Club' },
  { id: 'institucion', etiqueta: 'Institución' },
  { id: 'revendedor',  etiqueta: 'Revendedor' },
];

const ESTADO_PEDIDO = {
  pendiente:     { etiqueta: 'Pendiente',     badge: '' },
  confirmado:    { etiqueta: 'Confirmado',    badge: '' },
  en_produccion: { etiqueta: 'En producción', badge: 'badge--warn' },
  listo:         { etiqueta: 'Listo',         badge: 'badge--ok' },
  entregado:     { etiqueta: 'Entregado',     badge: 'badge--ok' },
  cancelado:     { etiqueta: 'Anulado',       badge: 'badge--danger' },
};

/** Un pedido abierto es el que todavía puede cambiar: ni entregado ni anulado. */
export const ESTADOS_ABIERTOS = ['pendiente', 'confirmado', 'en_produccion', 'listo'];

const ESTADO_PAGO = {
  impago: { etiqueta: 'Impago', badge: 'badge--danger' },
  sena:   { etiqueta: 'Seña',   badge: 'badge--warn' },
  pagado: { etiqueta: 'Pagado', badge: 'badge--ok' },
};

const SEGMENTO = {
  nuevo:     { etiqueta: 'Nuevo',     badge: '' },
  frecuente: { etiqueta: 'Frecuente', badge: 'badge--warn' },
  fiel:      { etiqueta: 'Fiel',      badge: 'badge--ok' },
};

const MEDIOS = [
  { id: 'efectivo', etiqueta: 'Efectivo',
    svg: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/>' },
  { id: 'transferencia', etiqueta: 'Transfer.',
    svg: '<path d="M4 8h13M14 5l3 3-3 3"/><path d="M20 16H7M10 19l-3-3 3-3"/>' },
  { id: 'mercadopago', etiqueta: 'Mercado Pago',
    svg: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 10h20"/>' },
];

const esFechaISO = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '');

/** Para comparar teléfonos: "2494 55-1234" y "249455 1234" son el mismo. */
const soloDigitos = (t) => String(t ?? '').replace(/\D/g, '');

const etiquetaCanal = (id) => CANALES.find((c) => c.id === id)?.etiqueta || 'Otro';

/* ================================================================== */
/*  Clientes                                                           */
/* ================================================================== */

/**
 * Alta o edición de cliente.
 *
 * El teléfono es la clave práctica de identificación (PDR §3): si dos filas
 * tienen el mismo, el historial del cliente queda partido en dos y el segmento
 * miente — el club que compra todas las semanas figura como "Nuevo" en ambas.
 * Por eso se compara por dígitos y no por el texto tal cual se escribió.
 */
export async function guardarCliente({
  id = null, nombre, telefono = '', direccion = '', tipo = 'particular', notas = '',
} = {}) {
  auth.exigir('gestionarClientes');

  nombre = String(nombre || '').trim();
  telefono = String(telefono || '').trim();
  if (!nombre) throw new Error('Falta el nombre');
  if (!TIPOS_CLIENTE.some((t) => t.id === tipo)) tipo = 'particular';

  const digitos = soloDigitos(telefono);
  if (digitos) {
    const todos = await db.from('cliente').select();
    const choca = todos.find((c) => c.id !== id && soloDigitos(c.telefono) === digitos);
    if (choca) throw new Error(`Ese teléfono ya es de ${choca.nombre}`);
  }

  const datos = { nombre, telefono, direccion: String(direccion || '').trim(), tipo, notas: String(notas || '').trim() };

  if (!id) return db.from('cliente').insert(datos);

  await db.from('cliente').update(datos).eq('id', id);
  return db.from('cliente').select().eq('id', id).single();
}

/**
 * Busca un cliente por teléfono. Es el primer paso de "pedido por WhatsApp":
 * el número llega en el mensaje, el nombre a veces no.
 */
export async function buscarPorTelefono(telefono) {
  const digitos = soloDigitos(telefono);
  if (!digitos) return null;
  const todos = await db.from('cliente').select();
  return todos.find((c) => soloDigitos(c.telefono) === digitos) || null;
}

/**
 * Todos los clientes con sus campos derivados: cuántos pedidos, cuánto gastó,
 * ticket promedio, último pedido, segmento y cuánto debe.
 *
 * Se calculan, no se guardan: un contador almacenado se desincroniza en cuanto
 * se anula un pedido y nadie se entera hasta que los números no cierran.
 */
export async function resumenClientes() {
  const [clientes, pedidos] = await Promise.all([
    db.from('cliente').select().order('nombre'),
    db.from('pedido').select(),
  ]);

  const porCliente = new Map();
  for (const p of pedidos) {
    if (!p.cliente_id) continue;
    if (!porCliente.has(p.cliente_id)) porCliente.set(p.cliente_id, []);
    porCliente.get(p.cliente_id).push(p);
  }

  return clientes.map((cliente) => ({
    cliente,
    pedidos: porCliente.get(cliente.id) || [],
    ...calc.resumenCliente(porCliente.get(cliente.id) || []),
  }));
}

/* ================================================================== */
/*  Pedidos                                                            */
/* ================================================================== */

/**
 * Convierte [{ producto_id, cantidad }] en líneas con precio y costo del
 * momento. Acá es donde se congelan los snapshots (regla 4).
 *
 * Los productos se releen de la base y no de state: la caché puede tener el
 * precio viejo si lo cambiaron desde otra pestaña, y ese precio es el que se
 * le va a cobrar al cliente.
 */
async function lineasConSnapshot(items = []) {
  const productos = await db.from('producto').select();
  const lineas = [];

  for (const it of items) {
    const cantidad = Number(it.cantidad);
    if (!(cantidad > 0)) continue;

    const producto = productos.find((p) => p.id === it.producto_id);
    if (!producto) throw new Error('Hay una línea sin producto');

    // `precio` explícito solo lo usa la importación del buzón, donde la
    // administración puede decidir respetar el precio con el que el cliente
    // vio el catálogo aunque el del SO ya haya cambiado. En el resto de los
    // casos manda el precio del producto.
    const precio = it.precio != null ? Number(it.precio) : (producto.precio_venta || 0);
    if (!(precio >= 0)) throw new Error(`Precio inválido para ${producto.nombre}`);

    lineas.push({ producto, cantidad, precio, costo: calc.costoEfectivo(producto) });
  }

  return lineas;
}

const brutoDeLineas = (lineas) => lineas.reduce((a, l) => a + l.precio * l.cantidad, 0);

/**
 * Carga un pedido. NO toca el stock: el stock se mueve al entregar.
 *
 * Si falta producto terminado para lo pedido, el pedido nace `en_produccion`
 * en vez de `confirmado` (PDR §4.2) y queda visible en la demanda pendiente,
 * que es lo que después precarga la orden de producción.
 *
 * @param {Object} o
 * @param {string} [o.clienteId]  cliente existente
 * @param {Object} [o.cliente]    datos para crearlo en el mismo formulario
 * @returns {Promise<{pedido:Object, faltantes:Array}>}
 */
export async function crearPedido({
  clienteId = null, cliente = null, canal = 'whatsapp',
  modoEntrega = 'retira_cic', direccionEntrega = '', costoEnvio = 0, origenWebId = null,
  fechaPedido = hoyISO(), fechaEntrega = hoyISO(),
  items = [], descuento = 0, notas = '', estado = 'confirmado',
} = {}) {
  auth.exigir('cargarPedidos');

  if (!ESTADOS_ABIERTOS.includes(estado)) {
    throw new Error('Un pedido nuevo nace abierto: entregar y anular son otra cosa');
  }
  if (!esFechaISO(fechaEntrega)) throw new Error('Falta la fecha de entrega');
  if (!esFechaISO(fechaPedido)) fechaPedido = hoyISO();
  if (!CANALES.some((c) => c.id === canal)) canal = 'otro';
  if (!MODOS_ENTREGA.some((m) => m.id === modoEntrega)) modoEntrega = 'retira_cic';

  direccionEntrega = String(direccionEntrega || '').trim();
  if (modoEntrega === 'domicilio' && !direccionEntrega) {
    throw new Error('Un envío a domicilio necesita la dirección');
  }

  costoEnvio = Number(costoEnvio) || 0;
  if (costoEnvio < 0) throw new Error('El costo de envío no puede ser negativo');

  const lineas = await lineasConSnapshot(items);
  if (!lineas.length) throw new Error('El pedido no tiene productos');

  descuento = Number(descuento) || 0;
  if (descuento < 0) throw new Error('El descuento no puede ser negativo');

  const bruto = brutoDeLineas(lineas);
  if (descuento > bruto + EPS) throw new Error('El descuento no puede ser mayor que el pedido');

  if (!clienteId && cliente?.nombre) clienteId = (await guardarCliente(cliente)).id;

  const faltantes = lineas
    .map((l) => ({ producto: l.producto, falta: l.cantidad - (l.producto.stock_actual || 0) }))
    .filter((f) => f.falta > 0);

  const pedido = await db.from('pedido').insert({
    unidad_negocio_id: state.unidadNegocio.id,
    cliente_id: clienteId,
    canal,
    modo_entrega: modoEntrega,
    direccion_entrega: modoEntrega === 'domicilio' ? direccionEntrega : null,
    // Preparado, hoy siempre cero. Suma al total pero queda afuera del margen
    // del producto: ver bloqueMargen().
    costo_envio: costoEnvio,
    origen_web_id: origenWebId,
    fecha_pedido: fechaPedido,
    fecha_entrega: fechaEntrega,
    estado: estado === 'confirmado' && faltantes.length ? 'en_produccion' : estado,
    total: bruto - descuento + costoEnvio,
    descuento,
    monto_cobrado: 0,
    estado_pago: 'impago',
    notas: String(notas || '').trim(),
    created_by: auth.trabajadoraId,
    created_by_rol: auth.rol,     // el admin no tiene trabajadora_id (auditoría)
  });

  await db.from('pedido_item').insert(lineas.map((l) => ({
    pedido_id: pedido.id,
    producto_id: l.producto.id,
    cantidad: l.cantidad,
    precio_unitario: l.precio,   // snapshot
    costo_unitario: l.costo,     // snapshot
  })));

  return { pedido, faltantes };
}

/* ------------------------------------------------------------------ */
/*  Buzón del catálogo web                                             */
/* ------------------------------------------------------------------ */

/** ¿Este pedido del buzón ya entró al SO? */
export async function yaImportado(pedidoWebId) {
  const previos = await db.from('pedido').select().eq('origen_web_id', pedidoWebId);
  return previos[0] || null;
}

/**
 * Convierte un pedido del buzón en un pedido del SO.
 *
 * El orden importa. Primero se crea el pedido local y recién después se marca
 * el buzón; si se hiciera al revés y la escritura local fallara, el buzón
 * diría "importado" sin que exista el pedido y nadie lo cocinaría. Como el
 * buzón es compartido y la cocina tiene más de un dispositivo, la marca es un
 * compare-and-set sobre `estado = 'nuevo'`: si otra persona lo tomó mientras
 * esta lo revisaba, se deshace el pedido local en vez de duplicarlo.
 *
 * NO toca el stock. El stock se descuenta al ENTREGAR: un pedido para el
 * viernes no puede bajar el stock del lunes, porque la venta rápida del martes
 * creería que no hay mercadería.
 *
 * @param {Object} pedidoWeb            la fila de pedido_web
 * @param {Object} o
 * @param {string} [o.clienteId]        cliente ya existente
 * @param {Object} [o.cliente]          datos para crearlo en el momento
 * @param {Array}  o.items              [{producto_id, cantidad, precio}] ya mapeados
 *                                      y con el precio que confirmó la administración
 * @param {string} [o.fechaEntrega]
 */
export async function importarPedidoWeb(pedidoWeb, {
  clienteId = null, cliente = null, items = [], fechaEntrega = null,
} = {}) {
  auth.exigir('gestionarCanalWeb');

  if (!pedidoWeb?.id) throw new Error('Falta el pedido del buzón');
  if (pedidoWeb.estado && pedidoWeb.estado !== 'nuevo') {
    throw new Error(`Este pedido ya está ${pedidoWeb.estado}`);
  }

  const previo = await yaImportado(pedidoWeb.id);
  if (previo) throw new Error('Este pedido del buzón ya se importó');

  if (!clienteId && !cliente) {
    const porTel = await buscarPorTelefono(pedidoWeb.telefono);
    if (porTel) clienteId = porTel.id;
    else cliente = { nombre: pedidoWeb.nombre, telefono: pedidoWeb.telefono };
  }

  const { pedido, faltantes } = await crearPedido({
    clienteId,
    cliente,
    canal: 'catalogo_web',
    modoEntrega: pedidoWeb.modo_entrega,
    direccionEntrega: pedidoWeb.direccion || '',
    origenWebId: pedidoWeb.id,
    fechaEntrega: esFechaISO(fechaEntrega) ? fechaEntrega
      : (esFechaISO(pedidoWeb.fecha_deseada) ? pedidoWeb.fecha_deseada : hoyISO()),
    notas: pedidoWeb.notas || '',
    items,
    estado: 'confirmado',
  });

  let tomado = false;
  try {
    tomado = await nube.marcarImportado(pedidoWeb.id, pedido.id);
  } catch (err) {
    await deshacerImportacion(pedido.id);
    throw new Error(`No se pudo marcar el pedido en el buzón: ${err.message}`);
  }

  if (!tomado) {
    await deshacerImportacion(pedido.id);
    throw new Error('Alguien más ya tomó este pedido del buzón');
  }

  return { pedido, faltantes };
}

/**
 * Borra un pedido recién creado que no llegó a cerrar la importación.
 *
 * Se puede borrar sin más porque todavía no movió nada: importar no toca
 * stock ni caja. Anular sería para un pedido que sí vivió.
 */
async function deshacerImportacion(pedidoId) {
  await db.from('pedido_item').delete().eq('pedido_id', pedidoId);
  await db.from('pedido').delete().eq('id', pedidoId);
}

/** Descarta un pedido del buzón. No borra: queda con su motivo. */
export async function descartarPedidoWeb(pedidoWebId, motivo) {
  auth.exigir('gestionarCanalWeb');

  const texto = String(motivo || '').trim();
  if (!texto) throw new Error('Descartar un pedido pide un motivo');

  const hecho = await nube.marcarDescartado(pedidoWebId, texto);
  if (!hecho) throw new Error('Ese pedido ya no estaba sin revisar');
  return true;
}

/**
 * Compara lo que pidió el cliente contra el SO de hoy: qué producto es cada
 * ítem, a cuánto está ahora y cuánto stock hay. Es lo que pinta la pantalla
 * de revisión — no escribe nada.
 */
export async function revisarPedidoWeb(pedidoWeb) {
  auth.exigir('gestionarCanalWeb');

  const productos = await db.from('producto').select();
  const lineas = (pedidoWeb.items || []).map((it) => {
    const producto = productos.find((p) => p.id === it.producto_id) || null;
    const precioWeb = Number(it.precio) || 0;
    const precioSO = producto ? (producto.precio_venta || 0) : null;

    return {
      nombre: it.nombre,
      cantidad: Number(it.cantidad) || 0,
      producto,
      precioWeb,
      precioSO,
      // Si el precio cambió desde que se publicó el catálogo, la pantalla
      // muestra las dos cifras y decide la administración.
      cambio: producto != null && Math.abs(precioSO - precioWeb) > EPS,
      stock: producto ? (producto.stock_actual || 0) : 0,
    };
  });

  const cliente = await buscarPorTelefono(pedidoWeb.telefono);

  return {
    lineas,
    cliente,
    sinMapear: lineas.filter((l) => !l.producto).length,
    totalWeb: lineas.reduce((a, l) => a + l.precioWeb * l.cantidad, 0),
    totalSO: lineas.reduce((a, l) => a + (l.precioSO ?? l.precioWeb) * l.cantidad, 0),
  };
}

/**
 * Edita un pedido abierto.
 *
 * Las líneas que ya estaban conservan su precio y su costo congelados: si un
 * producto subió entre el pedido y la corrección, el cliente paga el precio que
 * se le dijo. Solo los productos que se agregan hoy se costean hoy.
 */
export async function actualizarPedido(pedidoId, {
  canal, modoEntrega, direccionEntrega, fechaEntrega, notas, descuento, items,
} = {}) {
  auth.exigir('cargarPedidos');

  const pedido = await db.from('pedido').select().eq('id', pedidoId).single();
  if (!pedido) throw new Error('Pedido inexistente');
  if (!ESTADOS_ABIERTOS.includes(pedido.estado)) {
    throw new Error(`Un pedido ${ESTADO_PEDIDO[pedido.estado]?.etiqueta.toLowerCase() || 'cerrado'} no se edita`);
  }

  const previos = await db.from('pedido_item').select().eq('pedido_id', pedidoId);
  const porProducto = new Map(previos.map((i) => [i.producto_id, i]));

  /* --- se valida TODO antes de escribir nada --- */

  let lineas = null;
  if (items) {
    lineas = (await lineasConSnapshot(items)).map((l) => {
      const prev = porProducto.get(l.producto.id);
      // snapshot inmutable: el precio del pedido no se recalcula (regla 4)
      return prev ? { ...l, precio: prev.precio_unitario, costo: prev.costo_unitario, prev } : l;
    });
    if (!lineas.length) throw new Error('El pedido no puede quedar sin productos');
  }

  const bruto = lineas
    ? brutoDeLineas(lineas)
    : previos.reduce((a, i) => a + i.precio_unitario * i.cantidad, 0);

  const desc = descuento != null ? Number(descuento) || 0 : (pedido.descuento || 0);
  if (desc < 0) throw new Error('El descuento no puede ser negativo');
  if (desc > bruto + EPS) throw new Error('El descuento no puede ser mayor que el pedido');

  // El envío ya cobrado sigue formando parte del total al reeditar el pedido.
  const total = bruto - desc + (pedido.costo_envio || 0);
  const cobrado = pedido.monto_cobrado || 0;
  if (total + EPS < cobrado) {
    throw new Error(`Ya se cobraron ${ui.money(cobrado)}: el pedido no puede quedar en menos`);
  }

  if (fechaEntrega != null && !esFechaISO(fechaEntrega)) throw new Error('Fecha de entrega inválida');

  /* --- recién ahora se escribe --- */

  if (lineas) {
    for (const l of lineas) {
      if (l.prev) {
        await db.from('pedido_item').update({ cantidad: l.cantidad }).eq('id', l.prev.id);
        porProducto.delete(l.producto.id);
      } else {
        await db.from('pedido_item').insert({
          pedido_id: pedidoId,
          producto_id: l.producto.id,
          cantidad: l.cantidad,
          precio_unitario: l.precio,
          costo_unitario: l.costo,
        });
      }
    }
    for (const sobra of porProducto.values()) {
      await db.from('pedido_item').delete().eq('id', sobra.id);
    }
  }

  const patch = { total, descuento: desc, estado_pago: calc.estadoPago(total, cobrado) };
  if (fechaEntrega != null) patch.fecha_entrega = fechaEntrega;
  if (notas != null) patch.notas = String(notas).trim();
  if (canal != null && CANALES.some((c) => c.id === canal)) patch.canal = canal;

  if (modoEntrega != null && MODOS_ENTREGA.some((m) => m.id === modoEntrega)) {
    const dir = String(direccionEntrega ?? pedido.direccion_entrega ?? '').trim();
    if (modoEntrega === 'domicilio' && !dir) {
      throw new Error('Un envío a domicilio necesita la dirección');
    }
    patch.modo_entrega = modoEntrega;
    patch.direccion_entrega = modoEntrega === 'domicilio' ? dir : null;
  }

  await db.from('pedido').update(patch).eq('id', pedidoId);
  return db.from('pedido').select().eq('id', pedidoId).single();
}

/** Mueve el pedido entre estados abiertos. Entregar y anular tienen su función. */
export async function cambiarEstadoPedido(pedidoId, estado) {
  auth.exigir('cargarPedidos');
  if (!ESTADOS_ABIERTOS.includes(estado)) {
    throw new Error('Entregar y anular no pasan por acá');
  }

  const pedido = await db.from('pedido').select().eq('id', pedidoId).single();
  if (!pedido) throw new Error('Pedido inexistente');
  if (!ESTADOS_ABIERTOS.includes(pedido.estado)) throw new Error('Ese pedido ya está cerrado');

  await db.from('pedido').update({ estado }).eq('id', pedidoId);
  return db.from('pedido').select().eq('id', pedidoId).single();
}

/**
 * Entrega el pedido: descuenta el producto terminado y deja el rastro (regla 7).
 *
 * Cobrar es otra función a propósito. Entregar mueve la RENTABILIDAD —el cierre
 * semanal se calcula sobre entregados— y cobrar mueve la CAJA. Un pedido
 * entregado e impago es un estado real y frecuente: el club se lleva las
 * empanadas el sábado y paga el lunes (regla 5).
 *
 * No bloquea si el stock del sistema no alcanza: la comida está físicamente
 * ahí y el negativo es la señal de que falta cargar la producción. Es el mismo
 * criterio de la venta rápida.
 */
export async function entregarPedido(pedidoId, { fecha = hoyISO() } = {}) {
  auth.exigir('cargarPedidos');

  const pedido = await db.from('pedido').select().eq('id', pedidoId).single();
  if (!pedido) throw new Error('Pedido inexistente');
  if (pedido.estado === 'cancelado') throw new Error('Ese pedido está anulado');
  if (pedido.estado === 'entregado') throw new Error('Ese pedido ya figura entregado');

  const items = await db.from('pedido_item').select().eq('pedido_id', pedidoId);
  if (!items.length) throw new Error('El pedido no tiene productos');

  // Se toma el pedido ANTES de tocar el stock. Con el update al final, dos taps
  // seguidos —o dos pestañas— pasaban los dos el chequeo de estado y
  // descontaban el mismo pedido dos veces.
  const tomado = await db.from('pedido')
    .update({ estado: 'entregado', fecha_entrega: esFechaISO(fecha) ? fecha : hoyISO() })
    .eq('id', pedidoId).neq('estado', 'entregado');
  if (!tomado.length) throw new Error('Ese pedido ya lo está entregando alguien más');

  const tocado = [];
  const movimientos = [];

  try {
    for (const it of items) {
      // Se relee el producto: esto es un SET, no un decremento, y entre medio
      // pudo entrar una venta rápida desde otra pestaña
      const actual = await db.from('producto').select().eq('id', it.producto_id).single();
      if (!actual) continue;

      await db.from('producto')
        .update({ stock_actual: (actual.stock_actual || 0) - it.cantidad })
        .eq('id', it.producto_id);
      tocado.push(it);

      const mov = await db.from('movimiento_stock_producto').insert({
        producto_id: it.producto_id,
        fecha: ahoraISO(),
        tipo: 'venta',
        cantidad: -it.cantidad,
        referencia_id: pedidoId,
      });
      movimientos.push(mov.id);
    }
  } catch (e) {
    for (const it of tocado) {
      const actual = await db.from('producto').select().eq('id', it.producto_id).single();
      if (actual) {
        await db.from('producto')
          .update({ stock_actual: (actual.stock_actual || 0) + it.cantidad })
          .eq('id', it.producto_id);
      }
    }
    for (const id of movimientos) await db.from('movimiento_stock_producto').delete().eq('id', id);
    await db.from('pedido')
      .update({ estado: pedido.estado, fecha_entrega: pedido.fecha_entrega }).eq('id', pedidoId);
    throw e;
  }

  return db.from('pedido').select().eq('id', pedidoId).single();
}

/**
 * Registra un cobro y su ingreso en caja. El movimiento es automático (regla 6):
 * cargarlo además a mano en Caja duplica la plata.
 *
 * Un pedido puede tener varios cobros —seña y saldo— pero nunca más que el
 * total: cobrar de más sería una deuda del negocio con el cliente, y eso no es
 * un cobro.
 */
export async function registrarCobro(pedidoId, { monto, medio = 'efectivo', fecha = hoyISO() } = {}) {
  auth.exigir('cargarPedidos');

  monto = Number(monto);
  if (!(monto > 0)) throw new Error('El cobro tiene que ser mayor a cero');

  const pedido = await db.from('pedido').select().eq('id', pedidoId).single();
  if (!pedido) throw new Error('Pedido inexistente');
  if (pedido.estado === 'cancelado') throw new Error('Ese pedido está anulado');

  const cobros = await db.from('cobro').select().eq('pedido_id', pedidoId);
  const previo = cobros.reduce((a, c) => a + (c.monto || 0), 0);
  const total = pedido.total || 0;

  if (previo + monto > total + EPS) {
    const falta = Math.max(0, total - previo);
    throw new Error(falta > 0
      ? `De este pedido faltan ${ui.money(falta)}: no se puede cobrar de más`
      : 'Ese pedido ya está cobrado');
  }

  const cobro = await db.from('cobro').insert({
    pedido_id: pedidoId, fecha: esFechaISO(fecha) ? fecha : hoyISO(), monto, medio,
  });

  try {
    const cliente = pedido.cliente_id
      ? await db.from('cliente').select().eq('id', pedido.cliente_id).single()
      : null;

    await db.from('movimiento_caja').insert({
      unidad_negocio_id: pedido.unidad_negocio_id || state.unidadNegocio?.id,
      fecha: cobro.fecha,
      tipo: 'ingreso',
      origen: 'cobro',
      referencia_id: cobro.id,
      monto,
      descripcion: `Cobro de pedido${cliente ? ` · ${cliente.nombre}` : ''}`,
      medio,
    });
  } catch (e) {
    // Un cobro sin su ingreso en caja es plata que entró y no figura
    await db.from('cobro').delete().eq('id', cobro.id);
    throw e;
  }

  const cobrado = previo + monto;
  const estadoPago = calc.estadoPago(total, cobrado);
  await db.from('pedido').update({ monto_cobrado: cobrado, estado_pago: estadoPago }).eq('id', pedidoId);

  return { cobro, cobrado, estadoPago, resta: Math.max(0, total - cobrado) };
}

/**
 * Anula un pedido y deshace lo que haya movido. Era la deuda conocida de la
 * venta rápida: hasta acá, una venta cargada mal no se podía deshacer.
 *
 *   - si estaba entregado, devuelve el producto al stock con su movimiento
 *   - si tenía cobros, deja un egreso en caja por cada uno (la devolución)
 *   - el pedido queda `cancelado`, así que sale de la rentabilidad
 *
 * Los cobros NO se borran: la plata entró y salió, y las dos cosas pasaron.
 * Borrarlos dejaría una caja que cierra por casualidad y un historial que miente.
 *
 * El motivo va a `notas` porque el esquema del PDR no tiene un campo propio.
 * Cuando se migre a Postgres, si esto se usa seguido, se le hace su columna.
 */
export async function anularPedido(pedidoId, motivo) {
  auth.exigir('anularPedidos');

  motivo = String(motivo || '').trim();
  if (!motivo) throw new Error('La anulación necesita un motivo');

  const pedido = await db.from('pedido').select().eq('id', pedidoId).single();
  if (!pedido) throw new Error('Pedido inexistente');
  if (pedido.estado === 'cancelado') throw new Error('Ese pedido ya está anulado');

  // Se toma primero: dos anulaciones en paralelo devolvían el stock dos veces
  const tomado = await db.from('pedido')
    .update({ estado: 'cancelado' }).eq('id', pedidoId).neq('estado', 'cancelado');
  if (!tomado.length) throw new Error('Ese pedido ya está anulado');

  const fecha = hoyISO();
  let stockDevuelto = 0;

  if (pedido.estado === 'entregado') {
    const items = await db.from('pedido_item').select().eq('pedido_id', pedidoId);
    for (const it of items) {
      const actual = await db.from('producto').select().eq('id', it.producto_id).single();
      if (!actual) continue;
      await db.from('producto')
        .update({ stock_actual: (actual.stock_actual || 0) + it.cantidad })
        .eq('id', it.producto_id);
      await db.from('movimiento_stock_producto').insert({
        producto_id: it.producto_id,
        fecha: ahoraISO(),
        tipo: 'ajuste',
        cantidad: it.cantidad,
        referencia_id: pedidoId,
        motivo: `Anulación de pedido: ${motivo}`,
      });
      stockDevuelto += it.cantidad;
    }
  }

  const cobros = await db.from('cobro').select().eq('pedido_id', pedidoId);
  let devuelto = 0;

  for (const c of cobros) {
    await db.from('movimiento_caja').insert({
      unidad_negocio_id: pedido.unidad_negocio_id || state.unidadNegocio?.id,
      fecha,
      tipo: 'egreso',
      origen: 'cobro',
      referencia_id: c.id,
      monto: c.monto,
      descripcion: `Devolución por anulación · ${motivo}`,
      medio: c.medio,
    });
    devuelto += c.monto || 0;
  }

  const notas = [pedido.notas, `Anulado el ${ui.fecha(fecha)}: ${motivo}`]
    .filter((t) => t && String(t).trim()).join(' · ');
  await db.from('pedido').update({ notas }).eq('id', pedidoId);

  return { devuelto, stockDevuelto, cobros: cobros.length };
}

/* ------------------------------------------------------------------ */
/*  Consultas                                                          */
/* ------------------------------------------------------------------ */

/** Pedido con todo lo que cuelga de él: items, cobros y cliente. */
export async function detallePedido(pedidoId) {
  const pedido = await db.from('pedido').select().eq('id', pedidoId).single();
  if (!pedido) return null;

  const [items, cobros] = await Promise.all([
    db.from('pedido_item').select().eq('pedido_id', pedidoId),
    db.from('cobro').select().eq('pedido_id', pedidoId).order('fecha'),
  ]);

  const cliente = pedido.cliente_id
    ? await db.from('cliente').select().eq('id', pedido.cliente_id).single()
    : null;

  return { pedido, items, cobros, cliente };
}

/** Pedidos con fecha de entrega dentro del rango, ordenados por día. */
export async function pedidosDeSemana(desde, hasta) {
  return db.from('pedido').select()
    .gte('fecha_entrega', desde).lte('fecha_entrega', hasta)
    .order('fecha_entrega');
}

/**
 * Cuánto producto terminado está comprometido en pedidos abiertos y cuánto
 * falta hacer. Es lo que precarga la orden de producción (PDR §4.2, paso 4).
 */
export async function demandaPendiente() {
  const [pedidos, items, productos] = await Promise.all([
    db.from('pedido').select(),
    db.from('pedido_item').select(),
    db.from('producto').select(),
  ]);

  const abiertos = new Set(pedidos.filter((p) => ESTADOS_ABIERTOS.includes(p.estado)).map((p) => p.id));
  const porProducto = new Map();

  for (const it of items) {
    if (!abiertos.has(it.pedido_id)) continue;
    porProducto.set(it.producto_id, (porProducto.get(it.producto_id) || 0) + it.cantidad);
  }

  return [...porProducto.entries()].map(([producto_id, pedido]) => {
    const producto = productos.find((p) => p.id === producto_id);
    const stock = producto?.stock_actual || 0;
    return { producto_id, producto, pedido, stock, falta: Math.max(0, pedido - stock) };
  }).filter((d) => d.producto);
}

/**
 * Las alertas del PDR §5.4 que dependen de pedidos.
 * Todas miran fechas, así que se calculan al vuelo y no se guardan en ningún lado.
 */
export async function alertasPedidos() {
  const hoy = hoyISO();
  const haceUnaSemana = ui.hoyISO(new Date(Date.now() - 7 * 864e5));
  const pedidos = await db.from('pedido').select();

  return {
    // entrega hoy y todavía no está listo
    enRiesgo: pedidos.filter((p) => p.fecha_entrega === hoy
      && ESTADOS_ABIERTOS.includes(p.estado) && p.estado !== 'listo'),
    // se pasó la fecha y sigue abierto
    atrasados: pedidos.filter((p) => p.fecha_entrega < hoy && ESTADOS_ABIERTOS.includes(p.estado)),
    // entregado hace más de una semana y todavía debe
    cobroPendiente: pedidos.filter((p) => p.estado === 'entregado'
      && p.estado_pago !== 'pagado' && p.fecha_entrega <= haceUnaSemana),
  };
}

/* ================================================================== */
/*  Venta rápida — transacción                                         */
/* ================================================================== */

/** Carrito en memoria: producto_id → cantidad. Se vacía al confirmar. */
let carrito = {};

/**
 * Deshace una venta que quedó a medio escribir.
 *
 * IndexedDB no da una transacción que abarque las cinco tablas, así que la
 * atomicidad se construye a mano: si algo falla, se borra lo que se alcanzó a
 * escribir y se devuelve el stock. Sin esto, un almacenamiento lleno en un
 * celular viejo dejaba una venta fantasma sumando a la caja mientras la
 * pantalla decía "no se pudo" — y la usuaria la volvía a cargar.
 */
async function revertirVenta(pedidoId, stockTocado) {
  for (const { productoId, cantidad } of stockTocado) {
    const actual = await db.from('producto').select().eq('id', productoId).single();
    if (actual) {
      await db.from('producto')
        .update({ stock_actual: (actual.stock_actual || 0) + cantidad })
        .eq('id', productoId);
    }
  }
  await db.from('movimiento_stock_producto').delete().eq('referencia_id', pedidoId);
  await db.from('pedido_item').delete().eq('pedido_id', pedidoId);
  await db.from('cobro').delete().eq('pedido_id', pedidoId);
  await db.from('pedido').delete().eq('id', pedidoId);
}

/**
 * Una venta de mostrador es un pedido que nace entregado y cobrado.
 *
 * Orden: pedido (pendiente) → items → stock → cobro → caja → commit.
 *
 * El pedido nace 'pendiente'/'impago' y recién el último paso lo pasa a
 * 'entregado'/'pagado'. El stock va antes que el cobro porque es el paso con
 * más escrituras y el candidato más probable a fallar: si revienta ahí,
 * todavía no se registró plata en la caja. Y si algo falla igual, se revierte
 * todo: la rentabilidad (que mira 'entregado') y la caja (que mira los cobros)
 * nunca quedan viendo media venta.
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
    canal: 'mostrador_cic',
    modo_entrega: 'en_el_acto',   // se entrega y se cobra en el mismo momento
    direccion_entrega: null,
    costo_envio: 0,
    origen_web_id: null,
    fecha_pedido: fecha,
    fecha_entrega: fecha,
    estado: 'pendiente',
    total,
    descuento: 0,
    monto_cobrado: 0,
    estado_pago: 'impago',
    es_mostrador: true,           // no es un encargue: no va a la lista ni a la agenda
    created_by: auth.trabajadoraId,
    created_by_rol: auth.rol,     // el admin no tiene trabajadora_id (auditoría)
  });

  const stockTocado = [];

  try {
    await db.from('pedido_item').insert(lineas.map((l) => ({
      pedido_id: pedido.id,
      producto_id: l.producto.id,
      cantidad: l.cantidad,
      precio_unitario: l.producto.precio_venta,        // snapshot
      costo_unitario: calc.costoEfectivo(l.producto),  // snapshot
    })));

    // Se relee el producto en vez de usar el de state: la caché puede estar
    // vieja si vendieron desde otra pestaña, y esto es un SET, no un decremento
    for (const l of lineas) {
      const actual = await db.from('producto').select().eq('id', l.producto.id).single();

      await db.from('producto')
        .update({ stock_actual: (actual?.stock_actual ?? l.producto.stock_actual ?? 0) - l.cantidad })
        .eq('id', l.producto.id);

      stockTocado.push({ productoId: l.producto.id, cantidad: l.cantidad });

      await db.from('movimiento_stock_producto').insert({
        producto_id: l.producto.id,
        fecha: ahoraISO(),
        tipo: 'venta',
        cantidad: -l.cantidad,
        referencia_id: pedido.id,
      });
    }

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

    // Commit: a partir de acá la venta existe para la rentabilidad y la caja
    const confirmado = await db.from('pedido').update({
      estado: 'entregado',
      monto_cobrado: total,
      estado_pago: 'pagado',
    }).eq('id', pedido.id).single();

    return { pedido: confirmado ?? { ...pedido, estado: 'entregado', estado_pago: 'pagado' }, total };
  } catch (e) {
    await revertirVenta(pedido.id, stockTocado);
    throw e;
  }
}

async function totalVendidoHoy() {
  const pedidos = await db.from('pedido').select()
    .eq('fecha_entrega', hoyISO()).eq('estado', 'entregado');
  return pedidos.reduce((a, p) => a + (p.total || 0), 0);
}

/* ================================================================== */
/*  Vista — tab Pedidos                                                */
/* ================================================================== */

const SUBVISTAS = [
  { id: 'pedidos', etiqueta: 'Pedidos' },
  { id: 'agenda',  etiqueta: 'Agenda' },
  { id: 'venta',   etiqueta: 'Venta rápida' },
  { id: 'canal',   etiqueta: 'Catálogo online', permiso: 'gestionarCanalWeb' },
];

/** Las subvistas que el rol actual puede ver. */
const subvistasVisibles = () =>
  SUBVISTAS.filter((s) => !s.permiso || auth.puede(s.permiso));

/** Se recuerdan entre renders: volver de un modal no te saca de donde estabas. */
let subvista = null;
let filtroPedidos = 'abiertos';
let semanaAgenda = null;

const puedeCargar = () => auth.puede('cargarPedidos');
const verCostos = () => auth.puede('verCostos');

export async function render(vista) {
  // Para una trabajadora la pantalla de todos los días es el mostrador; para la
  // administración, la lista de pedidos.
  subvista ||= verCostos() ? 'pedidos' : 'venta';

  // Si el rol cambió y la subvista recordada ya no le corresponde, se vuelve a
  // la primera permitida en vez de renderizar una pantalla prohibida.
  const visibles = subvistasVisibles();
  if (!visibles.some((s) => s.id === subvista)) subvista = visibles[0].id;

  // La barra fija de la venta rápida solo existe mientras esa pantalla está
  // en primer plano: si queda puesta, tapa el final de las otras dos.
  const enVenta = subvista === 'venta';
  vista.classList.toggle('view--venta', enVenta);
  document.body.classList.toggle('venta-activa', enVenta);

  vista.innerHTML = `
    ${enVenta ? '' : `
      <div class="between" style="margin-bottom:var(--sp-4)">
        <h1 style="margin:0">Pedidos</h1>
      </div>`}
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

  const cont = vista.querySelector('#sub');
  if (subvista === 'pedidos') return pantallaPedidos(cont, vista);
  if (subvista === 'agenda')  return pantallaAgenda(cont, vista);
  if (subvista === 'canal')   return canalWeb.pantalla(cont);
  return pantallaVenta(cont, vista);
}

/** Recarga los datos y vuelve a pintar la vista activa (app.js escucha 'cambio'). */
const refrescar = () => state.invalidar();

/**
 * Botón flotante de la acción principal.
 * Va dentro de la vista, no en el body: así desaparece solo al cambiar de tab.
 */
function fab(cont, onClick, titulo, accent = 'pedidos') {
  const b = document.createElement('button');
  b.className = 'fab';
  b.dataset.accent = accent;
  b.setAttribute('aria-label', titulo);
  b.textContent = '+';
  b.addEventListener('click', onClick);
  cont.appendChild(b);
}

/**
 * Cablea un botón de guardar deshabilitándolo mientras corre.
 * Un doble tap dispara dos transacciones que leen antes de que ninguna escriba:
 * en entregar, eso descuenta el stock dos veces.
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
/*  1 · Pedidos                                                        */
/* ------------------------------------------------------------------ */

const FILTROS = [
  { id: 'abiertos',  etiqueta: 'Abiertos' },
  { id: 'entregados', etiqueta: 'Entregados' },
  { id: 'todos',     etiqueta: 'Todos' },
];

async function pantallaPedidos(cont, vista) {
  const [todos, items] = await Promise.all([
    db.from('pedido').select().order('fecha_entrega', { ascending: false }),
    db.from('pedido_item').select(),
  ]);

  // La venta rápida crea un pedido por cada venta de mostrador. Mezcladas con
  // los pedidos encargados, tapan la lista: son decenas por día y no hay nada
  // que hacer con ellas acá. Se ven en Caja y en el cierre.
  const encargados = todos.filter((p) => !esVentaRapida(p));

  if (!encargados.length) {
    cont.innerHTML = ui.vacio({
      modulo: 'pedidos', icono: '\u{1F4CB}', titulo: 'Sin pedidos cargados',
      texto: 'Acá entran los encargues por WhatsApp, del club o del CIC. '
           + 'Las ventas de mostrador se cargan en Venta rápida.',
    });
    if (puedeCargar()) fab(cont, () => modalPedido(null, vista), 'Nuevo pedido');
    return;
  }

  const alertas = await alertasPedidos();
  const cantidad = new Map();
  for (const it of items) cantidad.set(it.pedido_id, (cantidad.get(it.pedido_id) || 0) + 1);

  const visibles = encargados.filter((p) => (
    filtroPedidos === 'todos' ? true
      : filtroPedidos === 'entregados' ? p.estado === 'entregado'
        : ESTADOS_ABIERTOS.includes(p.estado)
  ));

  cont.innerHTML = `
    ${bloqueAlertas(alertas)}

    <div class="chips" style="margin-bottom:var(--sp-3)">
      ${FILTROS.map((f) => `
        <button class="chip ${f.id === filtroPedidos ? 'sel' : ''}" data-filtro="${f.id}">${f.etiqueta}</button>
      `).join('')}
    </div>

    ${visibles.length
      ? `<div class="lista">${visibles.map((p) => filaPedido(p, cantidad.get(p.id) || 0)).join('')}</div>`
      : '<p class="faint">No hay pedidos con ese filtro.</p>'}`;

  cont.querySelector('.chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filtro]');
    if (!b) return;
    filtroPedidos = b.dataset.filtro;
    pantallaPedidos(cont, vista);
  });

  cont.querySelectorAll('[data-pedido]').forEach((el) =>
    el.addEventListener('click', () => modalPedido(el.dataset.pedido, vista)));

  if (puedeCargar()) fab(cont, () => modalPedido(null, vista), 'Nuevo pedido');
}

/**
 * Una venta de mostrador es un pedido que nace y muere en el mismo tap.
 *
 * Se marca con un campo propio y no se deduce de la forma del pedido: con la
 * heurística "presencial + entregado + mismo día", un encargue del CIC que se
 * entregaba el día que se cargó desaparecía de la lista justo después de
 * entregarlo. Es una columna booleana más cuando esto pase a Postgres.
 */
const esVentaRapida = (p) => p.es_mostrador === true;

function bloqueAlertas({ enRiesgo, atrasados, cobroPendiente }) {
  const lineas = [];
  if (atrasados.length) {
    lineas.push(`<div class="alerta alerta--danger">${atrasados.length === 1
      ? 'Hay 1 pedido con la fecha de entrega vencida.'
      : `Hay ${atrasados.length} pedidos con la fecha de entrega vencida.`}</div>`);
  }
  if (enRiesgo.length) {
    lineas.push(`<div class="alerta alerta--warn">${enRiesgo.length === 1
      ? 'Hay 1 pedido que se entrega hoy y todavía no está listo.'
      : `Hay ${enRiesgo.length} pedidos que se entregan hoy y todavía no están listos.`}</div>`);
  }
  if (cobroPendiente.length) {
    lineas.push(`<div class="alerta alerta--warn">${cobroPendiente.length === 1
      ? 'Hay 1 pedido entregado hace más de una semana y sin cobrar.'
      : `Hay ${cobroPendiente.length} pedidos entregados hace más de una semana y sin cobrar.`}</div>`);
  }
  return lineas.join('');
}

function nombreCliente(clienteId) {
  return state.clientePorId(clienteId)?.nombre || 'Sin nombre';
}

function filaPedido(p, cantItems) {
  const e = ESTADO_PEDIDO[p.estado] || ESTADO_PEDIDO.pendiente;
  const pago = ESTADO_PAGO[p.estado_pago] || ESTADO_PAGO.impago;
  const hoy = hoyISO();
  const urgente = ESTADOS_ABIERTOS.includes(p.estado) && p.fecha_entrega <= hoy && p.estado !== 'listo';

  return `
    <button class="fila" data-pedido="${p.id}">
      <div class="fila__main">
        <div class="fila__titulo">${ui.esc(nombreCliente(p.cliente_id))}</div>
        <div class="fila__meta">
          <span class="${urgente ? 'danger' : ''}">
            ${p.fecha_entrega === hoy ? 'entrega hoy' : `entrega ${ui.fecha(p.fecha_entrega)}`}
          </span>
          <span class="dim">·</span>
          <span>${cantItems} ${cantItems === 1 ? 'producto' : 'productos'}</span>
          <span class="dim">·</span>
          <span class="num">${ui.money(p.total)}</span>
        </div>
        ${p.modo_entrega === 'en_el_acto' ? '' : `
          <div class="fila__meta">
            <span class="entrega entrega--${p.modo_entrega === 'domicilio' ? 'domicilio' : 'retira'}">
              ${etiquetaEntrega(p.modo_entrega)}
            </span>
            ${p.direccion_entrega ? `<span class="dim">${ui.esc(p.direccion_entrega)}</span>` : ''}
          </div>`}
      </div>
      <div class="fila__lado fila__lado--badges">
        <span class="badge ${e.badge}">${e.etiqueta}</span>
        ${p.estado === 'cancelado' ? '' : `<span class="badge ${pago.badge}">${pago.etiqueta}</span>`}
      </div>
    </button>`;
}

/* ------------------------------------------------------------------ */

async function modalPedido(pedidoId, vista) {
  if (!pedidoId) return modalNuevoPedido(null, vista);

  const detalle = await detallePedido(pedidoId);
  if (!detalle) return ui.toast('El pedido ya no existe', true);

  const { pedido, items, cobros, cliente } = detalle;
  const e = ESTADO_PEDIDO[pedido.estado] || ESTADO_PEDIDO.pendiente;
  const pago = ESTADO_PAGO[pedido.estado_pago] || ESTADO_PAGO.impago;
  const abierto = ESTADOS_ABIERTOS.includes(pedido.estado);
  const resta = Math.max(0, (pedido.total || 0) - (pedido.monto_cobrado || 0));
  const bruto = items.reduce((a, i) => a + i.precio_unitario * i.cantidad, 0);

  ui.abrirModal(`
    <div class="between">
      <h3 style="margin:0">${ui.esc(cliente?.nombre || 'Sin nombre')}</h3>
      <span class="badge ${e.badge}">${e.etiqueta}</span>
    </div>
    <p class="faint" style="margin-top:calc(var(--sp-2) * -1)">
      ${etiquetaCanal(pedido.canal)} · pedido del ${ui.fecha(pedido.fecha_pedido)} ·
      entrega ${ui.fecha(pedido.fecha_entrega)}
      ${cliente?.telefono ? ` · ${ui.esc(cliente.telefono)}` : ''}
    </p>
    ${pedido.notas ? `<p class="faint">${ui.esc(pedido.notas)}</p>` : ''}

    <div class="bloque">
      <div class="bloque__titulo">Qué lleva</div>
      <table class="table">
        <tbody>
          ${items.map((i) => {
            const p = state.productoPorId(i.producto_id);
            return `<tr>
              <td>${i.cantidad}× ${ui.esc(p?.nombre || 'producto dado de baja')}</td>
              <td class="num right">${ui.money(i.precio_unitario * i.cantidad)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${pedido.descuento > 0 ? `
        <div class="between" style="margin-top:var(--sp-2)">
          <span class="dim">Subtotal</span><span class="num dim">${ui.money(bruto)}</span>
        </div>
        <div class="between">
          <span class="dim">Descuento</span><span class="num dim">− ${ui.money(pedido.descuento)}</span>
        </div>` : ''}
      <div class="between" style="border-top:1px solid var(--border);margin-top:var(--sp-2);padding-top:var(--sp-2)">
        <span>Total</span><b class="num" style="font-size:1.2rem">${ui.money(pedido.total)}</b>
      </div>
      ${verCostos() ? bloqueMargen(items, pedido) : ''}
    </div>

    <div class="bloque">
      <div class="bloque__titulo">Cobros</div>
      ${cobros.length ? `
        <table class="table">
          <tbody>
            ${cobros.map((c) => `<tr>
              <td>${ui.fecha(c.fecha)} <span class="dim">${ui.esc(medioEtiqueta(c.medio))}</span></td>
              <td class="num right">${ui.money(c.monto)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<p class="faint" style="margin:0">Todavía no se cobró nada.</p>'}
      <div class="between" style="margin-top:var(--sp-2)">
        <span class="badge ${pago.badge}">${pago.etiqueta}</span>
        ${resta > 0 && pedido.estado !== 'cancelado'
          ? `<span class="num dim">faltan ${ui.money(resta)}</span>` : ''}
      </div>
    </div>

    ${pedido.estado === 'cancelado' ? '' : `
      ${abierto ? `
        <div class="bloque">
          <div class="bloque__titulo">Estado</div>
          <div class="chips" id="p-estados">
            ${ESTADOS_ABIERTOS.map((id) => `
              <button class="chip ${id === pedido.estado ? 'sel' : ''}" data-estado="${id}"
                ${puedeCargar() ? '' : 'disabled'}>${ESTADO_PEDIDO[id].etiqueta}</button>
            `).join('')}
          </div>
        </div>` : ''}

      ${puedeCargar() ? `
        <div class="stack" style="margin-top:var(--sp-5)">
          ${abierto ? `
            <button class="btn btn--primary btn--block" data-accent="pedidos" id="p-entregar">Marcar entregado</button>
            <button class="btn btn--block" id="p-editar">Editar pedido</button>` : ''}
          ${resta > 0 ? `<button class="btn btn--block" id="p-cobrar">Registrar cobro</button>` : ''}
          ${auth.puede('anularPedidos')
            ? '<button class="btn btn--danger btn--block" id="p-anular">Anular pedido</button>' : ''}
        </div>` : ''}`}
  `, (root) => {
    root.querySelector('#p-estados')?.addEventListener('click', async (ev) => {
      const chip = ev.target.closest('[data-estado]');
      if (!chip || chip.dataset.estado === pedido.estado) return;
      try {
        await cambiarEstadoPedido(pedidoId, chip.dataset.estado);
        ui.cerrarModal();
        await refrescar();
        ui.toast(`Pedido ${ESTADO_PEDIDO[chip.dataset.estado].etiqueta.toLowerCase()}`);
      } catch (err) { ui.toast(err.message, true); }
    });

    root.querySelector('#p-editar')?.addEventListener('click', () => modalNuevoPedido(detalle, vista));

    root.querySelector('#p-cobrar')?.addEventListener('click', () => modalCobro(pedido, resta));

    alGuardar(root.querySelector('#p-entregar'), async () => {
      try {
        await entregarPedido(pedidoId);
        ui.cerrarModal();
        await refrescar();
        // Entregar no cobra: son dos números distintos (regla 5)
        if (resta > 0) {
          ui.toast(`Entregado · faltan cobrar ${ui.money(resta)}`);
          const fresco = await db.from('pedido').select().eq('id', pedidoId).single();
          modalCobro(fresco, resta);
        } else {
          ui.toast('Pedido entregado');
        }
      } catch (err) { ui.toast(err.message, true); }
    });

    root.querySelector('#p-anular')?.addEventListener('click', () => modalAnular(pedido));
  });
}

const medioEtiqueta = (id) => MEDIOS.find((m) => m.id === id)?.etiqueta || id || '';

/** El margen del pedido, con los costos congelados. Solo para quien ve costos. */
function bloqueMargen(items, pedido) {
  const costo = items.reduce((a, i) => a + i.costo_unitario * i.cantidad, 0);

  // El envío no es venta de producto: entra al total que paga el cliente pero
  // sale del margen, o el día que se empiece a cobrar toda la rentabilidad por
  // producto queda inflada por el flete.
  const venta = (pedido.total || 0) - (pedido.costo_envio || 0);
  const m = calc.margen(venta, costo);
  return `
    <div class="between" style="margin-top:var(--sp-2)">
      <span class="faint">Costo de mercadería</span>
      <span class="num faint">${ui.money(costo)}</span>
    </div>
    <div class="between">
      <span class="faint">Margen</span>
      <span class="num faint">${ui.money(m.pesos)} · ${ui.pct(m.pct)}</span>
    </div>`;
}

/* ------------------------------------------------------------------ */

/**
 * Alta y edición de pedido. Es el formulario más cargado del sistema, así que
 * el orden sigue el de la conversación real: quién, para cuándo, qué lleva.
 *
 * @param {Object|null} detalle   el resultado de detallePedido() si es edición
 * @param {Object|null} borrador  lo cargado hasta ahora, para poder salir a
 *                                crear un cliente y volver sin perder nada.
 *                                El modal es uno solo: abrir el de cliente
 *                                destruye este formulario.
 */
function modalNuevoPedido(detalle = null, vista = null, borrador = null) {
  const edita = !!detalle?.pedido?.id;
  const pedido = detalle?.pedido || null;
  const productos = state.productos.filter((p) => p.activo);

  if (!productos.length) {
    return ui.abrirModal(`
      <h3>Sin productos</h3>
      <p class="dim">Cargá el catálogo en Producción antes de tomar pedidos.</p>
      <button class="btn btn--block" data-close>Cerrar</button>`);
  }

  // Copia de trabajo: nada se guarda hasta apretar Guardar
  const cantidades = borrador?.cantidades
    || new Map((detalle?.items || []).map((i) => [i.producto_id, i.cantidad]));
  let clienteId = borrador ? borrador.clienteId : (pedido?.cliente_id || null);
  let filtro = '';

  const valor = {
    canal: borrador?.canal || pedido?.canal || 'whatsapp',
    modoEntrega: borrador?.modoEntrega || pedido?.modo_entrega || 'retira_cic',
    direccion: borrador?.direccion ?? pedido?.direccion_entrega ?? '',
    fecha: borrador?.fecha || pedido?.fecha_entrega || hoyISO(),
    descuento: borrador?.descuento ?? pedido?.descuento ?? 0,
    notas: borrador?.notas ?? pedido?.notas ?? '',
  };

  ui.abrirModal(`
    <h3>${edita ? 'Editar pedido' : 'Nuevo pedido'}</h3>

    <div class="stack" style="margin-top:var(--sp-4)">
      <div class="field">
        <label for="p-cliente">Cliente</label>
        <input class="input" id="p-cliente" placeholder="Buscar por nombre o teléfono" autocomplete="off">
        <div class="chips" id="p-cliente-res" style="margin-top:var(--sp-2)"></div>
      </div>

      <div class="row">
        <div class="field grow">
          <label for="p-canal">Canal</label>
          <select class="input" id="p-canal">
            ${CANALES.map((c) => `<option value="${c.id}" ${c.id === valor.canal ? 'selected' : ''}>${c.etiqueta}</option>`).join('')}
          </select>
        </div>
        <div class="field grow">
          <label for="p-fecha">Se entrega</label>
          <input class="input" id="p-fecha" type="date" value="${valor.fecha}">
        </div>
      </div>

      <div class="field">
        <label for="p-entrega">Cómo lo recibe</label>
        <select class="input" id="p-entrega">
          ${MODOS_ENTREGA.map((m) => `
            <option value="${m.id}" ${m.id === valor.modoEntrega ? 'selected' : ''}>${m.etiqueta}</option>
          `).join('')}
        </select>
      </div>

      <div class="field ${valor.modoEntrega === 'domicilio' ? '' : 'hidden'}" id="p-campo-dir">
        <label for="p-direccion">Dirección de entrega</label>
        <input class="input" id="p-direccion" placeholder="Calle, número y entre calles"
               value="${ui.esc(valor.direccion)}">
      </div>

      <div>
        <label class="dim" style="font-size:.78rem">Qué lleva</label>
        <input class="input" id="p-buscar" placeholder="Filtrar productos" autocomplete="off"
               style="margin:var(--sp-2) 0">
        <div class="stack" id="p-productos"></div>
      </div>

      <div class="row">
        <div class="field grow">
          <label for="p-descuento">Descuento</label>
          <input class="input" id="p-descuento" type="number" inputmode="decimal" min="0" step="any"
                 value="${Number(valor.descuento) || 0}">
        </div>
        <div class="field grow">
          <label for="p-notas">Notas</label>
          <input class="input" id="p-notas" placeholder="opcional" value="${ui.esc(valor.notas)}">
        </div>
      </div>

      <div class="calculo" id="p-total">—</div>

      <button class="btn btn--primary btn--block" data-accent="pedidos" id="p-guardar">
        ${edita ? 'Guardar cambios' : 'Cargar pedido'}
      </button>
    </div>
  `, (root) => {
    const buscador = root.querySelector('#p-cliente');
    const resultados = root.querySelector('#p-cliente-res');
    const lista = root.querySelector('#p-productos');
    const salida = root.querySelector('#p-total');

    function pintarClientes() {
      const txt = buscador.value.trim().toLowerCase();
      const digitos = soloDigitos(txt);

      const encontrados = state.clientes.filter((c) => (
        !txt
          ? true
          : c.nombre.toLowerCase().includes(txt)
            || (digitos && soloDigitos(c.telefono).includes(digitos))
      )).slice(0, 6);

      const elegido = clienteId ? state.clientePorId(clienteId) : null;
      const enLista = encontrados.some((c) => c.id === clienteId);

      resultados.innerHTML = `
        <button class="chip ${clienteId ? '' : 'sel'}" data-cli="">Sin nombre</button>
        ${elegido && !enLista ? `<button class="chip sel" data-cli="${elegido.id}">${ui.esc(elegido.nombre)}</button>` : ''}
        ${encontrados.map((c) => `
          <button class="chip ${c.id === clienteId ? 'sel' : ''}" data-cli="${c.id}">${ui.esc(c.nombre)}</button>
        `).join('')}
        ${txt && auth.puede('gestionarClientes')
          ? `<button class="chip" data-nuevo="1">+ Crear «${ui.esc(buscador.value.trim())}»</button>` : ''}`;
    }

    function pintarProductos() {
      const txt = filtro.toLowerCase();
      const visibles = productos.filter((p) => !txt || p.nombre.toLowerCase().includes(txt));

      lista.innerHTML = visibles.length ? visibles.map((p) => {
        const q = cantidades.get(p.id) || 0;
        const stock = p.stock_actual || 0;
        return `
          <div class="between" data-prod="${p.id}">
            <div style="min-width:0">
              <div>${ui.esc(p.nombre)}</div>
              <div class="faint">${ui.money(p.precio_venta)}
                ${q > stock ? `<span class="danger">· hay ${stock}, hay que producir</span>` : `· hay ${stock}`}
              </div>
            </div>
            <input class="input cant-chica" type="number" inputmode="numeric" min="0" step="any"
                   value="${q || ''}" placeholder="0" aria-label="Cantidad de ${ui.esc(p.nombre)}">
          </div>`;
      }).join('') : '<p class="faint" style="margin:0">Ningún producto con ese nombre.</p>';

      pintarTotal();
    }

    function pintarTotal() {
      let bruto = 0;
      let unidades = 0;
      for (const [id, q] of cantidades) {
        const p = state.productoPorId(id);
        if (!p) continue;
        bruto += (p.precio_venta || 0) * q;
        unidades += q;
      }
      const desc = Number(root.querySelector('#p-descuento').value) || 0;
      salida.innerHTML = unidades
        ? `<div>${unidades} ${unidades === 1 ? 'unidad' : 'unidades'} ·
             <b class="num">${ui.money(Math.max(0, bruto - desc))}</b></div>
           ${desc > 0 ? `<div class="faint">${ui.money(bruto)} menos ${ui.money(desc)} de descuento</div>` : ''}`
        : '<span class="faint">Agregá productos para ver el total.</span>';
    }

    buscador.addEventListener('input', pintarClientes);

    /** Lo cargado hasta ahora, para volver acá después de crear el cliente. */
    const guardarBorrador = (extra = {}) => ({
      cantidades,
      clienteId,
      canal: root.querySelector('#p-canal').value,
      modoEntrega: root.querySelector('#p-entrega').value,
      direccion: root.querySelector('#p-direccion').value,
      fecha: root.querySelector('#p-fecha').value,
      descuento: root.querySelector('#p-descuento').value,
      notas: root.querySelector('#p-notas').value,
      ...extra,
    });

    resultados.addEventListener('click', (e) => {
      if (e.target.closest('[data-nuevo]')) {
        const enCurso = guardarBorrador();
        return modalCliente({ nombre: buscador.value.trim() }, async (creado) => {
          await state.cargar();
          modalNuevoPedido(detalle, vista, { ...enCurso, clienteId: creado.id });
        });
      }
      const chip = e.target.closest('[data-cli]');
      if (!chip) return;
      clienteId = chip.dataset.cli || null;
      pintarClientes();
    });

    root.querySelector('#p-buscar').addEventListener('input', (e) => {
      filtro = e.target.value.trim();
      pintarProductos();
    });

    lista.addEventListener('input', (e) => {
      const fila = e.target.closest('[data-prod]');
      if (!fila) return;
      const q = Number(e.target.value);
      if (q > 0) cantidades.set(fila.dataset.prod, q);
      else cantidades.delete(fila.dataset.prod);
      pintarTotal();
    });

    root.querySelector('#p-descuento').addEventListener('input', pintarTotal);

    // La dirección solo tiene sentido si sale a la calle.
    root.querySelector('#p-entrega').addEventListener('change', (e) => {
      const aDomicilio = e.target.value === 'domicilio';
      root.querySelector('#p-campo-dir').classList.toggle('hidden', !aDomicilio);
      if (aDomicilio) root.querySelector('#p-direccion').focus();
    });

    alGuardar(root.querySelector('#p-guardar'), async () => {
      const items = [...cantidades.entries()].map(([producto_id, cantidad]) => ({ producto_id, cantidad }));
      const datos = {
        canal: root.querySelector('#p-canal').value,
        modoEntrega: root.querySelector('#p-entrega').value,
        direccionEntrega: root.querySelector('#p-direccion').value,
        fechaEntrega: root.querySelector('#p-fecha').value,
        descuento: root.querySelector('#p-descuento').value,
        notas: root.querySelector('#p-notas').value,
        items,
      };

      try {
        if (edita) {
          await actualizarPedido(pedido.id, datos);
          ui.cerrarModal();
          await refrescar();
          ui.toast('Pedido actualizado');
          return;
        }

        const { faltantes } = await crearPedido({ ...datos, clienteId });
        ui.cerrarModal();
        await refrescar();
        ui.toast(faltantes.length
          ? 'Pedido cargado · falta producir'
          : 'Pedido cargado');
      } catch (err) {
        console.error(err);
        ui.toast(err.message || 'No se pudo guardar el pedido', true);
      }
    });

    pintarClientes();
    pintarProductos();
  });
}

/* ------------------------------------------------------------------ */

/** Hoja de cobro de un pedido. Sugiere el saldo, permite cobrar una seña. */
function modalCobro(pedido, resta) {
  let medio = null;

  ui.abrirModal(`
    <div class="cobro__label center">A cobrar</div>
    <div class="cobro__total">${ui.money(resta)}</div>
    <div class="cobro__detalle">
      ${ui.esc(nombreCliente(pedido.cliente_id))} ·
      total ${ui.money(pedido.total)}${pedido.monto_cobrado > 0 ? ` · ya pagó ${ui.money(pedido.monto_cobrado)}` : ''}
    </div>

    <div class="field">
      <label for="co-monto">Cuánto entra ahora</label>
      <input class="input" id="co-monto" type="number" inputmode="decimal" min="0" step="any" value="${resta}">
      <span class="faint">Si es una seña, poné menos y el resto queda pendiente.</span>
    </div>

    <div class="medios">
      ${MEDIOS.map((m) => `
        <button class="medio" data-medio="${m.id}">
          <svg viewBox="0 0 24 24">${m.svg}</svg>${m.etiqueta}
        </button>`).join('')}
    </div>

    <button class="btn--confirmar" id="co-ok" disabled>Confirmar cobro</button>
    <button class="btn btn--ghost btn--block" data-close
            style="margin-top:var(--sp-2);border:none">Cancelar</button>
  `, (root) => {
    const btn = root.querySelector('#co-ok');

    root.querySelectorAll('.medio').forEach((m) => m.addEventListener('click', () => {
      root.querySelectorAll('.medio').forEach((x) => x.classList.remove('sel'));
      m.classList.add('sel');
      medio = m.dataset.medio;
      btn.disabled = false;
    }));

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Guardando…';
      ui.bloquearModal();
      try {
        const r = await registrarCobro(pedido.id, {
          monto: root.querySelector('#co-monto').value, medio,
        });
        ui.bloquearModal(false);
        ui.cerrarModal();
        await refrescar();
        ui.toast(r.resta > 0
          ? `Cobrado · quedan ${ui.money(r.resta)}`
          : `Cobrado ${ui.money(r.cobro.monto)}`);
      } catch (err) {
        ui.bloquearModal(false);
        btn.disabled = false;
        btn.textContent = 'Confirmar cobro';
        ui.toast(err.message || 'No se pudo registrar el cobro', true);
      }
    });
  });
}

/** Anular pide motivo: es lo único que queda para entender qué pasó. */
function modalAnular(pedido) {
  const entregado = pedido.estado === 'entregado';
  const cobrado = pedido.monto_cobrado || 0;

  ui.abrirModal(`
    <h3>Anular el pedido</h3>
    <p class="dim" style="margin-top:calc(var(--sp-2) * -1)">
      ${ui.esc(nombreCliente(pedido.cliente_id))} · ${ui.money(pedido.total)}
    </p>

    <div class="alerta alerta--warn" style="margin-top:var(--sp-3)">
      ${entregado ? 'El producto vuelve al stock. ' : ''}
      ${cobrado > 0 ? `Se registra la devolución de ${ui.money(cobrado)} en la caja. ` : ''}
      El pedido deja de contar para la ganancia.
    </div>

    <div class="field">
      <label for="an-motivo">Motivo</label>
      <input class="input" id="an-motivo" placeholder="Se cargó mal, el cliente lo dio de baja…">
    </div>

    <button class="btn btn--danger btn--block" id="an-ok" style="margin-top:var(--sp-4)">Anular pedido</button>
    <button class="btn btn--ghost btn--block" data-close style="margin-top:var(--sp-2);border:none">Volver</button>
  `, (root) => {
    alGuardar(root.querySelector('#an-ok'), async () => {
      try {
        const r = await anularPedido(pedido.id, root.querySelector('#an-motivo').value);
        ui.cerrarModal();
        await refrescar();
        ui.toast(r.devuelto > 0 ? `Anulado · devolución ${ui.money(r.devuelto)}` : 'Pedido anulado');
      } catch (err) {
        ui.toast(err.message, true);
      }
    }, 'Anulando…');
  });
}

/* ------------------------------------------------------------------ */
/*  2 · Agenda de entregas                                             */
/* ------------------------------------------------------------------ */

const NOMBRE_DIA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

/** Las 7 fechas ISO de la semana que arranca en `lunes`. */
function fechasDeSemana(lunes) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(lunes);
    d.setDate(d.getDate() + i);
    return ui.hoyISO(d);
  });
}

/**
 * La pantalla que se mira cada mañana: qué hay que entregar esta semana y qué
 * día. Las ventas de mostrador no entran — no se entregan, ya se entregaron.
 */
async function pantallaAgenda(cont, vista) {
  semanaAgenda ||= ui.inicioSemana();
  const fechas = fechasDeSemana(semanaAgenda);
  const hoy = hoyISO();

  const [pedidos, items] = await Promise.all([
    pedidosDeSemana(fechas[0], fechas[6]),
    db.from('pedido_item').select(),
  ]);

  const agenda = pedidos.filter((p) => !esVentaRapida(p) && p.estado !== 'cancelado');
  const cantidad = new Map();
  for (const it of items) cantidad.set(it.pedido_id, (cantidad.get(it.pedido_id) || 0) + 1);

  cont.innerHTML = `
    <div class="semana-nav">
      <button data-semana="-1" aria-label="Semana anterior">‹</button>
      <span>${ui.fecha(fechas[0])} – ${ui.fecha(fechas[6])}</span>
      <button data-semana="1" aria-label="Semana siguiente">›</button>
    </div>

    ${agenda.length ? '' : '<p class="faint">No hay entregas agendadas esta semana.</p>'}

    ${fechas.map((fecha, i) => {
      const delDia = agenda.filter((p) => p.fecha_entrega === fecha);
      if (!delDia.length) return '';
      const total = delDia.reduce((a, p) => a + (p.total || 0), 0);
      return `
        <div class="agenda__dia ${fecha === hoy ? 'agenda__dia--hoy' : ''}">
          <div class="agenda__cabecera">
            <span class="agenda__fecha">${NOMBRE_DIA[i]} ${ui.fecha(fecha)}${fecha === hoy ? ' · hoy' : ''}</span>
            <span class="agenda__total">${delDia.length} · ${ui.money(total)}</span>
          </div>
          <div class="lista">
            ${delDia.map((p) => filaPedido(p, cantidad.get(p.id) || 0)).join('')}
          </div>
        </div>`;
    }).join('')}`;

  cont.querySelector('.semana-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-semana]');
    if (!b) return;
    const d = new Date(semanaAgenda);
    d.setDate(d.getDate() + 7 * Number(b.dataset.semana));
    semanaAgenda = d;
    pantallaAgenda(cont, vista);
  });

  cont.querySelectorAll('[data-pedido]').forEach((el) =>
    el.addEventListener('click', () => modalPedido(el.dataset.pedido, vista)));

  if (puedeCargar()) fab(cont, () => modalPedido(null, vista), 'Nuevo pedido');
}

/* ------------------------------------------------------------------ */
/*  3 · Venta rápida                                                   */
/* ------------------------------------------------------------------ */

/** Los tres que más compran, para no tener que escribir el nombre. */
let frecuentes = [];

async function pantallaVenta(cont) {
  carrito = {};
  const productos = state.productos.filter((p) => p.activo);

  if (!productos.length) {
    document.body.classList.remove('venta-activa');
    cont.innerHTML = ui.vacio({
      modulo: 'pedidos', icono: '\u{1F4E6}', titulo: 'Sin productos',
      texto: 'Cargá productos en el catálogo para poder vender.', fase: 'Fase 1',
    });
    return;
  }

  // Los chips de cliente eran los tres primeros por orden alfabético, así que
  // el club que compra todas las semanas no aparecía nunca.
  frecuentes = (await resumenClientes())
    .filter((r) => r.cantidad > 0)
    .sort((a, b) => b.cantidad - a.cantidad || b.total - a.total)
    .slice(0, 3)
    .map((r) => r.cliente);

  const porCategoria = productos.reduce((acc, p) => {
    (acc[p.categoria] ||= []).push(p);
    return acc;
  }, {});

  // Todo cuelga de un nodo propio, no del contenedor de la vista.
  // El <section> del shell es permanente: un listener colgado ahí sobrevive al
  // innerHTML y se acumula en cada render, así que después de dos vueltas un
  // tap sumaba dos empanadas y se cobraba el doble.
  cont.innerHTML = `
    <div id="venta-root">
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
      </div>
    </div>`;

  cablear(cont.querySelector('#venta-root'));
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

/** Convierte el carrito en las líneas que espera registrarVenta(). */
function lineasDelCarrito() {
  return Object.entries(carrito).map(([id, cantidad]) => ({
    producto: state.productoPorId(id),
    cantidad,
  }));
}

function abrirCobro(total, onListo) {
  const lineas = lineasDelCarrito();
  let medio = null;
  let clienteId = null;

  ui.abrirModal(`
    <div class="cobro__label center">Total a cobrar</div>
    <div class="cobro__total">${ui.money(total)}</div>

    <div class="cobro__detalle">${lineas
      .map((l) => `${l.cantidad}× ${ui.esc(l.producto.nombre)}`).join(' · ')}</div>

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

      // Mientras guarda no se puede cerrar la hoja: si se cerraba, el carrito
      // seguía cargado y la venta se podía confirmar por segunda vez.
      ui.bloquearModal();

      try {
        await registrarVenta({ lineas, medio, clienteId });
        carrito = {};                       // se vacía apenas la venta existe
        ui.bloquearModal(false);
        ui.cerrarModal();
        onListo(total);
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        btn.textContent = 'Confirmar venta';
        ui.bloquearModal(false);
        ui.toast('No se pudo registrar la venta', true);
      }
    });
  });
}

function cablear(root) {
  const barra = root.querySelector('#barra');
  const elItems = root.querySelector('#items');
  const elTotal = root.querySelector('#total');
  const btnCobrar = root.querySelector('#cobrar');

  const total = () => Object.entries(carrito)
    .reduce((a, [id, q]) => a + state.productoPorId(id).precio_venta * q, 0);
  const unidades = () => Object.values(carrito).reduce((a, q) => a + q, 0);

  function pintar() {
    const t = total(), n = unidades();
    elTotal.textContent = ui.money(t);
    elItems.textContent = n ? `${n} ${n === 1 ? 'item' : 'items'}` : 'Sin items';
    barra.classList.toggle('live', n > 0);
    btnCobrar.disabled = !n;
    root.querySelectorAll('.producto-card').forEach((b) => {
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

  // Al soltar después de un long-press, el navegador sintetiza un click.
  // Sin esta bandera ese click volvía a sumar y "mantener apretado para
  // restar" no hacía nada: bajaba uno y lo devolvía en el mismo gesto.
  let restadoAlMantener = false;

  root.addEventListener('click', (e) => {
    const card = e.target.closest('.producto-card');
    if (!card) return;
    if (restadoAlMantener) { restadoAlMantener = false; return; }
    sumar(card.dataset.id, e.target.closest('[data-menos]') ? -1 : 1);
  });

  // Mantener apretado también resta: no hay que apuntar al botón chico
  let timer = null;
  const cancelar = () => { if (timer) { clearTimeout(timer); timer = null; } };

  root.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.producto-card');
    if (!card) return;
    restadoAlMantener = false;
    timer = setTimeout(() => {
      sumar(card.dataset.id, -1);
      restadoAlMantener = true;
      timer = null;
    }, 480);
  }, { passive: true });

  ['touchend', 'touchcancel'].forEach((ev) =>
    root.addEventListener(ev, cancelar, { passive: true }));

  // Un dedo apoyado nunca queda perfectamente quieto: sin tolerancia, el
  // temblor cancelaba el long-press antes de llegar a los 480ms
  let desde = null;
  root.addEventListener('touchstart', (e) => {
    desde = e.touches[0] ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (!desde || !e.touches[0]) return cancelar();
    const dx = e.touches[0].clientX - desde.x;
    const dy = e.touches[0].clientY - desde.y;
    if (Math.hypot(dx, dy) > 12) cancelar();
  }, { passive: true });

  btnCobrar.addEventListener('click', () => {
    if (!unidades()) return;
    abrirCobro(total(), async (cobrado) => {
      await state.cargar();                                   // refresca el stock
      root.querySelector('#ventas-hoy').textContent = ui.money(await totalVendidoHoy());
      root.querySelectorAll('.producto-card').forEach((b) => {
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

/* ================================================================== */
/*  Vista — tab Clientes                                               */
/* ================================================================== */

let filtroClientes = '';

export async function renderClientes(vista) {
  const resumenes = await resumenClientes();

  if (!resumenes.length) {
    vista.innerHTML = ui.vacio({
      modulo: 'clientes', icono: '\u{1F465}', titulo: 'Sin clientes',
      texto: 'Quién compra, cada cuánto y cuánto gasta. Sirve para saber a quién '
           + 'conviene avisarle cuando hay producción.',
    });
    if (auth.puede('gestionarClientes')) {
      fab(vista, () => modalCliente(null, () => refrescar()), 'Nuevo cliente', 'clientes');
    }
    return;
  }

  const debe = resumenes.reduce((a, r) => a + r.impago, 0);

  vista.innerHTML = `
    <div class="between" style="margin-bottom:var(--sp-4)">
      <h1 style="margin:0">Clientes</h1>
    </div>

    ${debe > 0 ? `
      <div class="alerta alerta--warn">
        Hay <b class="num">${ui.money(debe)}</b> entregados y todavía sin cobrar.
      </div>` : ''}

    <input class="input" id="cli-buscar" placeholder="Buscar por nombre o teléfono"
           value="${ui.esc(filtroClientes)}" autocomplete="off"
           style="width:100%;margin-bottom:var(--sp-3)">

    <div id="cli-lista"></div>`;

  const lista = vista.querySelector('#cli-lista');

  // Se repinta solo la lista y no la vista entera: rearmar el innerHTML en cada
  // tecla le sacaba el foco al buscador y movía el cursor al final.
  function pintar() {
    const txt = filtroClientes.trim().toLowerCase();
    const digitos = soloDigitos(txt);
    const visibles = resumenes.filter((r) => (
      !txt ? true
        : r.cliente.nombre.toLowerCase().includes(txt)
          || (digitos && soloDigitos(r.cliente.telefono).includes(digitos))
    ));

    lista.innerHTML = visibles.length
      ? `<div class="lista">${visibles.map(filaCliente).join('')}</div>`
      : '<p class="faint">Ningún cliente con ese nombre.</p>';
  }

  vista.querySelector('#cli-buscar').addEventListener('input', (e) => {
    filtroClientes = e.target.value;
    pintar();
  });

  lista.addEventListener('click', (e) => {
    const fila = e.target.closest('[data-cliente]');
    if (fila) modalDetalleCliente(fila.dataset.cliente, vista);
  });

  pintar();

  if (auth.puede('gestionarClientes')) {
    fab(vista, () => modalCliente(null, () => refrescar()), 'Nuevo cliente', 'clientes');
  }
}

function filaCliente(r) {
  const seg = SEGMENTO[r.segmento] || SEGMENTO.nuevo;
  const tipo = TIPOS_CLIENTE.find((t) => t.id === r.cliente.tipo)?.etiqueta || '';

  return `
    <button class="fila" data-cliente="${r.cliente.id}">
      <div class="fila__main">
        <div class="fila__titulo">${ui.esc(r.cliente.nombre)}</div>
        <div class="fila__meta">
          <span>${r.cantidad} ${r.cantidad === 1 ? 'pedido' : 'pedidos'}</span>
          ${r.total > 0 ? `<span class="dim">·</span><span class="num">${ui.money(r.total)}</span>` : ''}
          ${r.ultimo ? `<span class="dim">·</span><span>último ${ui.fecha(r.ultimo)}</span>` : ''}
          ${tipo && r.cliente.tipo !== 'particular' ? `<span class="dim">·</span><span>${tipo}</span>` : ''}
        </div>
        ${r.impago > 0 ? `<div class="danger" style="font-size:.8rem">debe ${ui.money(r.impago)}</div>` : ''}
      </div>
      <div class="fila__lado"><span class="badge ${seg.badge}">${seg.etiqueta}</span></div>
    </button>`;
}

async function modalDetalleCliente(clienteId, vista) {
  const resumenes = await resumenClientes();
  const r = resumenes.find((x) => x.cliente.id === clienteId);
  if (!r) return;

  const c = r.cliente;
  const seg = SEGMENTO[r.segmento] || SEGMENTO.nuevo;
  const historial = [...r.pedidos].sort((a, b) => (a.fecha_pedido < b.fecha_pedido ? 1 : -1)).slice(0, 8);

  ui.abrirModal(`
    <div class="between">
      <h3 style="margin:0">${ui.esc(c.nombre)}</h3>
      <span class="badge ${seg.badge}">${seg.etiqueta}</span>
    </div>
    <p class="faint" style="margin-top:calc(var(--sp-2) * -1)">
      ${TIPOS_CLIENTE.find((t) => t.id === c.tipo)?.etiqueta || 'Particular'}
      ${c.telefono ? ` · ${ui.esc(c.telefono)}` : ''}
      ${c.direccion ? ` · ${ui.esc(c.direccion)}` : ''}
    </p>
    ${c.notas ? `<p class="faint">${ui.esc(c.notas)}</p>` : ''}

    <div class="stat-grid" style="margin-top:var(--sp-4)">
      <div class="stat"><div class="label">Pedidos</div><div class="value">${r.cantidad}</div></div>
      <div class="stat"><div class="label">Gastó</div><div class="value">${ui.money(r.total)}</div></div>
      <div class="stat"><div class="label">Ticket promedio</div><div class="value">${ui.money(r.ticket)}</div></div>
      <div class="stat"><div class="label">Debe</div>
        <div class="value ${r.impago > 0 ? 'danger' : ''}">${ui.money(r.impago)}</div></div>
    </div>

    ${historial.length ? `
      <div class="bloque">
        <div class="bloque__titulo">Últimos pedidos</div>
        <div class="lista">
          ${historial.map((p) => {
            const e = ESTADO_PEDIDO[p.estado] || ESTADO_PEDIDO.pendiente;
            return `
              <button class="fila" data-ped="${p.id}">
                <div class="fila__main">
                  <div class="fila__titulo">${ui.fecha(p.fecha_pedido)}</div>
                  <div class="fila__meta"><span class="num">${ui.money(p.total)}</span></div>
                </div>
                <div class="fila__lado"><span class="badge ${e.badge}">${e.etiqueta}</span></div>
              </button>`;
          }).join('')}
        </div>
      </div>` : ''}

    <div class="stack" style="margin-top:var(--sp-5)">
      ${puedeCargar() ? '<button class="btn btn--primary btn--block" data-accent="clientes" id="c-pedido">Nuevo pedido</button>' : ''}
      ${auth.puede('gestionarClientes') ? '<button class="btn btn--block" id="c-editar">Editar cliente</button>' : ''}
    </div>
  `, (root) => {
    root.querySelectorAll('[data-ped]').forEach((el) =>
      el.addEventListener('click', () => modalPedido(el.dataset.ped, vista)));

    root.querySelector('#c-editar')?.addEventListener('click', () =>
      modalCliente(c, () => refrescar()));

    root.querySelector('#c-pedido')?.addEventListener('click', () => {
      ui.cerrarModal();
      modalNuevoPedido({ pedido: { cliente_id: c.id, canal: 'whatsapp' }, items: [] }, vista);
    });
  });
}

/**
 * Alta y edición de cliente.
 * @param {Function} onGuardado  recibe el cliente guardado
 */
function modalCliente(cliente = null, onGuardado = null) {
  const nuevo = !cliente?.id;

  ui.abrirModal(`
    <h3>${nuevo ? 'Nuevo cliente' : 'Editar cliente'}</h3>
    <div class="stack" style="margin-top:var(--sp-4)">
      <div class="field">
        <label for="cl-nombre">Nombre</label>
        <input class="input" id="cl-nombre" value="${ui.esc(cliente?.nombre || '')}" autocomplete="off">
      </div>
      <div class="row">
        <div class="field grow">
          <label for="cl-tel">Teléfono</label>
          <input class="input" id="cl-tel" type="tel" value="${ui.esc(cliente?.telefono || '')}">
        </div>
        <div class="field grow">
          <label for="cl-tipo">Tipo</label>
          <select class="input" id="cl-tipo">
            ${TIPOS_CLIENTE.map((t) => `<option value="${t.id}" ${t.id === cliente?.tipo ? 'selected' : ''}>${t.etiqueta}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label for="cl-dir">Dirección</label>
        <input class="input" id="cl-dir" placeholder="opcional" value="${ui.esc(cliente?.direccion || '')}">
      </div>
      <div class="field">
        <label for="cl-notas">Notas</label>
        <input class="input" id="cl-notas" placeholder="Alergias, referencia de zona…"
               value="${ui.esc(cliente?.notas || '')}">
      </div>
      <button class="btn btn--primary btn--block" data-accent="clientes" id="cl-guardar">Guardar</button>
    </div>
  `, (root) => {
    alGuardar(root.querySelector('#cl-guardar'), async () => {
      try {
        const guardado = await guardarCliente({
          id: cliente?.id || null,
          nombre: root.querySelector('#cl-nombre').value,
          telefono: root.querySelector('#cl-tel').value,
          direccion: root.querySelector('#cl-dir').value,
          tipo: root.querySelector('#cl-tipo').value,
          notas: root.querySelector('#cl-notas').value,
        });
        ui.cerrarModal();
        await state.cargar();
        ui.toast(nuevo ? 'Cliente agregado' : 'Cambios guardados');
        await onGuardado?.(guardado);
      } catch (err) {
        ui.toast(err.message || 'No se pudo guardar', true);
      }
    });
  });
}
