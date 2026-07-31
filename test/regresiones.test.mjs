/**
 * regresiones.test.mjs — un caso por cada bug encontrado en la revisión
 * profunda de las fases 2 y 3.
 *
 * Todos estos pasaban desapercibidos con las suites por fase en verde, porque
 * ninguna renderizaba dos veces sobre el mismo nodo, ni llamaba a las funciones
 * exportadas con argumentos inventados, ni simulaba un fallo a mitad de una
 * transacción. Si alguno de estos vuelve a fallar, volvió un bug conocido.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><body>
  <section class="view active" id="view-trabajadoras"></section>
  <section class="view active" id="view-pedidos"></section>
  <div class="modal" id="modal">
    <div class="modal__backdrop" data-close></div>
    <div class="modal__panel"><div id="modal-content"></div></div>
  </div>
</body>`, { url: 'http://localhost' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const { ui }       = await import('../js/ui.js');
const calc         = await import('../js/calc.js');
const eq           = await import('../js/modules/trabajadoras.js');
const prod         = await import('../js/modules/produccion.js');
const ped          = await import('../js/modules/pedidos.js');

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };
const tira = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const clic = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const esperar = (ms = 60) => new Promise((r) => setTimeout(r, ms));

await seed();
auth.rol = 'admin';
await state.cargar();

const ana   = state.trabajadoras.find((x) => x.nombre === 'Ana');
const maria = state.trabajadoras.find((x) => x.nombre === 'María');
const vistaEq = document.getElementById('view-trabajadoras');
const vistaVta = document.getElementById('view-pedidos');

/* ================================================================== */
console.log('\n── listeners acumulados (el que pagaba de más)');

/* `vista` es el <section> permanente del shell: los listeners colgados ahí
   sobreviven al innerHTML. Con render() llamándose a sí mismo desde el
   handler, cuatro taps llegaban a crear 26 jornadas en vez de 4. */
for (let i = 0; i < 4; i++) await eq.render(vistaEq);

const lunes = ui.hoyISO(ui.inicioSemana());
clic(vistaEq.querySelector(`[data-dia="${lunes}"]`));
await esperar(120);

let jornadas = await db.from('jornada').select().eq('fecha', lunes);
t('cuatro renders y un tap crean UNA sola jornada', jornadas.length === 1);

clic(vistaEq.querySelector(`[data-dia="${lunes}"]`));
await esperar(120);
jornadas = await db.from('jornada').select().eq('fecha', lunes);
t('el segundo tap la borra, no la duplica', jornadas.length === 0);

/* Lo mismo en venta rápida: un tap sumaba dos empanadas después de dos renders.
   Desde la Fase 2 el tab Pedidos tiene subnavegación y para un admin abre en la
   lista de pedidos, así que primero hay que pararse en la venta. */
await ped.render(vistaVta);
clic(vistaVta.querySelector('[data-sub="venta"]'));
await esperar(60);

for (let i = 0; i < 3; i++) await ped.render(vistaVta);
clic(vistaVta.querySelector('.producto-card'));
await esperar(30);
t('tres renders y un tap suman UNA unidad al carrito',
  vistaVta.querySelector('#items').textContent === '1 item');

/* ================================================================== */
console.log('\n── marcarJornada: el origen se deriva del rol');

auth.rol = 'trabajadora';
auth.trabajadoraId = maria.id;
await state.cargar();

const ayer = ui.hoyISO(new Date(Date.now() - 864e5));

/* Antes: cualquier valor que no fuera 'admin' ni 'autoreporte' no disparaba
   ninguna de las dos guardas, y se podían tocar jornadas ajenas. */
let err = await tira(() => eq.marcarJornada(ana.id, ayer, { origen: 'x' }));
t('con un origen inventado NO puede tocar el día de otra', !!err);

const propia = await eq.marcarJornada(maria.id, ayer, { origen: 'admin' });
t('pedir origen admin no la confirma sola',
  propia.jornada.confirmada === false && propia.jornada.origen_carga === 'autoreporte');

