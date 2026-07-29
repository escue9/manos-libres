import "fake-indexeddb/auto";   // npm install fake-indexeddb
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const { ui }       = await import('../js/ui.js');
const calc         = await import('../js/calc.js');
const eq           = await import('../js/modules/trabajadoras.js');

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };
const tira = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

await seed();
await state.cargar();
auth.rol = 'admin';

const ana   = state.trabajadoras.find((x) => x.nombre === 'Ana');
const maria = state.trabajadoras.find((x) => x.nombre === 'María');

// Semana fija para que el test no dependa del día en que se corre
const L = '2026-07-20', M = '2026-07-21', X = '2026-07-22', J = '2026-07-23', V = '2026-07-24';
const DOM = '2026-07-26';

/* ================================================================== */
console.log('\n── marcar y desmarcar jornadas');

const c1 = await eq.marcarJornada(ana.id, L);
t('marcar crea la jornada', c1.accion === 'creada');
t('la crea confirmada si la carga el admin', c1.jornada.confirmada === true);
t('nace pendiente de pago', c1.jornada.estado_pago === 'pendiente');
t('congela la tarifa', c1.jornada.tarifa_aplicada === ana.tarifa_dia);

const c2 = await eq.marcarJornada(ana.id, L);
t('volver a marcar la borra (es toggle)', c2.accion === 'borrada');
t('quedó sin jornadas ese día',
  (await db.from('jornada').select().eq('trabajadora_id', ana.id).eq('fecha', L)).length === 0);

await eq.marcarJornada(ana.id, L);
await eq.marcarJornada(ana.id, M);
await eq.marcarJornada(ana.id, X);
await eq.marcarJornada(maria.id, L);
await eq.marcarJornada(maria.id, M);

const delDia = await db.from('jornada').select().eq('trabajadora_id', ana.id).eq('fecha', L);
t('una sola jornada por trabajadora por día', delDia.length === 1);

/* ================================================================== */
console.log('\n── tarifa histórica: el pasado no se recalcula');

/* Ana pasa de 5000 a 8000 el jueves. Las jornadas de lunes a miércoles ya
   existen con la tarifa vieja y no se tienen que mover. */
await db.from('tarifa_historica').insert({
  trabajadora_id: ana.id, tarifa_dia: 8000, vigente_desde: J,
});
await eq.guardarTrabajadora({ id: ana.id, nombre: 'Ana', tarifaDia: 8000 });
await state.cargar();

const nueva = await eq.marcarJornada(ana.id, V);
t('una jornada nueva toma la tarifa nueva', nueva.jornada.tarifa_aplicada === 8000);

const viejas = await db.from('jornada').select().eq('trabajadora_id', ana.id).eq('fecha', L);
t('la jornada vieja conserva la tarifa vieja', viejas[0].tarifa_aplicada === 5000);

t('tarifaVigente elige por fecha',
  calc.tarifaVigente([{ tarifa_dia: 5000, vigente_desde: '2026-01-01' },
                      { tarifa_dia: 8000, vigente_desde: J }], M, 0) === 5000);

/* ================================================================== */
console.log('\n── autoreporte: no cuenta hasta que lo confirmen');

auth.rol = 'trabajadora';
auth.trabajadoraId = maria.id;

const auto = await eq.marcarJornada(maria.id, X, { origen: 'autoreporte' });
t('la trabajadora puede marcar su propio día', auto.accion === 'creada');
t('entra sin confirmar', auto.jornada.confirmada === false);
t('queda marcada como autoreporte', auto.jornada.origen_carga === 'autoreporte');

const ajena = await tira(() => eq.marcarJornada(ana.id, DOM, { origen: 'autoreporte' }));
t('NO puede marcar el día de otra', ajena !== null);

const comoAdmin = await tira(() => eq.marcarJornada(maria.id, DOM, { origen: 'admin' }));
t('NO puede cargar como admin (no tiene liquidar)', comoAdmin !== null);

const sinPermiso = await tira(() => eq.confirmarJornada(auto.jornada.id));
t('NO puede confirmarse a sí misma', sinPermiso !== null);

/* ================================================================== */
console.log('\n── privacidad: solo ve lo suyo');

const suyo = await eq.resumenSemana(L, DOM);
t('el resumen trae una sola fila', suyo.filas.length === 1);
t('y es la propia', suyo.filas[0].trabajadora.id === maria.id);
t('no aparece Ana por ningún lado',
  !JSON.stringify(suyo).includes(ana.id) && !JSON.stringify(suyo).includes('Ana'));
t('sus días sin confirmar no suman al total',
  suyo.total === suyo.filas[0].jornadas.filter((j) => j.confirmada)
                    .reduce((a, j) => a + j.tarifa_aplicada, 0));
t('pero sí se le avisan aparte', suyo.sinConfirmar === 1);

