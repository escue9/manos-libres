import "fake-indexeddb/auto";   // npm install fake-indexeddb
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const { ui }       = await import('../js/ui.js');
const calc         = await import('../js/calc.js');
const eq           = await import('../js/modules/trabajadoras.js');
const prod         = await import('../js/modules/produccion.js');

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
const tarta = state.productos.find((p) => p.nombre === 'Tarta de verdura');   // sin receta, costo manual 1200

// Semana relativa a "hoy", no fecha fija de calendario: el autoreporte de
// más abajo exige que X caiga dentro de los últimos 14 días reales, y una
// fecha fija terminaba saliéndose de esa ventana con el solo paso del tiempo.
const diasAtras = (n) => ui.hoyISO(new Date(Date.now() - n * 864e5));
const L = diasAtras(10), M = diasAtras(9), X = diasAtras(8);
const DOM = diasAtras(4);

/** Una orden de tartas cerrada con su reparto. */
async function producir(fecha, productoras) {
  const cantidad = Object.values(productoras).reduce((a, n) => a + n, 0);
  const orden = await prod.crearOrden({ fecha, items: [{ producto_id: tarta.id, cantidad }] });
  const [item] = await db.from('produccion_item').select().eq('orden_produccion_id', orden.id);
  await prod.cerrarOrden(orden.id, {}, {
    productoras: { [item.id]: Object.entries(productoras).map(([trabajadora_id, n]) => ({ trabajadora_id, cantidad: n })) },
  });
  return orden;
}

/* ================================================================== */
console.log('\n── las jornadas son asistencia');

const c1 = await eq.marcarJornada(ana.id, L);
t('marcar crea la jornada', c1.accion === 'creada');
t('la crea confirmada si la carga el admin', c1.jornada.confirmada === true);
t('no lleva plata: se cobra por producción', c1.jornada.tarifa_aplicada === 0);

const c2 = await eq.marcarJornada(ana.id, L);
t('volver a marcar la borra (es toggle)', c2.accion === 'borrada');
t('quedó sin jornadas ese día',
  (await db.from('jornada').select().eq('trabajadora_id', ana.id).eq('fecha', L)).length === 0);

await eq.marcarJornada(ana.id, L);
await eq.marcarJornada(ana.id, M);
await eq.marcarJornada(maria.id, L);

const delDia = await db.from('jornada').select().eq('trabajadora_id', ana.id).eq('fecha', L);
t('una sola jornada por trabajadora por día', delDia.length === 1);

/* ================================================================== */
console.log('\n── lo producido es lo que se cobra');

await prod.fijarPagoProduccion(tarta.id, 300);
const o1 = await producir(L, { [ana.id]: 4, [maria.id]: 2 });

const pagos1 = await db.from('pago_produccion').select().eq('orden_produccion_id', o1.id);
t('una fila por productora', pagos1.length === 2);
t('cada una con lo suyo',
  pagos1.find((p) => p.trabajadora_id === ana.id).total === 1200
  && pagos1.find((p) => p.trabajadora_id === maria.id).total === 600);
t('cargado por la administración, entra confirmado', pagos1.every((p) => p.confirmada));
t('con la fecha de la orden', pagos1.every((p) => p.fecha === L));

await prod.fijarPagoProduccion(tarta.id, 500);
t('subir el pago no cambia lo ya producido',
  (await db.from('pago_produccion').select().eq('orden_produccion_id', o1.id)).every((p) => p.pago_unitario === 300));
await prod.fijarPagoProduccion(tarta.id, 300);

let err = await tira(() => prod.fijarPagoProduccion(tarta.id, -1));
t('el pago no puede ser negativo', !!err);
err = await tira(() => prod.fijarPagoProduccion(tarta.id, ''));
t('ni vacío: cero tiene que ser a propósito', !!err);

