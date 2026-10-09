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
// El rol va primero: state.cargar() recorta lo que ese rol puede tener en
// memoria (tarifas ajenas, hash del PIN). La app hace lo mismo al loguear.
auth.rol = 'admin';
await state.cargar();

const ana   = state.trabajadoras.find((x) => x.nombre === 'Ana');
const maria = state.trabajadoras.find((x) => x.nombre === 'María');

// Semana relativa a "hoy", no fecha fija de calendario: el autoreporte de
// más abajo exige que X caiga dentro de los últimos 14 días reales, y una
// fecha fija terminaba saliéndose de esa ventana con el solo paso del tiempo.
const diasAtras = (n) => ui.hoyISO(new Date(Date.now() - n * 864e5));
const L = diasAtras(10), M = diasAtras(9), X = diasAtras(8), J = diasAtras(7), V = diasAtras(6);
const DOM = diasAtras(4);

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

/* El origen ya no es un parámetro: se deriva del rol. Antes, pasarle un valor
   cualquiera salteaba las dos validaciones y dejaba tocar jornadas ajenas. */
const colado = await eq.marcarJornada(maria.id, DOM, { origen: 'admin' });
t('el origen que le pasen no cambia nada: sigue siendo autoreporte',
  colado.jornada.origen_carga === 'autoreporte' && colado.jornada.confirmada === false);
await eq.marcarJornada(maria.id, DOM);   // toggle: la borra y no ensucia los conteos

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

/* ================================================================== */
console.log('\n── identidad: mail y rol (fase 5 §4.1)');

t('nace con el rol por defecto', rocio.rol === 'trabajadora');
t('y sin mail', rocio.email === null);

const sofia = await eq.guardarTrabajadora({
  nombre: 'Sofía', tarifaDia: 6000, email: '  Sofia@Cocina.AR  ', rol: 'admin',
});
t('guarda el rol que le pasan', sofia.rol === 'admin');
t('normaliza el mail: minúscula y sin espacios', sofia.email === 'sofia@cocina.ar');