const todasLasJornadas = await db.from('jornada').select();
t('filtrarPropio recorta el listado crudo',
  auth.filtrarPropio(todasLasJornadas).every((j) => j.trabajadora_id === maria.id));
t('y el crudo tenía jornadas de las dos',
  todasLasJornadas.some((j) => j.trabajadora_id === ana.id));

/* ================================================================== */
console.log('\n── liquidación');

auth.rol = 'admin';
auth.trabajadoraId = null;

const antes = await eq.resumenSemana(L, DOM);
const sinConfirmarAntes = antes.sinConfirmar;
t('el admin ve a las dos', antes.filas.length === 2);
t('ve la jornada sin confirmar de María', sinConfirmarAntes === 1);

const esperado = antes.pendiente;
const liq = await eq.liquidarSemana(L, DOM);
t('liquida el total pendiente', liq.total === esperado);
t('devuelve el detalle por trabajadora', liq.porTrabajadora.length === 2);

const movs = await db.from('movimiento_caja').select().eq('origen', 'jornal');
t('genera UN solo egreso en caja', movs.length === 1);
t('el egreso es por el total', movs[0].monto === esperado);
t('y es egreso, no ingreso', movs[0].tipo === 'egreso');

const pagadas = (await db.from('jornada').select()).filter((j) => j.estado_pago === 'pagada');
t('las confirmadas quedaron pagadas', pagadas.length === liq.jornadas);
t('todas con fecha de pago', pagadas.every((j) => !!j.fecha_pago));

const sinConfirmar = (await db.from('jornada').select()).filter((j) => !j.confirmada);
t('la sin confirmar NO se pagó', sinConfirmar.every((j) => j.estado_pago === 'pendiente'));

const otraVez = await tira(() => eq.liquidarSemana(L, DOM));
t('no se puede liquidar dos veces', otraVez !== null);
t('y no dejó un segundo egreso',
  (await db.from('movimiento_caja').select().eq('origen', 'jornal')).length === 1);

/* Al confirmar la que faltaba, aparece para liquidar */
await eq.confirmarJornada(sinConfirmar[0].id);
const despues = await eq.resumenSemana(L, DOM);
t('confirmarla la suma al pendiente', despues.pendiente > 0);
t('ya no figura como sin confirmar', despues.sinConfirmar === 0);

/* ================================================================== */
console.log('\n── una jornada pagada no se toca');

const pagada = pagadas[0];
const err = await tira(() => eq.marcarJornada(pagada.trabajadora_id, pagada.fecha));
t('no se puede desmarcar una jornada liquidada', err !== null);
t('el mensaje lo explica', /liquidada/i.test(err?.message || ''));

/* ================================================================== */
console.log('\n── alta de trabajadora');

const rocio = await eq.guardarTrabajadora({ nombre: 'Rocío', tarifaDia: 6000 });
t('crea la trabajadora', !!rocio.id);
t('nace activa', rocio.activa === true);

const hist = await db.from('tarifa_historica').select().eq('trabajadora_id', rocio.id);
t('deja su tarifa inicial en el histórico', hist.length === 1 && hist[0].tarifa_dia === 6000);

await eq.guardarTrabajadora({ id: rocio.id, nombre: 'Rocío', tarifaDia: 6000 });
t('guardar sin cambiar la tarifa no duplica el histórico',
  (await db.from('tarifa_historica').select().eq('trabajadora_id', rocio.id)).length === 1);

await eq.guardarTrabajadora({ id: rocio.id, nombre: 'Rocío', tarifaDia: 7000 });
t('cambiar la tarifa sí agrega una fila',
  (await db.from('tarifa_historica').select().eq('trabajadora_id', rocio.id)).length === 2);

t('rechaza nombre vacío',
  (await tira(() => eq.guardarTrabajadora({ nombre: '  ', tarifaDia: 5000 }))) !== null);
t('rechaza tarifa negativa',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'X', tarifaDia: -1 }))) !== null);

auth.rol = 'trabajadora';
t('una trabajadora no puede dar de alta a otra',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Y', tarifaDia: 5000 }))) !== null);
t('ni liquidar',
  (await tira(() => eq.liquidarSemana(L, DOM))) !== null);

/* ================================================================== */
console.log('\n── el cierre semanal usa estas jornadas');

auth.rol = 'admin';
const jornadasSem = await db.from('jornada').select().gte('fecha', L).lte('fecha', DOM);
const cierre = calc.cierreSemanal({ pedidos: [], items: [], jornadas: jornadasSem, gastos: [] });
const confirmadasTotal = jornadasSem.filter((j) => j.confirmada)
                                    .reduce((a, j) => a + j.tarifa_aplicada, 0);
t('el costo laboral son las confirmadas', cierre.costoLaboral === confirmadasTotal);
t('y deja afuera las que no lo están',
  cierre.costoLaboral < jornadasSem.reduce((a, j) => a + j.tarifa_aplicada, 0)
  || jornadasSem.every((j) => j.confirmada));

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