err = await tira(() => eq.marcarJornada(maria.id, ui.hoyISO(new Date(Date.now() + 864e5))));
t('no puede marcar un día que todavía no pasó', !!err);

err = await tira(() => eq.marcarJornada(maria.id, '2019-01-01'));
t('el autoreporte no llega a fechas viejas', !!err);

/* El admin marca un día suyo; ella no puede borrarlo sin querer */
auth.rol = 'admin'; auth.trabajadoraId = null; await state.cargar();
const delAdmin = await eq.marcarJornada(maria.id, ayer);   // toggle: borra la de ella
const confirmada = await eq.marcarJornada(maria.id, ayer); // y crea una confirmada
t('el admin deja la jornada confirmada', confirmada.jornada.confirmada === true);

auth.rol = 'trabajadora'; auth.trabajadoraId = maria.id; await state.cargar();
err = await tira(() => eq.marcarJornada(maria.id, ayer));
t('la trabajadora NO borra lo que el admin ya confirmó', !!err);

auth.rol = 'admin'; auth.trabajadoraId = null; await state.cargar();
await eq.marcarJornada(maria.id, ayer);   // limpieza

/* ================================================================== */
console.log('\n── permisos en la función, no solo en la pantalla');

auth.rol = 'trabajadora';
auth.trabajadoraId = ana.id;
await state.cargar();

const orden = await tira(() => prod.crearOrden({ items: [] }));
const ordenAdmin = await (async () => {
  auth.rol = 'admin'; auth.trabajadoraId = null;
  const p = state.productos[0];
  const o = await prod.crearOrden({ items: [{ producto_id: p.id, cantidad: 1 }] });
  auth.rol = 'trabajadora'; auth.trabajadoraId = ana.id;
  return o;
})();

err = await tira(() => prod.asignarTrabajadoras(ordenAdmin.id, [ana.id]));
t('una trabajadora NO se asigna sola a una orden', !!err);
t('y no se creó ninguna jornada confirmada de contrabando',
  (await db.from('jornada').select().eq('orden_produccion_id', ordenAdmin.id)).length === 0);

auth.rol = 'admin'; auth.trabajadoraId = null; await state.cargar();

/* ================================================================== */
console.log('\n── confirmar y liquidar');

const V = '2026-06-05';
const j = await eq.marcarJornada(ana.id, V);
await eq.liquidarSemana('2026-06-01', '2026-06-07');

err = await tira(() => eq.confirmarJornada(j.jornada.id, false));
t('no se desconfirma una jornada ya liquidada', !!err);

const pagada = await db.from('jornada').select().eq('id', j.jornada.id).single();
t('la jornada sigue confirmada y pagada',
  pagada.confirmada === true && pagada.estado_pago === 'pagada');

const egresos = await db.from('movimiento_caja').select().eq('origen', 'jornal');
t('la liquidación dejó UN solo egreso', egresos.length === 1);

/* ================================================================== */
console.log('\n── tarifa de una jornada retroactiva');

/* Ana no tiene fila en tarifa_historica (viene del seed). Le suben la tarifa
   y recién después cargan una jornada olvidada del mes pasado: antes se
   pagaba con la tarifa NUEVA, que es justo lo que tarifa_historica evita. */
const nuevaT = await db.from('trabajadora').insert({
  unidad_negocio_id: state.unidadNegocio.id,
  nombre: 'Rosa', tarifa_dia: 5000, fecha_ingreso: '2026-01-10', activa: true,
});
await state.cargar();

await eq.guardarTrabajadora({ id: nuevaT.id, nombre: 'Rosa', tarifaDia: 9000 });
const historial = await db.from('tarifa_historica').select().eq('trabajadora_id', nuevaT.id);
t('el aumento siembra también la tarifa vieja', historial.length === 2);

const retro = await eq.marcarJornada(nuevaT.id, '2026-03-15');
t('una jornada anterior al aumento se paga con la tarifa vieja',
  retro.jornada.tarifa_aplicada === 5000);

t('tarifaVigente no cae a la tarifa de hoy si la fecha es más vieja que todo',
  calc.tarifaVigente([{ tarifa_dia: 5000, vigente_desde: '2026-05-01' }], '2026-01-01', 99999) === 5000);