/* El reparto tiene que dar lo que salió */
const oMal = await prod.crearOrden({ fecha: M, items: [{ producto_id: tarta.id, cantidad: 4 }] });
const [itMal] = await db.from('produccion_item').select().eq('orden_produccion_id', oMal.id);
err = await tira(() => prod.cerrarOrden(oMal.id, {}, {
  productoras: { [itMal.id]: [{ trabajadora_id: ana.id, cantidad: 1 }, { trabajadora_id: maria.id, cantidad: 1 }] },
}));
t('un reparto que no suma lo que salió no cierra', /suma 2/.test(err?.message));
err = await tira(() => prod.cerrarOrden(oMal.id, {}, {}));
t('sin decir quién produjo, la administración no cierra', /quién produjo/.test(err?.message));
t('y la orden queda como estaba',
  (await db.from('orden_produccion').select().eq('id', oMal.id).single()).estado === 'planificada');
t('sin dejar pagos colgados',
  (await db.from('pago_produccion').select().eq('orden_produccion_id', oMal.id)).length === 0);

/* ================================================================== */
console.log('\n── cuando cierra ella: queda a confirmar');

auth.rol = 'trabajadora';
auth.trabajadoraId = maria.id;

const o2 = await prod.crearOrden({ fecha: X, items: [{ producto_id: tarta.id, cantidad: 3 }] });
await prod.cerrarOrden(o2.id, {}, {});   // sin productoras: es ella
const propios = await db.from('pago_produccion').select().eq('orden_produccion_id', o2.id);
t('sin decir nada, la productora es quien cierra', propios.length === 1 && propios[0].trabajadora_id === maria.id);
t('entra sin confirmar', propios[0].confirmada === false);
t('y queda como autoreporte', propios[0].origen_carga === 'autoreporte');

const o3 = await prod.crearOrden({ fecha: X, items: [{ producto_id: tarta.id, cantidad: 2 }] });
err = await tira(() => prod.cerrarOrden(o3.id, {}, { productoras: ana.id }));
t('NO puede cargar producción a nombre de otra', /propia producción/.test(err?.message));

err = await tira(() => eq.confirmarPago(propios[0].id));
t('NO puede confirmarse a sí misma', !!err);
err = await tira(() => prod.fijarPagoProduccion(tarta.id, 9999));
t('NO puede subirse el pago por unidad', !!err);

const auto = await eq.marcarJornada(maria.id, M);
t('puede marcar su propio día', auto.accion === 'creada' && auto.jornada.confirmada === false);
err = await tira(() => eq.marcarJornada(ana.id, DOM));
t('NO puede marcar el día de otra', !!err);

/* ================================================================== */
console.log('\n── privacidad: solo ve lo suyo');

const suyo = await eq.resumenSemana(L, DOM);
t('el resumen trae una sola fila', suyo.filas.length === 1);
t('y es la propia', suyo.filas[0].trabajadora.id === maria.id);
t('no aparece Ana por ningún lado',
  !JSON.stringify(suyo).includes(ana.id) && !JSON.stringify(suyo).includes('Ana'));
t('cobra lo confirmado: sus 2 tartas de la orden de la administración', suyo.total === 600);
t('lo que cargó ella va aparte hasta que lo confirmen', suyo.sinConfirmar === 1);
t('ve sus unidades', suyo.filas[0].unidades === 2);

const crudo = await db.from('pago_produccion').select();
t('filtrarPropio recorta el listado crudo',
  auth.filtrarPropio(crudo).every((p) => p.trabajadora_id === maria.id));
t('y el crudo tenía de las dos', crudo.some((p) => p.trabajadora_id === ana.id));

/* ================================================================== */
console.log('\n── liquidación');

auth.rol = 'admin';
auth.trabajadoraId = null;

const antes = await eq.resumenSemana(L, DOM);
t('el admin ve a las dos', antes.filas.length === 2);
t('el pendiente es lo confirmado: 6 tartas a $300', antes.pendiente === 1800);
t('ve lo de María sin confirmar', antes.sinConfirmar === 1);
t('desglosa por producto',
  antes.filas.find((f) => f.trabajadora.id === ana.id).porProducto[0]?.unidades === 4);

