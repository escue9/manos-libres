/**
 * trabajadoras.js — Equipo · Registro semanal · Liquidación
 * Color del módulo: verde var(--equipo)
 *
 * FASE 3 — ver docs/PDR.md §4.3
 *
 * Desde octubre de 2026 se cobra POR PRODUCCIÓN, no por día: cada producto
 * tiene su pago por unidad y quien lo produce lo cobra (pago_produccion, que
 * nace al cerrar una orden en produccion.js). Las jornadas quedan como registro
 * de asistencia, sin plata. Lo ya pagado por día queda en el histórico.
 *
 * Reglas que sostienen este módulo:
 *  - Una jornada por trabajadora por fecha (PDR §3)
 *  - Solo lo producido y confirmado entra a la liquidación. Lo que carga una
 *    trabajadora espera la confirmación de la administración
 *  - El monto por unidad se congela al cerrar la orden: subir el pago de un
 *    producto no cambia lo que ya se produjo
 *  - El egreso en caja de la liquidación se genera solo (regla 6)
 *  - Privacidad (regla 8): una trabajadora ve solo lo suyo. Nunca la tarifa,
 *    los días ni la liquidación de otra
 */

import { db } from '../db.js';
import { state } from '../state.js';
import { auth, ROLES } from '../auth.js';
import { ui } from '../ui.js';
import * as calc from '../calc.js';

const DIAS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const NOMBRE_DIA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

/**
 * Qué implica cada rol, en una línea.
 *
 * La LISTA de roles y sus etiquetas viven en auth.js, que es donde están los
 * permisos de verdad; acá queda solo esta ayuda, que es texto de pantalla y no
 * tiene por qué estar en la capa de permisos. Un rol nuevo en PERMISOS aparece
 * solo en el select: si se olvidan de escribirle la ayuda, se muestra sin ella
 * en vez de no aparecer.
 */
const AYUDA_ROL = {
  admin:       'Ve todo: costos, márgenes, caja y el equipo completo. Liquida.',
  trabajadora: 'Cocina, vende y cobra. Ve solo lo que produjo ella y su total.',
  dirigente:   'Solo lectura de caja y rentabilidad. No opera nada.',
};

const ROL_POR_DEFECTO = 'trabajadora';

const rolDe = (t) => (auth.rolValido(t?.rol) ? t.rol : ROL_POR_DEFECTO);

/**
 * Con forma de mail y nada más.
 *
 * Validar direcciones "bien" es un pozo sin fondo y no sirve para nada acá: el
 * mail no se usa para escribirle a nadie, es la llave con la que el servidor
 * aparea la persona con su usuario. Lo único que importa es atajar el dedazo
 * (falta la arroba, sobra un espacio) antes de que el sync se coma el error.
 */
const FORMA_DE_MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Semana que se está mirando. Se recuerda entre renders. */
let semana = null;

const esAdmin = () => auth.puede('verEquipoCompleto');

/** Las 7 fechas ISO de la semana que arranca en `lunes`. */
function fechasDeSemana(lunes) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(lunes);
    d.setDate(d.getDate() + i);
    return ui.hoyISO(d);
  });
}

/* ================================================================== */
/*  Transacciones                                                      */
/* ================================================================== */

/** Cuántos días para atrás puede autoreportar una trabajadora. */
const DIAS_AUTOREPORTE = 14;

/**
 * Marca o desmarca una jornada. Es un toggle: si ya existe, la borra.
 *
 * El origen NO es un parámetro: se deriva del rol de quien llama. Cuando era
 * un parámetro, pasarle cualquier valor que no fuera 'admin' ni 'autoreporte'
 * salteaba las dos validaciones, y desde la consola una trabajadora podía
 * borrar y crear jornadas a nombre de otra — y usar el 'creada'/'borrada' que
 * devuelve como oráculo para reconstruirle la semana entera.
 *
 * @returns {Promise<{accion:'creada'|'borrada', jornada?:Object}>}
 */
export async function marcarJornada(trabajadoraId, fecha) {
  const admin = esAdmin();
  if (admin) auth.exigir('liquidar');
  else if (auth.trabajadoraId !== trabajadoraId) {
    throw new Error('Solo podés marcar tus propias jornadas');
  }
  const origen = admin ? 'admin' : 'autoreporte';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) throw new Error('Fecha inválida');

  const hoy = ui.hoyISO();
  if (fecha > hoy) throw new Error('No se puede marcar un día que todavía no pasó');

  if (!admin) {
    const limite = ui.hoyISO(new Date(Date.now() - DIAS_AUTOREPORTE * 864e5));
    if (fecha < limite) {
      throw new Error(`Solo podés marcar los últimos ${DIAS_AUTOREPORTE} días. Avisale a la administración`);
    }
  }

  const existentes = await db.from('jornada').select()
    .eq('trabajadora_id', trabajadoraId).eq('fecha', fecha);

  if (existentes.length) {
    const j = existentes[0];
    if (j.estado_pago === 'pagada') throw new Error('Esa jornada ya está liquidada');
    // Las que nacen de una orden se desasignan desde la orden, no de acá
    if (j.orden_produccion_id) throw new Error('Esa jornada viene de una orden de producción');
    // Un tap sin querer no puede borrar lo que la administración ya revisó
    if (!admin && j.confirmada) throw new Error('Ese día ya lo confirmó la administración');
    await db.from('jornada').delete().eq('id', j.id);
    return { accion: 'borrada' };
  }

  const trabajadora = await db.from('trabajadora').select().eq('id', trabajadoraId).single();
  if (!trabajadora) throw new Error('Trabajadora inexistente');

  const jornada = await db.from('jornada').insert({
    trabajadora_id: trabajadoraId,
    fecha,
    orden_produccion_id: null,
    tarifa_aplicada: 0,                 // asistencia: lo que se cobra es lo producido
    origen_carga: origen,
    confirmada: origen === 'admin',   // el autoreporte espera confirmación
    estado_pago: 'pendiente',
  });

  return { accion: 'creada', jornada };
}

/** El admin confirma un autoreporte. Recién ahí cuenta para la liquidación. */
export async function confirmarJornada(jornadaId, confirmada = true) {
  auth.exigir('liquidar');

  const j = await db.from('jornada').select().eq('id', jornadaId).single();
  if (!j) throw new Error('Jornada inexistente');

  // Desconfirmar algo ya pagado saca el jornal del costo laboral pero deja el
  // egreso en la caja: la rentabilidad y la caja dejarían de cerrar (regla 5)
  if (j.estado_pago === 'pagada') throw new Error('Esa jornada ya está liquidada');

  await db.from('jornada').update({ confirmada }).eq('id', jornadaId);
  return db.from('jornada').select().eq('id', jornadaId).single();
}

/**
 * El admin confirma lo que cargó una trabajadora al cerrar una orden. Recién
 * ahí cuenta para la liquidación — el mismo circuito que el autoreporte.
 */