t('rechaza algo que no tiene forma de mail',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Z', tarifaDia: 100, email: 'sofia arroba cocina' }))) !== null);
t('rechaza un mail sin punto en el dominio',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Z', tarifaDia: 100, email: 'sofia@cocina' }))) !== null);

/* El índice único de Postgres es sobre lower(email): acá tiene que doler igual */
t('rechaza el mail repetido aunque cambien las mayúsculas',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Z', tarifaDia: 100, email: 'SOFIA@Cocina.ar' }))) !== null);
t('y no la dejó creada a medias',
  !(await db.from('trabajadora').select()).some((x) => x.nombre === 'Z'));
t('pero la misma persona sí puede reguardar su propio mail',
  (await tira(() => eq.guardarTrabajadora({
    id: sofia.id, nombre: 'Sofía', tarifaDia: 6000, email: 'sofia@cocina.ar', rol: 'admin',
  }))) === null);

t('rechaza un rol que no existe en auth.js',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Z', tarifaDia: 100, rol: 'jefa' }))) !== null);
t('acepta dirigente',
  (await tira(() => eq.guardarTrabajadora({ id: sofia.id, nombre: 'Sofía', tarifaDia: 6000, rol: 'dirigente' }))) === null);

/* Una llamada que no conoce estos campos no puede borrarlos de refilón */
await eq.guardarTrabajadora({ id: sofia.id, nombre: 'Sofía', tarifaDia: 6500 });
const intacta = await db.from('trabajadora').select().eq('id', sofia.id).single();
t('no mandar mail ni rol los deja como estaban',
  intacta.email === 'sofia@cocina.ar' && intacta.rol === 'dirigente');

/* Mandarlo vacío sí es borrarlo, y el mail queda libre */
await eq.guardarTrabajadora({ id: sofia.id, nombre: 'Sofía', tarifaDia: 6500, email: '' });
t('mandar el mail vacío lo borra',
  (await db.from('trabajadora').select().eq('id', sofia.id).single()).email === null);
t('y ese mail queda libre para otra persona',
  (await tira(() => eq.guardarTrabajadora({
    nombre: 'Lucía', tarifaDia: 6000, email: 'sofia@cocina.ar',
  }))) === null);

/* ================================================================== */
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

/* ================================================================== */
console.log('\n── histórico de liquidaciones pagadas');

auth.rol = 'admin';
auth.trabajadoraId = null;
const HOY = ui.hoyISO();
const suma = (js) => js.reduce((a, j) => a + (j.tarifa_aplicada || 0), 0);

const histLiq = await eq.liquidacionesPagadas();
const pagadasAhora = (await db.from('jornada').select()).filter((j) => j.estado_pago === 'pagada');
t('una liquidación por trabajadora pagada', histLiq.length === 2);
t('todas con la fecha en que se pagaron', histLiq.every((l) => l.fecha_pago === HOY));

const liqAna = histLiq.find((l) => l.trabajadora_id === ana.id);
t('el total de Ana es la suma de sus jornadas pagadas',
  liqAna.total === suma(pagadasAhora.filter((j) => j.trabajadora_id === ana.id)));
t('trae el período trabajado', liqAna.desde === L && liqAna.hasta === V);
t('el histórico cuadra con el egreso de caja',
  histLiq.reduce((a, l) => a + l.total, 0) === movs[0].monto);

/* Regla 4: a Ana le suben la tarifa después de cobrar. Lo que cobró no se mueve */
const totalAntes = liqAna.total;
await eq.guardarTrabajadora({ id: ana.id, nombre: 'Ana', tarifaDia: 20000 });
const liqAnaDespues = (await eq.liquidacionesPagadas({ trabajadoraId: ana.id }))[0];
t('subir la tarifa NO recalcula lo ya cobrado', liqAnaDespues.total === totalAntes);
t('el detalle conserva las dos tarifas congeladas',
  liqAnaDespues.jornadas.some((j) => j.tarifa_aplicada === 5000)
  && liqAnaDespues.jornadas.some((j) => j.tarifa_aplicada === 8000)
  && !liqAnaDespues.jornadas.some((j) => j.tarifa_aplicada === 20000));

/* ================================================================== */
console.log('\n── comprobante');

const comp = await eq.comprobanteLiquidacion(ana.id, HOY);
const txt = eq.textoComprobante(comp);
t('el texto lleva el nombre y el total', txt.includes('Ana') && txt.includes(ui.money(comp.total)));
t('desglosa por tarifa congelada', txt.includes(`3 × ${ui.money(5000)}`) && txt.includes(`1 × ${ui.money(8000)}`));
t('firma la Federación «Mesa Solidaria Tandil»', txt.includes('Federación de Organizaciones Sociales «Mesa Solidaria Tandil»'));

const html = eq.htmlComprobante(comp);
t('el HTML tiene una línea por jornada', (html.match(/<tr><td>/g) || []).length === 2 + comp.dias);
const papel = (txt + html).toLowerCase();
t('no dice recibo de sueldo, trabajo registrado ni dependencia',
  !/sueldo|registrad|dependencia|mirmidones/.test(papel));
t('un día sin liquidación pagada tira',
  (await tira(() => eq.comprobanteLiquidacion(ana.id, '2000-01-01'))) !== null);

t('wa.me arma el 549 con un celular de 10 dígitos',
  eq.linkWhatsApp('hola', '0249 412-3456').startsWith('https://wa.me/5492494123456?text='));
t('con un teléfono raro no adivina: abre para elegir contacto',
  eq.linkWhatsApp('hola', '15 412').startsWith('https://wa.me/?text='));
t('el texto va codificado', !/\s/.test(eq.linkWhatsApp(txt, '')));

/* ================================================================== */
console.log('\n── histórico desde la trabajadora: solo lo suyo');

auth.rol = 'trabajadora';
auth.trabajadoraId = maria.id;

const suyas = await eq.liquidacionesPagadas();
t('ve solo sus liquidaciones', suyas.length === 1 && suyas[0].trabajadora_id === maria.id);
t('ni el nombre ni el id de Ana', !JSON.stringify(suyas).includes(ana.id) && !JSON.stringify(suyas).includes('Ana'));
t('pedir las de Ana por parámetro devuelve vacío',
  (await eq.liquidacionesPagadas({ trabajadoraId: ana.id })).length === 0);
t('NO puede sacar el comprobante de Ana',
  (await tira(() => eq.comprobanteLiquidacion(ana.id, HOY))) !== null);
const compMaria = await eq.comprobanteLiquidacion(maria.id, HOY);
t('sí el suyo', compMaria.nombre === 'María');
t('y en el suyo no aparece nadie más',
  !eq.htmlComprobante(compMaria).includes('Ana') && !eq.textoComprobante(compMaria).includes('Ana'));

/* ================================================================== */
console.log('\n── dos pagos el mismo día salen en un comprobante');

auth.rol = 'admin';
auth.trabajadoraId = null;
await eq.liquidarSemana(L, DOM);   // la jornada de María que se confirmó después
const histFinal = await eq.liquidacionesPagadas();
const liqMaria = histFinal.find((l) => l.trabajadora_id === maria.id);
const egresos = await db.from('movimiento_caja').select().eq('origen', 'jornal');
t('María sigue teniendo una sola liquidación ese día',
  histFinal.filter((l) => l.trabajadora_id === maria.id).length === 1);
t('que suma las jornadas de los dos lotes',
  liqMaria.dias === (await db.from('jornada').select())
    .filter((j) => j.trabajadora_id === maria.id && j.estado_pago === 'pagada').length);
t('y el histórico sigue cuadrando con la caja',
  histFinal.reduce((a, l) => a + l.total, 0) === egresos.reduce((a, m) => a + m.monto, 0));

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