const liq = await eq.liquidarSemana(L, DOM);
t('liquida el total pendiente', liq.total === 1800);
t('cuenta las unidades', liq.unidades === 6);
t('devuelve el detalle por trabajadora', liq.porTrabajadora.length === 2
  && liq.porTrabajadora.find((x) => x.trabajadora_id === ana.id).total === 1200);

const movs = await db.from('movimiento_caja').select().eq('origen', 'jornal');
t('genera UN solo egreso en caja', movs.length === 1);
t('el egreso es por el total', movs[0].monto === 1800);
t('y es egreso, no ingreso', movs[0].tipo === 'egreso');

const todos = await db.from('pago_produccion').select();
t('lo confirmado quedó pagado con fecha',
  todos.filter((p) => p.confirmada).every((p) => p.estado_pago === 'pagada' && !!p.fecha_pago));
t('lo sin confirmar NO se pagó', todos.filter((p) => !p.confirmada).every((p) => p.estado_pago === 'pendiente'));
t('las jornadas no se tocaron: son asistencia',
  (await db.from('jornada').select()).every((j) => j.estado_pago === 'pendiente'));

const otraVez = await tira(() => eq.liquidarSemana(L, DOM));
t('no se puede liquidar dos veces', otraVez !== null);
t('y no dejó un segundo egreso',
  (await db.from('movimiento_caja').select().eq('origen', 'jornal')).length === 1);

await eq.confirmarPago(propios[0].id);
const despues = await eq.resumenSemana(L, DOM);
t('confirmar lo de María lo suma al pendiente', despues.pendiente === 900);
t('ya no figura como sin confirmar', despues.sinConfirmar === 0);

const pagado = todos.find((p) => p.estado_pago === 'pagada');
err = await tira(() => eq.confirmarPago(pagado.id, false));
t('lo ya liquidado no se desconfirma', /liquidada/.test(err?.message || ''));

/* ================================================================== */
console.log('\n── alta de trabajadora');

const rocio = await eq.guardarTrabajadora({ nombre: 'Rocío' });
t('crea la trabajadora', !!rocio.id);
t('nace activa', rocio.activa === true);
t('sin tarifa por día', rocio.tarifa_dia === 0);
t('ni historial de tarifas',
  (await db.from('tarifa_historica').select().eq('trabajadora_id', rocio.id)).length === 0);

t('rechaza nombre vacío',
  (await tira(() => eq.guardarTrabajadora({ nombre: '  ' }))) !== null);

/* ================================================================== */
console.log('\n── identidad: mail y rol (fase 5 §4.1)');

t('nace con el rol por defecto', rocio.rol === 'trabajadora');
t('y sin mail', rocio.email === null);

const sofia = await eq.guardarTrabajadora({
  nombre: 'Sofía', email: '  Sofia@Cocina.AR  ', rol: 'admin',
});
t('guarda el rol que le pasan', sofia.rol === 'admin');
t('normaliza el mail: minúscula y sin espacios', sofia.email === 'sofia@cocina.ar');