export async function confirmarPago(pagoId, confirmada = true) {
  auth.exigir('liquidar');

  const p = await db.from('pago_produccion').select().eq('id', pagoId).single();
  if (!p) throw new Error('Esa producción no existe');
  if (p.estado_pago === 'pagada') throw new Error('Esa producción ya está liquidada');

  await db.from('pago_produccion').update({ confirmada }).eq('id', pagoId);
  return db.from('pago_produccion').select().eq('id', pagoId).single();
}

/**
 * Liquida la semana: marca como pagado lo producido y genera UN egreso en caja.
 *
 * Entra lo confirmado y pendiente de pago, de la semana y de días que ya
 * pasaron. Lo sin confirmar queda afuera y sigue disponible para la próxima.
 *
 * Las jornadas con tarifa son de antes de cobrar por producción: si quedó
 * alguna confirmada sin pagar, se paga con su tarifa congelada. Las de ahora
 * tienen tarifa cero y no se tocan — son asistencia, no plata.
 */
export async function liquidarSemana(desde, hasta, { medio = 'efectivo' } = {}) {
  auth.exigir('liquidar');

  const [jornadas, pagos] = await Promise.all([
    db.from('jornada').select().gte('fecha', desde).lte('fecha', hasta),
    db.from('pago_produccion').select().gte('fecha', desde).lte('fecha', hasta),
  ]);

  // Nunca se paga un día que todavía no pasó, venga de donde venga.
  const hoy = ui.hoyISO();
  const pendiente = (x) => x.confirmada && x.estado_pago !== 'pagada' && x.fecha <= hoy;
  const pagosAPagar = pagos.filter(pendiente);
  const jornadasAPagar = jornadas.filter((j) => pendiente(j) && (j.tarifa_aplicada || 0) > 0);

  if (!pagosAPagar.length && !jornadasAPagar.length) {
    throw new Error('No hay producción confirmada para liquidar');
  }

  const total = pagosAPagar.reduce((a, p) => a + (p.total || 0), 0)
    + jornadasAPagar.reduce((a, j) => a + (j.tarifa_aplicada || 0), 0);
  const unidades = pagosAPagar.reduce((a, p) => a + (p.cantidad || 0), 0);

  for (const p of pagosAPagar) {
    await db.from('pago_produccion').update({ estado_pago: 'pagada', fecha_pago: hoy }).eq('id', p.id);
  }
  for (const j of jornadasAPagar) {
    await db.from('jornada').update({ estado_pago: 'pagada', fecha_pago: hoy }).eq('id', j.id);
  }

  // Automático por la regla 6: nunca se carga a mano
  await db.from('movimiento_caja').insert({
    unidad_negocio_id: state.unidadNegocio.id,
    fecha: hoy,
    tipo: 'egreso',
    origen: 'jornal',
    referencia_id: null,
    monto: total,
    descripcion: `Liquidación ${ui.fecha(desde)} – ${ui.fecha(hasta)} · ${unidades} unidades producidas`,
    medio,
  });

  return {
    total,
    unidades,
    lineas: pagosAPagar.length,
    jornadas: jornadasAPagar.length,
    porTrabajadora: agruparPorTrabajadora(pagosAPagar, jornadasAPagar),
  };
}

function agruparPorTrabajadora(pagos, jornadas = []) {
  const m = new Map();
  const de = (id) => {
    if (!m.has(id)) m.set(id, { unidades: 0, total: 0 });
    return m.get(id);
  };
  for (const p of pagos) {
    const e = de(p.trabajadora_id);
    e.unidades += p.cantidad || 0;
    e.total += p.total || 0;
  }
  for (const j of jornadas) de(j.trabajadora_id).total += j.tarifa_aplicada || 0;
  return [...m.entries()].map(([trabajadora_id, v]) => ({ trabajadora_id, ...v }));
}

/**
 * ¿Ese mail ya lo usa otra persona del equipo?
 *
 * Mismo problema que `auth._pinEnUso()` y misma forma de resolverlo. Postgres
 * tiene un índice único sobre `lower(email)` (20260805_identidad.sql), así que
 * la segunda fila con el mismo mail la rechaza el servidor — pero eso pasa
 * cuando corre el sync, horas después, lejos de la persona que se equivocó y
 * con un mensaje que nadie va a leer en la cocina. Avisar acá, con el modal
 * todavía abierto, es la diferencia entre un error y un dato mal cargado.
 *
 * Case-insensitive igual que el índice: `Maria@` y `maria@` son la misma.
 * Se miran TODAS, también las inactivas: al índice no le importa el alta.
 */
async function emailEnUso(email, exceptoTrabajadoraId = null) {
  const buscado = email.toLowerCase();
  const todas = await db.from('trabajadora').select();
  return todas.some((t) => (t.email || '').toLowerCase() === buscado && t.id !== exceptoTrabajadoraId);
}

/**
 * Alta o edición de trabajadora.
 *
 * Si cambia la tarifa deja fila en tarifa_historica desde hoy. Las jornadas ya
 * cargadas no se tocan: cada una guarda la tarifa con la que nació.
 *
 * `email` y `rol` son la identidad de la persona ante el servidor (Fase 5 §4.1).
 * Ojo con la diferencia entre no mandarlos y mandarlos vacíos: `undefined` es
 * "no los toques" y `''` es "borralo". Sin esa distinción, cualquier llamada que
 * no los conozca —un alta desde otro módulo, un test viejo— le borraría el mail
 * a la persona de refilón y la dejaría sin usuario del otro lado.
 */