/* ================================================================== */
console.log('\n── la que dejó de trabajar igual cobra lo suyo');

const S1 = '2026-04-06', S2 = '2026-04-12';
await eq.marcarJornada(nuevaT.id, S1);
await db.from('trabajadora').update({ activa: false }).eq('id', nuevaT.id);
await state.cargar();

const resumen = await eq.resumenSemana(S1, S2);
const filaRosa = resumen.filas.find((f) => f.trabajadora.id === nuevaT.id);
t('aparece en el resumen aunque ya no esté activa', !!filaRosa);

const liq = await eq.liquidarSemana(S1, S2);
t('lo que muestra el resumen es lo que se paga', liq.total === resumen.pendiente);

/* ================================================================== */
console.log('\n── la venta no queda a medio hacer');

auth.rol = 'admin';
const producto = state.productos.find((p) => p.stock_actual > 0);
const stockAntes = producto.stock_actual;

const fromReal = db.from.bind(db);
db.from = (tabla) => {
  if (tabla === 'cobro') throw new Error('se llenó el almacenamiento');
  return fromReal(tabla);
};

err = await tira(() => ped.registrarVenta({
  lineas: [{ producto, cantidad: 3 }], medio: 'efectivo',
}));
db.from = fromReal;

t('si falla el cobro, la venta tira error', !!err);

const pedidos = await db.from('pedido').select();
const aMedias = pedidos.filter((p) => p.estado === 'entregado');
t('el pedido a medio hacer NO queda como entregado', aMedias.length === 0);

const cierre = calc.cierreSemanal({
  pedidos, items: await db.from('pedido_item').select(), jornadas: [], gastos: [],
});
t('y por lo tanto no suma a la rentabilidad', cierre.ventas === 0);
t('ni descontó stock que no salió',
  (await db.from('producto').select().eq('id', producto.id).single()).stock_actual === stockAntes);

/* La venta buena sí cierra entera */
const venta = await ped.registrarVenta({ lineas: [{ producto, cantidad: 3 }], medio: 'efectivo' });
t('la venta completa queda entregada y pagada',
  venta.pedido.estado === 'entregado' && venta.pedido.estado_pago === 'pagado'
  && venta.pedido.monto_cobrado === venta.total);

/* ================================================================== */
console.log('\n── el stock se descuenta desde la base, no desde la caché');

/* Simula la otra pestaña: la base baja a 10 y state se quedó en el valor viejo */
await db.from('producto').update({ stock_actual: 10 }).eq('id', producto.id);
const productoViejo = { ...producto, stock_actual: 999 };

await ped.registrarVenta({ lineas: [{ producto: productoViejo, cantidad: 2 }], medio: 'efectivo' });
const despues = await db.from('producto').select().eq('id', producto.id).single();
t('descuenta sobre el stock real, no sobre el que tenía en memoria', despues.stock_actual === 8);

/* ================================================================== */
console.log('\n── qué queda en memoria según quién entró');

auth.rol = 'trabajadora';
auth.trabajadoraId = maria.id;
await state.cargar();

const otras = state.trabajadoras.filter((x) => x.id !== maria.id);
t('hay más de una trabajadora cargada', otras.length > 0);
t('la tarifa ajena no está ni en memoria', otras.every((x) => x.tarifa_dia === undefined));
t('la propia sí la conserva',
  state.trabajadoras.find((x) => x.id === maria.id)?.tarifa_dia !== undefined);

/* El seed no trae PINs, así que sin este alta el test de abajo pasaba con el
   arreglo y sin él: no había ningún hash que filtrar. */
auth.rol = 'admin'; auth.trabajadoraId = null;
await auth.cambiarPinTrabajadora(ana.id, '2468');
auth.rol = 'trabajadora'; auth.trabajadoraId = maria.id;
await state.cargar();

t('la trabajadora tiene PIN en la base',
  !!(await db.from('trabajadora').select().eq('id', ana.id).single()).pin_acceso);
