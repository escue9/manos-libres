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

/* Lo mismo en venta rápida: un tap sumaba dos empanadas después de dos renders */
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
t('ninguna trae el hash del PIN', state.trabajadoras.every((x) => x.pin_acceso === undefined));
t('la tarifa ajena no está ni en memoria', otras.every((x) => x.tarifa_dia === undefined));
t('la propia sí la conserva',
  state.trabajadoras.find((x) => x.id === maria.id)?.tarifa_dia !== undefined);

/* ================================================================== */
console.log('\n── fechas: el movimiento de stock y su pedido, el mismo día');

const nocturno = new Date(2026, 7, 2, 21, 30);   // domingo 21:30 local
t('ahoraISO arranca con la fecha local, no con la UTC del día siguiente',
  ui.ahoraISO(nocturno).startsWith('2026-08-02'));
t('y sigue siendo una marca de tiempo', ui.ahoraISO(nocturno).includes('T21:30'));

const movs = await db.from('movimiento_stock_producto').select().eq('tipo', 'venta');
const pedidoDeVenta = await db.from('pedido').select().eq('id', movs[0].referencia_id).single();
t('el movimiento de stock cae en la misma fecha que su pedido',
  movs[0].fecha.slice(0, 10) === pedidoDeVenta.fecha_pedido);

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