t('rechaza algo que no tiene forma de mail',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Z', email: 'sofia arroba cocina' }))) !== null);
t('rechaza un mail sin punto en el dominio',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Z', email: 'sofia@cocina' }))) !== null);

/* El índice único de Postgres es sobre lower(email): acá tiene que doler igual */
t('rechaza el mail repetido aunque cambien las mayúsculas',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Z', email: 'SOFIA@Cocina.ar' }))) !== null);
t('y no la dejó creada a medias',
  !(await db.from('trabajadora').select()).some((x) => x.nombre === 'Z'));
t('pero la misma persona sí puede reguardar su propio mail',
  (await tira(() => eq.guardarTrabajadora({
    id: sofia.id, nombre: 'Sofía', email: 'sofia@cocina.ar', rol: 'admin',
  }))) === null);

t('rechaza un rol que no existe en auth.js',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Z', rol: 'jefa' }))) !== null);
t('acepta dirigente',
  (await tira(() => eq.guardarTrabajadora({ id: sofia.id, nombre: 'Sofía', rol: 'dirigente' }))) === null);

/* Una llamada que no conoce estos campos no puede borrarlos de refilón */
await eq.guardarTrabajadora({ id: sofia.id, nombre: 'Sofía' });
const intacta = await db.from('trabajadora').select().eq('id', sofia.id).single();
t('no mandar mail ni rol los deja como estaban',
  intacta.email === 'sofia@cocina.ar' && intacta.rol === 'dirigente');

/* Mandarlo vacío sí es borrarlo, y el mail queda libre */
await eq.guardarTrabajadora({ id: sofia.id, nombre: 'Sofía', email: '' });
t('mandar el mail vacío lo borra',
  (await db.from('trabajadora').select().eq('id', sofia.id).single()).email === null);
t('y ese mail queda libre para otra persona',
  (await tira(() => eq.guardarTrabajadora({
    nombre: 'Lucía', email: 'sofia@cocina.ar',
  }))) === null);

/* ================================================================== */
auth.rol = 'trabajadora';
t('una trabajadora no puede dar de alta a otra',
  (await tira(() => eq.guardarTrabajadora({ nombre: 'Y' }))) !== null);
t('ni liquidar',
  (await tira(() => eq.liquidarSemana(L, DOM))) !== null);

/* ================================================================== */
console.log('\n── el cierre semanal no cuenta la mano de obra dos veces');

auth.rol = 'admin';
const jornadasSem = await db.from('jornada').select().gte('fecha', L).lte('fecha', DOM);
const cierre = calc.cierreSemanal({ pedidos: [], items: [], jornadas: jornadasSem, gastos: [] });
t('las jornadas de ahora no suman costo laboral', cierre.costoLaboral === 0);
t('porque la paga ya va en el costo del producto',
  calc.costoEfectivo({ costo_manual: 1200, pago_produccion: 300 }) === 1500);

/* ================================================================== */
console.log('\n── histórico de liquidaciones pagadas');

auth.rol = 'admin';
auth.trabajadoraId = null;
const HOY = ui.hoyISO();

const histLiq = await eq.liquidacionesPagadas();
t('una liquidación por trabajadora pagada', histLiq.length === 2);
t('todas con la fecha en que se pagaron', histLiq.every((l) => l.fecha_pago === HOY));
const liqAna = histLiq.find((l) => l.trabajadora_id === ana.id);
t('Ana cobró sus 4 tartas a $300', liqAna.total === 1200 && liqAna.unidades === 4);
t('con una línea por producto y monto congelado',
  liqAna.lineas.length === 1 && liqAna.lineas[0].pago_unitario === 300 && liqAna.lineas[0].producto === 'Tarta de verdura');
t('el histórico cuadra con el egreso de caja',
  histLiq.reduce((a, l) => a + l.total, 0) === movs[0].monto);
t('las jornadas de asistencia no aparecen como plata', histLiq.every((l) => l.jornales.length === 0));

/* Regla 4: sube lo que se paga por tarta. Lo que Ana ya cobró no se mueve */
await prod.fijarPagoProduccion(tarta.id, 999);
const liqAnaDespues = (await eq.liquidacionesPagadas({ trabajadoraId: ana.id }))[0];
t('subir el pago NO recalcula lo ya cobrado',
  liqAnaDespues.total === 1200 && liqAnaDespues.lineas[0].pago_unitario === 300);
await prod.fijarPagoProduccion(tarta.id, 300);

/* Lo pagado por día antes del cambio es histórico real: aparece y suma una vez */
await db.from('jornada').insert([
  { trabajadora_id: ana.id, fecha: '2026-06-01', orden_produccion_id: null, tarifa_aplicada: 5000,
    origen_carga: 'admin', confirmada: true, estado_pago: 'pagada', fecha_pago: '2026-06-05' },
  { trabajadora_id: ana.id, fecha: '2026-06-02', orden_produccion_id: null, tarifa_aplicada: 0,
    origen_carga: 'admin', confirmada: true, estado_pago: 'pagada', fecha_pago: '2026-06-05' },
]);
const histAna = await eq.liquidacionesPagadas({ trabajadoraId: ana.id });
const vieja = histAna.find((l) => l.fecha_pago === '2026-06-05');
t('la liquidación vieja por día sigue en el histórico', !!vieja && vieja.total === 5000);
t('la jornada sin tarifa no se lista: es asistencia', vieja.jornales.length === 1);
t('va después de la nueva', histAna[0].fecha_pago === HOY && histAna[1] === vieja);
t('y nada suma dos veces', histAna.reduce((a, l) => a + l.total, 0) === 1200 + 5000);

/* ================================================================== */
console.log('\n── comprobante');

const comp = await eq.comprobanteLiquidacion(ana.id, HOY);
const txt = eq.textoComprobante(comp);
t('habla de pago por producción', txt.includes('Comprobante de pago por producción'));
t('lleva el nombre, las unidades y el total',
  txt.includes('Ana') && txt.includes(`4 Tarta de verdura × ${ui.money(300)}`) && txt.includes(ui.money(1200)));
t('firma la Federación «Mesa Solidaria Tandil»',
  txt.includes('Federación de Organizaciones Sociales «Mesa Solidaria Tandil»'));
const html = eq.htmlComprobante(comp);
t('el HTML trae las unidades producidas', html.includes('Unidades producidas') && html.includes('Tarta de verdura'));

const compViejo = await eq.comprobanteLiquidacion(ana.id, '2026-06-05');
t('el comprobante viejo no se disfraza de producción',
  eq.textoComprobante(compViejo).includes('Comprobante de pago de jornadas')
  && eq.htmlComprobante(compViejo).includes(ui.money(5000)));

const papel = [txt, html, eq.textoComprobante(compViejo), eq.htmlComprobante(compViejo)].join(' ').toLowerCase();
t('no dice sueldo, trabajo registrado, dependencia ni Mirmidones',
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
t('ni el nombre ni el id de Ana',
  !JSON.stringify(suyas).includes(ana.id) && !JSON.stringify(suyas).includes('Ana'));
t('pedir las de Ana por parámetro devuelve vacío',
  (await eq.liquidacionesPagadas({ trabajadoraId: ana.id })).length === 0);
t('NO puede sacar el comprobante de Ana',
  (await tira(() => eq.comprobanteLiquidacion(ana.id, HOY))) !== null);
t('ni el viejo por día',
  (await tira(() => eq.comprobanteLiquidacion(ana.id, '2026-06-05'))) !== null);
const compMaria = await eq.comprobanteLiquidacion(maria.id, HOY);
t('sí el suyo', compMaria.nombre === 'María' && compMaria.total === 600);
t('y en el suyo no aparece nadie más',
  !eq.htmlComprobante(compMaria).includes('Ana') && !eq.textoComprobante(compMaria).includes('Ana'));

/* ================================================================== */
console.log('\n── dos pagos el mismo día salen en un comprobante');

auth.rol = 'admin';
auth.trabajadoraId = null;
await eq.liquidarSemana(L, DOM);   // las 3 tartas de María que se confirmaron después
const deHoy = (await eq.liquidacionesPagadas()).filter((l) => l.fecha_pago === HOY);
const liqMaria = deHoy.find((l) => l.trabajadora_id === maria.id);
const egresos = await db.from('movimiento_caja').select().eq('origen', 'jornal');
t('María sigue teniendo una sola liquidación hoy',
  deHoy.filter((l) => l.trabajadora_id === maria.id).length === 1);
t('que suma los dos lotes: 5 tartas, $1.500', liqMaria.unidades === 5 && liqMaria.total === 1500);
t('y lo de hoy sigue cuadrando con la caja',
  deHoy.reduce((a, l) => a + l.total, 0) === egresos.reduce((a, m) => a + m.monto, 0));

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