t('pero el hash NO llega a memoria', state.trabajadoras.every((x) => x.pin_acceso === undefined));

/* ================================================================== */
console.log('\n── fechas locales, no UTC');

/* La franja peligrosa es 21:00–24:00 en Argentina, que en UTC ya es mañana.
   Sin fijar la hora, el test pasaba con el bug 21 de cada 24 horas — y en una
   máquina con TZ=UTC pasaba siempre. */
const nocturno = new Date(2026, 7, 2, 21, 30);   // domingo 21:30 LOCAL
const marca = ui.ahoraISO(nocturno);

t('ahoraISO usa la fecha local del reloj', marca.slice(0, 10) === ui.hoyISO(nocturno));
t('y esa fecha es la del día que la persona está viviendo', marca.startsWith('2026-08-02'));
t('no es una marca UTC', !marca.endsWith('Z'));
t('sigue siendo una marca de tiempo', marca.includes('T21:30'));
t('toISOString habría dado otro día en Argentina o el mismo en UTC — no se usa',
  marca.slice(0, 10) !== nocturno.toISOString().slice(0, 10)
  || nocturno.getTimezoneOffset() === 0);

const movs = await db.from('movimiento_stock_producto').select().eq('tipo', 'venta');
const pedidoDeVenta = await db.from('pedido').select().eq('id', movs[0].referencia_id).single();
t('el movimiento de stock cae en la misma fecha que su pedido',
  movs[0].fecha.slice(0, 10) === pedidoDeVenta.fecha_pedido);

t('inicioSemana acepta un string ISO sin irse a la semana anterior',
  ui.hoyISO(ui.inicioSemana('2026-07-27')) === '2026-07-27');
t('y con un miércoles devuelve su lunes',
  ui.hoyISO(ui.inicioSemana('2026-07-29')) === '2026-07-27');
t('una fecha vacía no revienta la vista', ui.fecha(null) === '—' && ui.fecha(undefined) === '—');

/* ================================================================== */
/*  Revisión de las fases 0 y 1                                        */
/* ================================================================== */

console.log('\n── el modal se puede volver a cerrar después de guardar');

auth.rol = 'admin'; auth.trabajadoraId = null; await state.cargar();

ui.abrirModal('<p>uno</p>');
ui.bloquearModal();
t('bloqueado no cierra', ui.cerrarModal() === false);
ui.bloquearModal(false);
t('desbloqueado sí cierra', ui.cerrarModal() === true);

/* El bug: se apagaba pointerEvents del fondo, que es un nodo permanente del
   shell, y no se restauraba nunca. Después de la primera venta ningún modal
   se volvía a cerrar tocando afuera. */
t('el fondo del modal sigue vivo',
  document.querySelector('.modal__backdrop').style.pointerEvents !== 'none');

ui.abrirModal('<p>dos</p>');
t('un modal nuevo arranca desbloqueado', ui.cerrarModal() === true);