export async function guardarTrabajadora({
  id = null, nombre, telefono = '', fechaIngreso = null, activa = true,
  email, rol,
} = {}) {
  auth.exigir('liquidar');

  // Ya no hay tarifa por día: se cobra por producción (pago_produccion). La
  // columna tarifa_dia queda en cero para las nuevas y como estaba para las
  // viejas, que es lo que explica sus jornadas pagadas del histórico.
  nombre = String(nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre');

  const tocaEmail = email !== undefined;
  const tocaRol = rol !== undefined;

  // En minúscula desde el vamos: es como lo guarda Supabase y como lo compara
  // el índice único. Guardarlo tal cual lo tipearon deja dos verdades distintas
  // del mismo mail según de qué lado se mire.
  const mail = tocaEmail ? String(email ?? '').trim().toLowerCase() : null;
  const rolNuevo = tocaRol ? String(rol ?? '').trim() : null;

  if (tocaRol && !auth.rolValido(rolNuevo)) {
    throw new Error('Ese rol no existe');
  }
  if (mail) {
    if (!FORMA_DE_MAIL.test(mail)) throw new Error('Ese mail está mal escrito');
    if (await emailEnUso(mail, id)) throw new Error('Ese mail ya es de otra persona del equipo');
  }

  if (!id) {
    const t = await db.from('trabajadora').insert({
      unidad_negocio_id: state.unidadNegocio.id,
      nombre, telefono,
      email: mail || null,
      rol: rolNuevo || ROL_POR_DEFECTO,
      tarifa_dia: 0,
      fecha_ingreso: fechaIngreso || ui.hoyISO(),
      activa,
    });
    return t;
  }

  const cambios = { nombre, telefono, activa };
  if (tocaEmail) cambios.email = mail || null;
  if (tocaRol) cambios.rol = rolNuevo;
  await db.from('trabajadora').update(cambios).eq('id', id);
  return db.from('trabajadora').select().eq('id', id).single();
}

/**
 * Resumen de la semana, ya filtrado por rol: una trabajadora ve solo lo suyo.
 *
 * Por persona: los días que vino (asistencia, sin plata), lo que produjo y lo
 * que cobra. `total` y `pendiente` cuentan solo lo confirmado; lo que cargó
 * ella misma y todavía no se confirmó va aparte en `sinConfirmar`.
 */
export async function resumenSemana(desde, hasta) {
  const [jornadas, pagos] = await Promise.all([
    db.from('jornada').select().gte('fecha', desde).lte('fecha', hasta),
    db.from('pago_produccion').select().gte('fecha', desde).lte('fecha', hasta),
  ]).then(([j, p]) => [auth.filtrarPropio(j), auth.filtrarPropio(p)]);

  // state.trabajadoras trae solo las activas. Si alguien produjo el lunes y la
  // dieron de baja el miércoles, se liquida igual —liquidarSemana no filtra
  // por activa— y tiene que aparecer acá, o el admin ve un total y la caja
  // registra otro.
  const conMovimiento = [...new Set([...jornadas, ...pagos].map((x) => x.trabajadora_id))]
    .filter((id) => !state.trabajadoras.some((t) => t.id === id));

  const inactivas = conMovimiento.length
    ? (await db.from('trabajadora').select()).filter((t) => conMovimiento.includes(t.id))
    : [];

  const todas = [...state.trabajadoras, ...inactivas];
  const visibles = esAdmin()
    ? todas
    : todas.filter((t) => t.id === auth.trabajadoraId);

  const suma = (xs, campo) => xs.reduce((a, x) => a + (x[campo] || 0), 0);

  const filas = visibles.map((t) => {
    const susJornadas = jornadas.filter((j) => j.trabajadora_id === t.id);
    const susPagos = pagos.filter((p) => p.trabajadora_id === t.id);
    const pagosOk = susPagos.filter((p) => p.confirmada);
    // Jornadas con tarifa: solo las de antes del cambio
    const jornalesOk = susJornadas.filter((j) => j.confirmada && (j.tarifa_aplicada || 0) > 0);

    const porProducto = new Map();
    for (const p of pagosOk) {
      const e = porProducto.get(p.producto_id) || { producto_id: p.producto_id, unidades: 0, total: 0 };
      e.unidades += p.cantidad || 0;
      e.total += p.total || 0;
      porProducto.set(p.producto_id, e);
    }

    return {
      trabajadora: t,
      jornadas: susJornadas,
      pagos: susPagos,
      dias: susJornadas.filter((j) => j.confirmada).length,
      diasSinConfirmar: susJornadas.filter((j) => !j.confirmada).length,
      unidades: suma(pagosOk, 'cantidad'),
      porProducto: [...porProducto.values()],
      sinConfirmar: susPagos.filter((p) => !p.confirmada).length,
      total: suma(pagosOk, 'total') + suma(jornalesOk, 'tarifa_aplicada'),
      pendiente: suma(pagosOk.filter((p) => p.estado_pago !== 'pagada'), 'total')
        + suma(jornalesOk.filter((j) => j.estado_pago !== 'pagada'), 'tarifa_aplicada'),
    };
  });

  return {
    filas,
    total: suma(filas, 'total'),
    pendiente: suma(filas, 'pendiente'),
    sinConfirmar: suma(filas, 'sinConfirmar'),
    unidades: suma(filas, 'unidades'),
  };
}

/* ================================================================== */
/*  Liquidaciones pagadas — histórico y comprobante                    */
/* ================================================================== */

/**
 * Las liquidaciones ya pagadas: una por trabajadora y por fecha de pago, la
 * más nueva primero. Ya filtradas por rol.
 *
 * No hay tabla `liquidacion` y no hace falta: liquidarSemana() le pone la
 * misma `fecha_pago` a todo el lote, así que (trabajadora, fecha_pago) es la
 * liquidación tal como la vivió quien cobró. Si a la misma persona se le
 * pagan dos lotes el mismo día, salen juntos en un comprobante: es la plata
 * que recibió ese día, y eso es lo que tiene que decir el papel.
 *
 * Junta dos fuentes que no se pisan:
 *  - `pago_produccion` pagado: lo de ahora, por unidad producida
 *  - `jornada` pagada CON tarifa: lo de antes de octubre de 2026, por día. Es
 *    histórico real y tiene que seguir apareciendo. Las jornadas de ahora
 *    tienen tarifa cero y son asistencia: no se listan ni suman
 * Cada fila de cada tabla se cuenta una sola vez, así que la misma plata no
 * puede aparecer dos veces.
 *
 * Sale de esas tablas y no de `movimiento_caja` por dos razones: el egreso es
 * uno solo por todo el equipo (regla 6) y no dice cuánto fue de cada una; y una
 * trabajadora no ve la caja (regla 8), pero lo suyo sí.
 *
 * Los montos son los congelados en cada fila —`total` del pago, `tarifa_aplicada`
 * de la jornada—. Nunca el pago de hoy (regla 4): si sube lo que se paga por una
 * empanada, lo que cobró en julio sigue diciendo lo que cobró en julio.
 */
export async function liquidacionesPagadas({ trabajadoraId = null } = {}) {
  // filtrarPropio va antes que nada: lo que no pasa de acá no existe para la
  // pantalla, ni para el comprobante, ni para el texto de WhatsApp
  const [pagosCrudos, jornadasCrudas] = await Promise.all([
    db.from('pago_produccion').select().eq('estado_pago', 'pagada'),
    db.from('jornada').select().eq('estado_pago', 'pagada'),
  ]);
  const deQuien = (xs) => (trabajadoraId ? xs.filter((x) => x.trabajadora_id === trabajadoraId) : xs);
  const pagos = deQuien(auth.filtrarPropio(pagosCrudos));
  const jornales = deQuien(auth.filtrarPropio(jornadasCrudas))
    .filter((j) => (j.tarifa_aplicada || 0) > 0);

  // El admin necesita también a las que ya no trabajan: cobraron igual. Una
  // trabajadora no pide la lista del equipo, solo su propia ficha.
  const fichas = esAdmin()
    ? await db.from('trabajadora').select()
    : await db.from('trabajadora').select().eq('id', auth.trabajadoraId);
  const porId = new Map(fichas.map((t) => [t.id, t]));

  const grupos = new Map();
  const grupo = (x) => {
    const clave = `${x.trabajadora_id}|${x.fecha_pago || ''}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, { trabajadora_id: x.trabajadora_id, fecha_pago: x.fecha_pago, pagos: [], jornales: [] });
    }
    return grupos.get(clave);
  };
  for (const p of pagos) grupo(p).pagos.push(p);
  for (const j of jornales) grupo(j).jornales.push(j);

  return [...grupos.values()].map((g) => {
    // Una línea por producto y monto congelado: si el pago de la empanada
    // cambió entre dos órdenes del mismo lote, son dos líneas y la cuenta da
    const porLinea = new Map();
    for (const p of g.pagos) {
      const k = `${p.producto_id}|${p.pago_unitario}`;
      const e = porLinea.get(k) || {
        producto_id: p.producto_id, producto: nombreProducto(p.producto_id),
        pago_unitario: p.pago_unitario || 0, unidades: 0, total: 0,
      };
      e.unidades += p.cantidad || 0;
      e.total += p.total || 0;
      porLinea.set(k, e);
    }
    const fechas = [...g.pagos, ...g.jornales].map((x) => x.fecha).sort();
    const ficha = porId.get(g.trabajadora_id);

    return {
      trabajadora_id: g.trabajadora_id,
      nombre: ficha?.nombre || '—',
      telefono: ficha?.telefono || '',
      fecha_pago: g.fecha_pago,
      desde: fechas[0],
      hasta: fechas[fechas.length - 1],
      unidades: g.pagos.reduce((a, p) => a + (p.cantidad || 0), 0),
      lineas: [...porLinea.values()].sort((a, b) => a.producto.localeCompare(b.producto)),
      jornales: g.jornales
        .map((j) => ({ fecha: j.fecha, tarifa_aplicada: j.tarifa_aplicada }))
        .sort((a, b) => a.fecha.localeCompare(b.fecha)),
      total: g.pagos.reduce((a, p) => a + (p.total || 0), 0)
        + g.jornales.reduce((a, j) => a + (j.tarifa_aplicada || 0), 0),
    };
  }).sort((a, b) => (b.fecha_pago || '').localeCompare(a.fecha_pago || '')
                 || a.nombre.localeCompare(b.nombre));
}

/**
 * Una liquidación puntual, para el comprobante.
 *
 * Valida de nuevo aunque liquidacionesPagadas() ya filtre: el botón de la
 * pantalla lleva el id en un data-attribute, y desde la consola se puede
 * llamar con cualquiera. Mismo criterio que marcarJornada().
 */
export async function comprobanteLiquidacion(trabajadoraId, fechaPago) {
  if (!esAdmin() && trabajadoraId !== auth.trabajadoraId) {
    throw new Error('Solo podés ver tus propias liquidaciones');
  }
  const liq = (await liquidacionesPagadas({ trabajadoraId }))
    .find((l) => l.fecha_pago === fechaPago);
  if (!liq) throw new Error('No hay una liquidación pagada ese día');
  return liq;
}

/* --- el comprobante en sí --- */

const PIE_COMPROBANTE = 'Manos Libres · Cocina comunitaria del CIC Barrio Movediza · '
  + 'Federación de Organizaciones Sociales «Mesa Solidaria Tandil»';

/** dd/mm/aaaa. ui.fecha() no lleva año y un comprobante sin año no sirve. */
function fechaCompleta(iso) {
  const [a, m, d] = String(iso || '').split('-').map(Number);
  if (!a || !m || !d) return '—';
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}`;
}

function nombreDia(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return NOMBRE_DIA[(new Date(a, m - 1, d).getDay() + 6) % 7];
}

const plural = (n, uno, varios) => `${ui.cantidad(n)} ${n === 1 ? uno : varios}`;

/**
 * El título dice lo que se pagó. Una liquidación vieja, de antes de cobrar por
 * producción, era por días: llamarla "por producción" sería reescribirla.
 */
const tituloComprobante = (liq) => (liq.lineas.length
  ? 'Comprobante de pago por producción'
  : 'Comprobante de pago de jornadas');

/**
 * El comprobante en texto plano, para mandar por WhatsApp.
 *
 * Dice "comprobante de pago" y nada más. No es un recibo de sueldo ni dice que
 * haya trabajo registrado: el vínculo laboral todavía no está formalizado
 * (CLAUDE.md) y un papel que lo sugiera sería mentir.
 */
export function textoComprobante(liq) {
  const porDia = liq.jornales.reduce((a, j) => a + j.tarifa_aplicada, 0);
  return [
    `Manos Libres · ${tituloComprobante(liq)}`,
    '',
    liq.nombre,
    `Pagado el ${fechaCompleta(liq.fecha_pago)}`,
    `Del ${fechaCompleta(liq.desde)} al ${fechaCompleta(liq.hasta)}`,
    '',
    ...liq.lineas.map((l) => `${ui.cantidad(l.unidades)} ${l.producto} × ${ui.money(l.pago_unitario)} = ${ui.money(l.total)}`),
    ...(liq.jornales.length
      ? [`${plural(liq.jornales.length, 'jornada', 'jornadas')} de antes del cambio a pago por producción = ${ui.money(porDia)}`]
      : []),
    '',
    `Total cobrado: ${ui.money(liq.total)}`,
    '',
    'Federación de Organizaciones Sociales «Mesa Solidaria Tandil»',
  ].join('\n');
}

/**
 * Link de wa.me con el texto ya cargado.
 *
 * Con un celular argentino de 10 dígitos (área + número, sin 0 ni 15) se arma
 * el 549 adelante. Si el teléfono viene de otra forma no se adivina: sin
 * número, WhatsApp abre para elegir el contacto, que es mejor que mandarle el
 * comprobante a un desconocido por un dígito mal interpretado.
 */
export function linkWhatsApp(texto, telefono = '') {
  let num = String(telefono || '').replace(/\D/g, '');
  if (num.startsWith('0')) num = num.slice(1);
  if (num.length === 10) num = `549${num}`;
  else if (!(num.startsWith('549') && num.length === 13)) num = '';
  return `https://wa.me/${num}?text=${encodeURIComponent(texto)}`;
}

/** El cuerpo HTML del comprobante para imprimir. */
export function htmlComprobante(liq) {
  return `
    <h1>${tituloComprobante(liq)}</h1>
    <p class="sub">Pagado el ${fechaCompleta(liq.fecha_pago)}</p>

    <table>
      <tr><td>Nombre</td><td class="n">${ui.esc(liq.nombre)}</td></tr>
      <tr><td>Período</td><td class="n">${fechaCompleta(liq.desde)} al ${fechaCompleta(liq.hasta)}</td></tr>
      ${liq.unidades ? `<tr><td>Unidades producidas</td><td class="n">${ui.cantidad(liq.unidades)}</td></tr>` : ''}
    </table>

    <h2>Detalle</h2>
    <table>
      ${liq.lineas.map((l) => `
        <tr><td>${ui.cantidad(l.unidades)} ${ui.esc(l.producto)} × ${ui.money(l.pago_unitario)}</td><td class="n">${ui.money(l.total)}</td></tr>
      `).join('')}
      ${liq.jornales.map((j) => `
        <tr><td>${nombreDia(j.fecha)} ${fechaCompleta(j.fecha)} · jornada (antes del cambio)</td><td class="n">${ui.money(j.tarifa_aplicada)}</td></tr>
      `).join('')}
      <tr class="total"><td>Total cobrado</td><td class="n">${ui.money(liq.total)}</td></tr>
    </table>

    <div class="firma">
      <div><span></span>Recibí conforme</div>
      <div><span></span>Aclaración</div>
    </div>`;
}

/**
 * Ventana de impresión del navegador: de ahí sale "Guardar como PDF".
 *
 * Es la misma idea que ventanaImpresion() de caja.js, copiada y no importada:
 * aquella no se exporta y es de otro módulo. Si aparece un tercer papel para
 * imprimir, conviene mudar las dos a ui.js.
 *
 * Recibe la ventana ya abierta: ver clickComprobante().
 */
function imprimirComprobante(liq, w) {
  w.document.write(`
    <!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Comprobante · ${ui.esc(liq.nombre)} · ${fechaCompleta(liq.fecha_pago)}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #111; }
      h1 { font-size: 20px; margin: 0 0 2px; }
      .sub { color: #666; margin: 0 0 24px; font-size: 14px; }
      h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      td { padding: 5px 0; }
      td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; padding-left: 12px; }
      tr.total td { border-top: 1px solid #333; font-weight: 700; padding-top: 8px; }
      .firma { display: flex; gap: 32px; margin-top: 64px; font-size: 13px; color: #444; }
      .firma div { flex: 1; text-align: center; }
      .firma span { display: block; border-top: 1px solid #333; margin-bottom: 4px; }
      .pie { margin-top: 32px; color: #888; font-size: 12px; }
    </style></head><body>${htmlComprobante(liq)}
    <p class="pie">${PIE_COMPROBANTE} · emitido el ${fechaCompleta(ui.hoyISO())}</p>
    </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

/* ================================================================== */
/*  Vista                                                              */
/* ================================================================== */

export async function render(vista) {
  semana ||= ui.inicioSemana();
  const fechas = fechasDeSemana(semana);

  if (!state.trabajadoras.length) {
    vista.innerHTML = ui.vacio({
      modulo: 'trabajadoras', icono: '\u{1F465}', titulo: 'Sin equipo',
      texto: esAdmin()
        ? 'Cargá a las trabajadoras para empezar a registrar lo que producen.'
        : 'Todavía no estás cargada en el equipo.',
    });
    if (esAdmin()) fab(vista, () => modalTrabajadora(null, vista));
    return;
  }

  const [resumen, liquidaciones] = await Promise.all([
    resumenSemana(fechas[0], fechas[6]),
    liquidacionesPagadas(),
  ]);

  // Todo cuelga de un nodo propio, no de `vista`.
  // `vista` es el <section> permanente del shell: los listeners colgados ahí
  // sobreviven al innerHTML y se acumulan en cada render. Con un tap por día,
  // eso llegaba a crear 26 jornadas donde iban 4 — y a liquidar 6 veces de más.
  vista.innerHTML = `
    <div id="equipo-root">
      <div class="between" style="margin-bottom:var(--sp-3)">
        <h1 style="margin:0">${esAdmin() ? 'Equipo' : 'Lo mío'}</h1>
      </div>

      <div class="semana-nav">
        <button data-semana="-1" aria-label="Semana anterior">‹</button>
        <span>${ui.fecha(fechas[0])} – ${ui.fecha(fechas[6])}</span>
        <button data-semana="1" aria-label="Semana siguiente">›</button>
      </div>

      ${resumen.filas.map((f) => tarjeta(f, fechas)).join('')}
      ${esAdmin() ? bloqueLiquidacion(resumen, liquidaciones) : bloquePropio(resumen)}
      ${esAdmin() ? '' : bloqueCobrado(liquidaciones)}
      ${esAdmin() ? '' : tablaPagos()}
    </div>
  `;

  const root = vista.querySelector('#equipo-root');

  root.querySelector('.semana-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-semana]');
    if (!b) return;
    const d = new Date(semana);
    d.setDate(d.getDate() + 7 * Number(b.dataset.semana));
    semana = d;
    render(vista);
  });

  root.addEventListener('click', async (e) => {
    const dia = e.target.closest('[data-dia]');
    if (dia) return toggleDia(dia, vista);

    const confPago = e.target.closest('[data-confirmar-pago]');
    if (confPago) {
      try {
        await confirmarPago(confPago.dataset.confirmarPago);
        ui.toast('Producción confirmada');
        return render(vista);
      } catch (err) { return ui.toast(err.message, true); }
    }

    const conf = e.target.closest('[data-confirmar]');
    if (conf) {
      try {
        await confirmarJornada(conf.dataset.confirmar);
        ui.toast('Jornada confirmada');
        return render(vista);
      } catch (err) { return ui.toast(err.message, true); }
    }

    const edit = e.target.closest('[data-editar]');
    if (edit) return modalTrabajadora(state.trabajadoraPorId(edit.dataset.editar), vista);

    if (e.target.closest('#liquidar')) return abrirLiquidacion(fechas, resumen, vista);

    if (e.target.closest('[data-historial]')) return abrirHistorial(liquidaciones);
    await clickComprobante(e);
  });

  if (esAdmin()) fab(vista, () => modalTrabajadora(null, vista));
}

const nombreProducto = (id) => state.productoPorId(id)?.nombre || 'Producto';

/** "48 Empanada de carne · 3 Tarta de verdura" — lo producido y confirmado. */
function detalleProducido(f) {
  return f.porProducto
    .map((x) => `<span class="num">${ui.cantidad(x.unidades)}</span> ${ui.esc(nombreProducto(x.producto_id))}`)
    .join(' · ');
}

function tarjeta(f, fechas) {
  const porFecha = new Map(f.jornadas.map((j) => [j.fecha, j]));
  const propia = f.trabajadora.id === auth.trabajadoraId;
  const verPlata = esAdmin() || propia;
  const aConfirmar = f.pagos.filter((p) => !p.confirmada);

  return `
    <div class="card" data-accent="trabajadoras" style="margin-bottom:var(--sp-3)">
      <div class="between">
        <div style="min-width:0">
          <b>${ui.esc(f.trabajadora.nombre)}</b>
          ${f.trabajadora.activa === false ? '<span class="badge">Ya no trabaja</span>' : ''}
          ${esAdmin() ? `<div class="faint">
            ${auth.etiquetaRol(rolDe(f.trabajadora))}${f.trabajadora.email ? '' : ' · sin mail'}
          </div>` : ''}
        </div>
        <div class="right">
          <div class="num" style="font-size:1.1rem">${ui.cantidad(f.unidades)} ${f.unidades === 1 ? 'unidad' : 'unidades'}</div>
          ${verPlata ? `<div class="num dim">${ui.money(f.total)}</div>` : ''}
        </div>
      </div>

      ${f.porProducto.length ? `<div class="faint" style="margin-top:var(--sp-2)">${detalleProducido(f)}</div>` : ''}

      <div class="dim" style="font-size:.78rem;margin-top:var(--sp-3)">Días que vino</div>
      <div class="days" style="margin-top:var(--sp-1)">
        ${fechas.map((fecha, i) => {
          const j = porFecha.get(fecha);
          // Una jornada es un hecho: nadie vino todavía un día que no pasó.
          // Se deshabilita en vez de dejar tocar y fallar con un toast.
          const futuro = fecha > ui.hoyISO();
          const clases = ['', j ? 'on' : '',
                          j && !j.confirmada ? 'pendiente' : '',
                          j?.estado_pago === 'pagada' ? 'pagada' : ''].join(' ').trim();
          return `<button class="${clases}" data-dia="${fecha}" data-trab="${f.trabajadora.id}"
                    ${futuro ? 'disabled' : ''}
                    title="${NOMBRE_DIA[i]} ${ui.fecha(fecha)}${futuro ? ' · todavía no pasó' : ''}">${DIAS[i]}</button>`;
        }).join('')}
      </div>

      ${aConfirmar.length && esAdmin() ? `
        <div class="alerta alerta--warn" style="margin-top:var(--sp-3)">
          Cargó producción que todavía no está confirmada. No cuenta para la liquidación.
          <div class="stack" style="margin-top:var(--sp-2)">
            ${aConfirmar.map((p) => `
              <button class="btn btn--ghost" data-confirmar-pago="${p.id}">
                Confirmar ${ui.cantidad(p.cantidad)} ${ui.esc(nombreProducto(p.producto_id))} · ${ui.fecha(p.fecha)}
              </button>`).join('')}
          </div>
        </div>` : ''}

      ${f.diasSinConfirmar && esAdmin() ? `
        <div class="alerta alerta--warn" style="margin-top:var(--sp-3)">
          ${f.diasSinConfirmar === 1 ? 'Marcó un día' : `Marcó ${f.diasSinConfirmar} días`} que
          todavía no ${f.diasSinConfirmar === 1 ? 'está confirmado' : 'están confirmados'}.
          <div class="stack" style="margin-top:var(--sp-2)">
            ${f.jornadas.filter((j) => !j.confirmada).map((j) => `
              <button class="btn btn--ghost" data-confirmar="${j.id}">Confirmar ${ui.fecha(j.fecha)}</button>
            `).join('')}
          </div>
        </div>` : ''}

      ${esAdmin() ? `
        <button class="btn btn--ghost btn--block" data-editar="${f.trabajadora.id}"
          style="margin-top:var(--sp-3)">Editar</button>` : ''}
    </div>`;
}

function bloqueLiquidacion(resumen, liquidaciones = []) {
  return `
    <div class="card" data-accent="trabajadoras" style="margin-top:var(--sp-4)">
      <div class="between">
        <span class="dim">Total de la semana</span>
        <b class="num" style="font-size:1.3rem">${ui.money(resumen.total)}</b>
      </div>
      <div class="faint">${ui.cantidad(resumen.unidades)} unidades producidas</div>
      ${resumen.pendiente !== resumen.total ? `
        <div class="between" style="margin-top:var(--sp-2)">
          <span class="dim">Pendiente de pago</span>
          <b class="num">${ui.money(resumen.pendiente)}</b>
        </div>` : ''}
      ${resumen.sinConfirmar ? `
        <p class="faint" style="margin:var(--sp-2) 0 0">
          Hay ${resumen.sinConfirmar} ${resumen.sinConfirmar === 1 ? 'carga' : 'cargas'} de producción
          sin confirmar que no están incluidas.
        </p>` : ''}
      <button class="btn btn--primary btn--block" data-accent="trabajadoras" id="liquidar"
        style="margin-top:var(--sp-3)" ${resumen.pendiente <= 0 ? 'disabled' : ''}>
        ${resumen.pendiente > 0 ? 'Liquidar semana' : 'Nada pendiente de pago'}
      </button>
      ${liquidaciones.length ? `
        <button class="btn btn--ghost btn--block" data-historial style="margin-top:var(--sp-2)">
          Liquidaciones pagadas · comprobantes
        </button>` : ''}
    </div>`;
}

/** Lo que ve una trabajadora: lo suyo y nada más. */
function bloquePropio(resumen) {
  const f = resumen.filas[0];
  if (!f) return '';
  const aConfirmar = f.pagos.filter((p) => !p.confirmada);
  const porConfirmar = aConfirmar.reduce((a, p) => a + (p.total || 0), 0);
  return `
    <div class="card" data-accent="trabajadoras" style="margin-top:var(--sp-4)">
      <div class="between">
        <span class="dim">Tu total de la semana</span>
        <b class="num" style="font-size:1.3rem">${ui.money(f.total)}</b>
      </div>
      ${f.pendiente !== f.total ? `
        <div class="between" style="margin-top:var(--sp-2)">
          <span class="dim">Te falta cobrar</span>
          <b class="num">${ui.money(f.pendiente)}</b>
        </div>` : ''}
      <p class="faint" style="margin:var(--sp-3) 0 0">
        ${aConfirmar.length
          ? `Cargaste producción por <span class="num">${ui.money(porConfirmar)}</span> que todavía
             no confirmó la administración. Se suma a tu total cuando la confirme.`
          : 'Cobrás por lo que producís: se carga al cerrar la orden de producción.'}
      </p>
    </div>`;
}

/** Cuánto se paga cada producto. Es lo que cobran y es igual para todas. */
function tablaPagos() {
  const conPaga = state.productos.filter((p) => p.activo && p.pago_produccion != null);
  if (!conPaga.length) return '';
  return `
    <div class="card" data-accent="trabajadoras" style="margin-top:var(--sp-3)">
      <div class="dim" style="margin-bottom:var(--sp-2)">Cuánto se paga por unidad</div>
      ${conPaga.map((p) => `
        <div class="between" style="padding:var(--sp-1) 0">
          <span>${ui.esc(p.nombre)}</span><b class="num">${ui.money(p.pago_produccion)}</b>
        </div>`).join('')}
    </div>`;
}

/**
 * Lo que cobró en semanas anteriores, dentro de "Lo mío". Solo lo suyo:
 * `liquidaciones` ya viene pasada por filtrarPropio() desde
 * liquidacionesPagadas().
 *
 * Se muestran las últimas cuatro; el resto, en el modal. Es la pregunta que
 * se hace con el celular en la mano ("¿me pagaron las empanadas del martes?")
 * y no hace falta bajar por todo el año para contestarla.
 */
const COBRADO_A_LA_VISTA = 4;

function bloqueCobrado(liquidaciones) {
  if (!liquidaciones.length) return '';
  const recientes = liquidaciones.slice(0, COBRADO_A_LA_VISTA);
  return `
    <div class="bloque">
      <div class="bloque__titulo">Lo que cobraste</div>
      ${listaLiquidaciones(recientes)}
      ${liquidaciones.length > recientes.length ? `
        <button class="btn btn--ghost btn--block" data-historial style="margin-top:var(--sp-2)">
          Ver todo (${liquidaciones.length})
        </button>` : ''}
    </div>`;
}

/**
 * Las filas del histórico. El admin las ve agrupadas por día de pago y con el
 * nombre de cada una; una trabajadora, en lista simple, que de todas formas
 * son solo las suyas.
 */
function listaLiquidaciones(liqs) {
  if (!esAdmin()) return `<div class="lista">${liqs.map((l) => filaLiquidacion(l)).join('')}</div>`;

  const porFecha = new Map();
  for (const l of liqs) {
    if (!porFecha.has(l.fecha_pago)) porFecha.set(l.fecha_pago, []);
    porFecha.get(l.fecha_pago).push(l);
  }
  return [...porFecha.entries()].map(([fecha, delDia]) => `
    <div class="grupo">
      <div class="grupo__titulo">
        Pagado el ${fechaCompleta(fecha)}
        <span class="grupo__cuenta num">${ui.money(delDia.reduce((a, l) => a + l.total, 0))}</span>
      </div>
      <div class="lista">${delDia.map((l) => filaLiquidacion(l, { conNombre: true })).join('')}</div>
    </div>`).join('');
}

/** "48 unidades · 05/10 – 09/10", o "3 jornadas (antes del cambio)" si es de antes. */
function resumenLiquidacion(l) {
  const partes = [];
  if (l.unidades) partes.push(plural(l.unidades, 'unidad', 'unidades'));
  if (l.jornales.length) partes.push(`${plural(l.jornales.length, 'jornada', 'jornadas')} (antes del cambio)`);
  partes.push(`${ui.fecha(l.desde)}${l.desde !== l.hasta ? ` – ${ui.fecha(l.hasta)}` : ''}`);
  return partes.map((p) => `<span>${p}</span>`).join('<span class="dim">·</span>');
}

function filaLiquidacion(l, { conNombre = false } = {}) {
  // El teléfono solo lo usa el admin para mandárselo a ella. A una trabajadora
  // el link le abre WhatsApp para elegir a quién reenviarlo.
  const wa = linkWhatsApp(textoComprobante(l), conNombre ? l.telefono : '');
  return `
    <div class="liquidacion">
      <div class="fila">
        <div class="fila__main">
          <div class="fila__titulo">${conNombre ? ui.esc(l.nombre) : `Pagado el ${fechaCompleta(l.fecha_pago)}`}</div>
          <div class="fila__meta">${resumenLiquidacion(l)}</div>
        </div>
        <div class="fila__lado"><b class="num">${ui.money(l.total)}</b></div>
      </div>
      <div class="acciones">
        <button class="btn" data-comprobante="${ui.esc(l.trabajadora_id)}"
          data-fecha-pago="${ui.esc(l.fecha_pago)}">Comprobante</button>
        <a class="btn" href="${ui.esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>
      </div>
    </div>`;
}

function abrirHistorial(liqs, titulo = 'Liquidaciones pagadas') {
  ui.abrirModal(`
    <h3>${ui.esc(titulo)}</h3>
    <p class="faint" style="margin-top:calc(var(--sp-2) * -1)">
      Comprobante abre la impresión: desde ahí se guarda como PDF.
    </p>
    <div style="margin-top:var(--sp-3)">${listaLiquidaciones(liqs)}</div>
    <button class="btn btn--ghost btn--block" data-close style="margin-top:var(--sp-2);border:none">Cerrar</button>
  `, (root) => root.addEventListener('click', clickComprobante));
}

/**
 * La ventana se abre ANTES de ir a buscar el dato, sincrónica con el toque.
 * Safari en el celular bloquea un window.open que llega después de un await:
 * para él ya no es una acción de la persona sino un popup.
 */
async function clickComprobante(e) {
  const b = e.target.closest('[data-comprobante]');
  if (!b) return false;
  const w = window.open('', '_blank');
  if (!w) {
    ui.toast('El navegador bloqueó la ventana de impresión', true);
    return true;
  }
  try {
    imprimirComprobante(await comprobanteLiquidacion(b.dataset.comprobante, b.dataset.fechaPago), w);
  } catch (err) {
    w.close();
    ui.toast(err.message, true);
  }
  return true;
}

async function toggleDia(btn, vista) {
  const fecha = btn.dataset.dia;
  const trabajadoraId = btn.dataset.trab;

  if (!esAdmin() && trabajadoraId !== auth.trabajadoraId) {
    return ui.toast('Solo podés marcar tus propias jornadas', true);
  }

  try {
    const { accion } = await marcarJornada(trabajadoraId, fecha);
    navigator.vibrate?.(12);
    if (accion === 'creada' && !esAdmin()) ui.toast('Queda pendiente de confirmar');
    await render(vista);
  } catch (err) {
    ui.toast(err.message, true);
  }
}

/* ------------------------------------------------------------------ */

/**
 * "48 × $40 + 3 × $300" desde los montos CONGELADOS de cada carga, no desde el
 * pago de hoy. Con el de hoy, subir el pago de un producto el miércoles hacía
 * que la última pantalla antes de pagar mostrara una cuenta que no daba.
 */
function desglosePendiente(f) {
  const porMonto = new Map();
  for (const p of f.pagos) {
    if (!p.confirmada || p.estado_pago === 'pagada') continue;
    const k = `${p.producto_id}|${p.pago_unitario}`;
    const e = porMonto.get(k) || { producto_id: p.producto_id, unitario: p.pago_unitario, unidades: 0 };
    e.unidades += p.cantidad || 0;
    porMonto.set(k, e);
  }
  const lineas = [...porMonto.values()]
    .map((e) => `${ui.cantidad(e.unidades)} ${ui.esc(nombreProducto(e.producto_id))} × ${ui.money(e.unitario)}`);
  const jornales = f.jornadas.filter((j) => j.confirmada && j.estado_pago !== 'pagada' && j.tarifa_aplicada > 0);
  if (jornales.length) lineas.push(`${jornales.length} ${jornales.length === 1 ? 'día' : 'días'} de antes del cambio`);
  return lineas.join('<br>');
}

function abrirLiquidacion(fechas, resumen, vista) {
  const conPendiente = resumen.filas.filter((f) => f.pendiente > 0);

  ui.abrirModal(`
    <h3>Liquidar la semana</h3>
    <p class="faint" style="margin-top:calc(var(--sp-2) * -1)">
      ${ui.fecha(fechas[0])} – ${ui.fecha(fechas[6])}
    </p>

    <table class="table" style="margin-top:var(--sp-3)">
      <tbody>
        ${conPendiente.map((f) => `
          <tr>
            <td>${ui.esc(f.trabajadora.nombre)}</td>
            <td class="num right dim">${desglosePendiente(f)}</td>
            <td class="num right"><b>${ui.money(f.pendiente)}</b></td>
          </tr>`).join('')}
      </tbody>
    </table>

    <div class="between" style="margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--border)">
      <span>Total a pagar</span>
      <b class="num" style="font-size:1.4rem">${ui.money(resumen.pendiente)}</b>
    </div>

    ${resumen.sinConfirmar ? `
      <div class="alerta alerta--warn" style="margin-top:var(--sp-3)">
        Quedan ${resumen.sinConfirmar} ${resumen.sinConfirmar === 1 ? 'carga' : 'cargas'} de producción
        sin confirmar afuera de esta liquidación.
      </div>` : ''}

    <p class="faint">El egreso en caja se registra automáticamente.</p>

    <button class="btn--confirmar" id="ok" style="margin-top:var(--sp-3)">Confirmar pago</button>
    <button class="btn btn--ghost btn--block" data-close style="margin-top:var(--sp-2);border:none">Cancelar</button>
  `, (root) => {
    root.querySelector('#ok').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Guardando…';
      try {
        const r = await liquidarSemana(fechas[0], fechas[6]);
        ui.cerrarModal();
        ui.toast(`Liquidado ${ui.money(r.total)} · ${ui.cantidad(r.unidades)} unidades`);
        await render(vista);
        // Recién pagado es cuando se entrega el comprobante: se ofrecen ahí
        // mismo, sin tener que ir a buscarlos al histórico
        const hoy = ui.hoyISO();
        const deHoy = (await liquidacionesPagadas()).filter((l) => l.fecha_pago === hoy);
        if (deHoy.length) abrirHistorial(deHoy, 'Comprobantes de hoy');
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = 'Confirmar pago';
        ui.toast(err.message, true);
      }
    });
  });
}

function modalTrabajadora(t = null, vista = null) {
  const nueva = !t;
  const rolActual = nueva ? ROL_POR_DEFECTO : rolDe(t);
  ui.abrirModal(`
    <h3>${nueva ? 'Nueva trabajadora' : ui.esc(t.nombre)}</h3>
    <div class="stack" style="margin-top:var(--sp-3)">
      <div class="field">
        <label for="t-nombre">Nombre</label>
        <input class="input" id="t-nombre" value="${nueva ? '' : ui.esc(t.nombre)}" autocomplete="off">
      </div>
      <div class="field">
        <label for="t-tel">Teléfono</label>
        <input class="input" id="t-tel" type="tel" value="${nueva ? '' : ui.esc(t.telefono || '')}">
      </div>
      <p class="faint" style="margin:0">Cobra por lo que produce: el pago por unidad
        se define en la receta de cada producto.</p>
      <div class="field">
        <label for="t-pin">PIN de acceso</label>
        <input class="input" id="t-pin" type="number" inputmode="numeric"
               placeholder="${nueva ? '4 dígitos, opcional' : 'Vacío = no cambiarlo'}">
        <span class="faint">Con esto desbloquea la app en su propio celular.</span>
      </div>

      ${!esAdmin() ? '' : `
        <div class="field">
          <label for="t-email">Mail de la cuenta</label>
          <input class="input" id="t-email" type="email" inputmode="email"
                 autocomplete="off" autocapitalize="none" spellcheck="false"
                 placeholder="Opcional"
                 value="${nueva ? '' : ui.esc(t.email || '')}">
          <span class="faint">No es para mandarle mails: es la llave con la que su
            usuario del servidor se engancha con esta ficha. Si no tiene mail propio,
            poné uno que controles vos.</span>
        </div>

        <div class="field">
          <label for="t-rol">Rol</label>
          <select class="input" id="t-rol">
            ${ROLES.map((r) => `
              <option value="${r}" ${r === rolActual ? 'selected' : ''}>${ui.esc(auth.etiquetaRol(r))}</option>
            `).join('')}
          </select>
          <span class="faint" id="t-rol-ayuda">${ui.esc(AYUDA_ROL[rolActual] || '')}</span>
        </div>`}

      ${nueva ? '' : `
        <label class="row" style="gap:var(--sp-2)">
          <input type="checkbox" id="t-activa" ${t.activa ? 'checked' : ''}>
          <span>Activa</span>
        </label>`}
    </div>

    <button class="btn btn--primary btn--block" data-accent="trabajadoras" id="ok"
      style="margin-top:var(--sp-4)">Guardar</button>
    <button class="btn btn--ghost btn--block" data-close style="margin-top:var(--sp-2);border:none">Cancelar</button>
  `, (root) => {
    // Qué implica cada rol no se adivina desde el nombre: "Comisión" no dice
    // que sea solo lectura ni "Administración" que vea la caja entera.
    const selRol = root.querySelector('#t-rol');
    selRol?.addEventListener('change', () => {
      root.querySelector('#t-rol-ayuda').textContent = AYUDA_ROL[selRol.value] || '';
    });

    root.querySelector('#ok').addEventListener('click', async () => {
      try {
        const pin = root.querySelector('#t-pin').value.trim();
        if (pin && !/^\d{4}$/.test(pin)) throw new Error('El PIN tiene que ser de 4 dígitos');

        // Los campos de identidad solo existen para administración. Si no están
        // en el DOM van `undefined`, que es "no los toques": mandar '' le
        // borraría el mail a la persona al guardar cualquier otro cambio.
        const campoMail = root.querySelector('#t-email');

        const guardada = await guardarTrabajadora({
          id: t?.id || null,
          nombre: root.querySelector('#t-nombre').value,
          telefono: root.querySelector('#t-tel').value,
          activa: nueva ? true : root.querySelector('#t-activa').checked,
          email: campoMail ? campoMail.value : undefined,
          rol: selRol ? selRol.value : undefined,
        });

        if (pin) await auth.cambiarPinTrabajadora(guardada.id, pin);

        ui.cerrarModal();
        await state.cargar();
        ui.toast(nueva ? 'Trabajadora agregada' : 'Cambios guardados');
        if (vista) await render(vista);
      } catch (err) {
        ui.toast(err.message, true);
      }
    });
  });
}

function fab(cont, onClick) {
  const b = document.createElement('button');
  b.className = 'fab';
  b.dataset.accent = 'trabajadoras';
  b.setAttribute('aria-label', 'Nueva trabajadora');
  b.textContent = '+';
  b.addEventListener('click', onClick);
  cont.appendChild(b);
}