const cancelada = ui.confirmar('¿Seguro?');
document.querySelector('#modal [data-close]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
t('confirmar() resuelve false al cancelar, no queda colgada', await cancelada === false);

/* ================================================================== */
console.log('\n── PIN repetido');

await auth.crearPinAdmin('1234');
err = await tira(() => auth.cambiarPinTrabajadora(maria.id, '1234'));
t('una trabajadora no puede quedarse con el PIN del admin', !!err);

await auth.cambiarPinTrabajadora(maria.id, '9753');
err = await tira(() => auth.cambiarPinTrabajadora(ana.id, '9753'));
t('ni con el de otra trabajadora', !!err);

const sesion = await auth.ingresar('9753');
t('cada PIN entra con su dueña', sesion?.trabajadora?.id === maria.id);
auth.rol = 'admin'; auth.trabajadoraId = null;

/* ================================================================== */
console.log('\n── db.js: escrituras');

err = await tira(() => db.from('producto').update({ precio_venta: 0 }));
t('update sin filtros no pasa', !!err);
err = await tira(() => db.from('pedido').delete());
t('delete sin filtros tampoco', !!err);

const cli = await db.from('cliente').insert({ nombre: 'Prueba', telefono: '1', tipo: 'particular', notas: 'a' });
await Promise.all([
  db.from('cliente').update({ telefono: '2' }).eq('id', cli.id),
  db.from('cliente').update({ notas: 'b' }).eq('id', cli.id),
]);
const cliFinal = await db.from('cliente').select().eq('id', cli.id).single();
t('dos updates concurrentes no se pisan los campos',
  cliFinal.telefono === '2' && cliFinal.notas === 'b');

await db.from('cliente').insert([
  { nombre: 'Ñandú', tipo: 'particular' },
  { nombre: 'Ácido', tipo: 'particular' },
  { nombre: 'zapallo', tipo: 'particular' },
]);
const alfabetico = (await db.from('cliente').select().order('nombre')).map((c) => c.nombre);
t('ordena en castellano: la Ñ y los acentos no caen después de la Z',
  alfabetico.indexOf('Ácido') < alfabetico.indexOf('Ñandú')
  && alfabetico.indexOf('Ñandú') < alfabetico.indexOf('zapallo'));

/* ================================================================== */
console.log('\n── el backup se puede restaurar de verdad');

const copia = await db.exportAll();
t('el export no lleva el hash del PIN de nadie',
  copia.trabajadora.every((x) => x.pin_acceso === undefined));
t('ni el PIN del admin ni el salt',
  !copia.config.some((c) => ['admin_pin', 'pin_salt'].includes(c.clave)));

const clientesEnCopia = copia.cliente.length;
await db.from('cliente').insert({ nombre: 'Posterior al backup', tipo: 'particular' });
await db.importAll(copia);

const trasRestaurar = await db.from('cliente').select();
t('restaurar REEMPLAZA, no mezcla con lo cargado después',
  trasRestaurar.length === clientesEnCopia
  && !trasRestaurar.some((c) => c.nombre === 'Posterior al backup'));
t('el PIN de administración sobrevive a la restauración',
  !!(await db.getConfig('admin_pin')));

err = await tira(() => db.importAll({ cualquier: 'cosa' }));
t('un archivo que no es un backup se rechaza', !!err);

/* ================================================================== */
console.log('\n── costeo: un insumo sin costo no vale cero');

await state.cargar();
const prem = await db.from('insumo').insert({
  unidad_negocio_id: state.unidadNegocio.id,
  nombre: 'Carne premium', categoria: 'Carnicería', unidad_medida: 'kg',
  costo_unitario: 0, stock_actual: 0, stock_minimo: 0, activo: true,
});
await state.cargar();

const prod2 = state.productos.find((p) => p.nombre === 'Empanada de carne');
err = await tira(() => prod.guardarReceta(prod2.id, [
  { insumo_id: prem.id, cantidad: 500, unidad_medida: 'g', merma_pct: 0 },
], 24));
const empSinCosto = await db.from('producto').select().eq('id', prod2.id).single();

t('costoProducto avisa en vez de costear en cero',
  !!err || (await db.from('producto').select().eq('id', prod2.id).single()).costo_calculado !== 0);
t('el producto NO queda con costo cero', !empSinCosto.costo_calculado === false || empSinCosto.costo_calculado == null);

t('un costo calculado en 0 no le gana al costo manual',
  calc.costoEfectivo({ costo_calculado: 0, costo_manual: 350 }) === 350);

t('el ponderado ignora un stock negativo en vez de dispararse',
  calc.costoPonderado(-5, 600, 10, 2000) === 2000);

err = await tira(() => prod.guardarReceta(prod2.id, [
  { insumo_id: state.insumos.find((i) => i.nombre === 'Harina 000').id,
    cantidad: 1, unidad_medida: 'kg', merma_pct: 900 },
], 24));
t('una merma de 900% no se guarda', !!err);

/* ================================================================== */
console.log('\n── cambiar la unidad de un insumo convierte de verdad');

const harina2 = state.insumos.find((i) => i.nombre === 'Harina 000');
const antesH = await db.from('insumo').select().eq('id', harina2.id).single();

await prod.guardarInsumo(harina2.id, { unidad_medida: 'g' });
const enGramos = await db.from('insumo').select().eq('id', harina2.id).single();

t('el stock se convierte a la unidad nueva',
  Math.abs(enGramos.stock_actual - antesH.stock_actual * 1000) < 1e-6);
t('y el costo por unidad se convierte al revés',
  Math.abs(enGramos.costo_unitario - antesH.costo_unitario / 1000) < 1e-9);

err = await tira(() => prod.guardarInsumo(harina2.id, { unidad_medida: 'l' }));
t('no deja pasar de peso a volumen', !!err);
await prod.guardarInsumo(harina2.id, { unidad_medida: 'kg' });   // vuelta atrás

/* ================================================================== */
console.log('\n── cerrar una orden');

await state.cargar();
const emp2 = state.productos.find((p) => p.nombre === 'Empanada jamón y queso');
const har = state.insumos.find((i) => i.nombre === 'Harina 000');
await prod.guardarReceta(emp2.id, [
  { insumo_id: har.id, cantidad: 1, unidad_medida: 'kg', merma_pct: 0 },
], 24);
await db.from('insumo').update({ stock_actual: 20, costo_unitario: 1000 }).eq('id', har.id);

const o1 = await prod.crearOrden({ items: [{ producto_id: emp2.id, cantidad: 48 }] });
const harAntes = (await db.from('insumo').select().eq('id', har.id).single()).stock_actual;
await prod.cerrarOrden(o1.id, Object.fromEntries(
  (await db.from('produccion_item').select().eq('orden_produccion_id', o1.id)).map((i) => [i.id, 36]),
));
const harDespues = (await db.from('insumo').select().eq('id', har.id).single()).stock_actual;

t('descuenta el insumo de lo planificado aunque salga menos',
  Math.abs((harAntes - harDespues) - 2) < 1e-6);

const o2 = await prod.crearOrden({ items: [{ producto_id: emp2.id, cantidad: 24 }] });
const stockProdAntes = (await db.from('producto').select().eq('id', emp2.id).single()).stock_actual;
await Promise.allSettled([prod.cerrarOrden(o2.id, {}), prod.cerrarOrden(o2.id, {})]);
const stockProdDespues = (await db.from('producto').select().eq('id', emp2.id).single()).stock_actual;

t('cerrar dos veces en paralelo no duplica el producto terminado',
  stockProdDespues - stockProdAntes === 24);
t('y deja un solo movimiento de stock de producción',
  (await db.from('movimiento_stock_producto').select().eq('referencia_id', o2.id)).length === 1);

const o3 = await prod.crearOrden({ items: [{ producto_id: emp2.id, cantidad: 24 }] });
const item3 = (await db.from('produccion_item').select().eq('orden_produccion_id', o3.id))[0];
err = await tira(() => prod.cerrarOrden(o3.id, { [item3.id]: -24 }));
t('una cantidad negativa no cierra la orden', !!err);
t('y la orden queda como estaba, no trabada',
  (await db.from('orden_produccion').select().eq('id', o3.id).single()).estado === 'planificada');

/* ================================================================== */
console.log('\n── no se paga un día que todavía no pasó');

const manana = ui.hoyISO(new Date(Date.now() + 864e5));
const oFutura = await prod.crearOrden({ fecha: manana, items: [{ producto_id: emp2.id, cantidad: 24 }] });
err = await tira(() => prod.asignarTrabajadoras(oFutura.id, [ana.id]));
t('no se asigna equipo a una orden que todavía no pasó', !!err);
t('y no quedó ninguna jornada futura',
  (await db.from('jornada').select().eq('fecha', manana)).length === 0);

await db.from('jornada').insert({
  trabajadora_id: ana.id, fecha: manana, orden_produccion_id: null,
  tarifa_aplicada: 5000, origen_carga: 'admin', confirmada: true, estado_pago: 'pendiente',
});
const liqFutura = await tira(() => eq.liquidarSemana(manana, manana));
t('liquidar no alcanza una jornada de mañana ni cargada a mano', !!liqFutura);

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
