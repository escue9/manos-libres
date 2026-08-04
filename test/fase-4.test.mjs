/**
 * Fase 4 — Caja, cierre semanal y rentabilidad por producto.
 *
 * Lo que más importa acá es la regla 5: caja y rentabilidad son cosas
 * distintas y nunca se suman. Y la regla 6: los movimientos automáticos no se
 * cargan a mano, porque el doble conteo no se nota hasta que el cierre no
 * cuadra y ya nadie sabe cuál era el número bueno.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state } = await import('../js/state.js');
const { auth }  = await import('../js/auth.js');
const calc      = await import('../js/calc.js');
const caja      = await import('../js/modules/caja.js');
const ped       = await import('../js/modules/pedidos.js');

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };
const tira = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const cerca = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

await seed();
await state.cargar();
auth.rol = 'admin';

// Local y no UTC, igual que ui.hoyISO() —que no se importa acá para no
// arrastrar el DOM—: entre las 21 y la medianoche de Argentina el día UTC ya es
// el siguiente, así que el pedido quedaba entregado el 3 y el test lo buscaba
// en el 4. El suite pasaba de mañana y fallaba de noche.
const hoy = (() => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

/* ================================================================== */
console.log('\n── carga manual de movimientos');

let err = await tira(() => caja.registrarMovimiento({ origen: 'cobro', monto: 5000 }));
t('un cobro NO se puede cargar a mano', !!err);
t('y explica por qué', /se generan solos|no se cargan a mano/i.test(err.message));

for (const origen of ['compra_insumo', 'jornal']) {
  err = await tira(() => caja.registrarMovimiento({ origen, monto: 1000 }));
  t(`${origen} tampoco se carga a mano`, !!err);
}

t('un monto en cero no pasa',
  !!(await tira(() => caja.registrarMovimiento({ origen: 'gasto_operativo', monto: 0 }))));
t('un monto negativo tampoco',
  !!(await tira(() => caja.registrarMovimiento({ origen: 'gasto_operativo', monto: -500 }))));
t('una fecha futura tampoco',
  !!(await tira(() => caja.registrarMovimiento({
    origen: 'gasto_operativo', monto: 500, fecha: '2099-01-01',
  }))));

const gasto = await caja.registrarMovimiento({
  origen: 'gasto_operativo', monto: 12000, categoriaGasto: 'Gas', descripcion: 'Garrafa',
});
t('un gasto operativo sí se carga', gasto.monto === 12000);
t('y queda como egreso', gasto.tipo === 'egreso');
t('con su rubro', gasto.categoria_gasto === 'Gas');

const aporte = await caja.registrarMovimiento({ origen: 'aporte', monto: 50000 });
t('un aporte entra como ingreso', aporte.tipo === 'ingreso');

const retiro = await caja.registrarMovimiento({ origen: 'retiro', monto: 8000 });
t('un retiro entra como egreso', retiro.tipo === 'egreso');

t('el rubro solo se guarda en los gastos',
  aporte.categoria_gasto === null && retiro.categoria_gasto === null);

/* ================================================================== */
console.log('\n── el saldo de caja');

const movimientos = await db.from('movimiento_caja').select();
t('el saldo suma ingresos y resta egresos',
  cerca(calc.saldoCaja(movimientos), 50000 - 12000 - 8000));

/* ================================================================== */
console.log('\n── caja y rentabilidad no se mezclan (regla 5)');

// Un pedido entregado y NO cobrado: suma a la ganancia, no a la caja.
const empanada = state.productos.find((p) => p.nombre === 'Empanada de carne');
const { pedido } = await ped.crearPedido({
  cliente: { nombre: 'Impaga', telefono: '2494559999' },
  items: [{ producto_id: empanada.id, cantidad: 10 }],
  fechaEntrega: hoy,
});
await ped.entregarPedido(pedido.id);

const saldoAntes = calc.saldoCaja(await db.from('movimiento_caja').select());

const pedidos = await db.from('pedido').select();
const items = await db.from('pedido_item').select();
const entregadoHoy = pedidos.filter((p) => p.estado === 'entregado' && p.fecha_entrega === hoy);
const cierre = calc.cierreSemanal({
  pedidos: entregadoHoy,
  items: items.filter((i) => entregadoHoy.some((p) => p.id === i.pedido_id)),
  jornadas: [],
  gastos: [],
});

t('el pedido entregado e impago suma a las ventas', cierre.ventas >= 8000);
t('pero NO movió la caja',
  cerca(calc.saldoCaja(await db.from('movimiento_caja').select()), saldoAntes));

// Recién al cobrarlo entra a la caja.
await ped.registrarCobro(pedido.id, { monto: 8000, medio: 'efectivo' });
t('cobrarlo sí mueve la caja',
  cerca(calc.saldoCaja(await db.from('movimiento_caja').select()), saldoAntes + 8000));

const cierreDespues = calc.cierreSemanal({
  pedidos: entregadoHoy,
  items: items.filter((i) => entregadoHoy.some((p) => p.id === i.pedido_id)),
  jornadas: [], gastos: [],
});
t('y NO vuelve a sumar a las ventas: ya estaban devengadas',
  cerca(cierreDespues.ventas, cierre.ventas));

/* ================================================================== */
console.log('\n── el semáforo del cierre');

const semaforo = (v) => calc.cierreSemanal({
  pedidos: [{ id: 'x', estado: 'entregado', descuento: 0 }],
  items: [{ pedido_id: 'x', cantidad: 1, precio_unitario: 1000, costo_unitario: v.costo }],
  jornadas: [], gastos: v.gastos ? [{ monto: v.gastos }] : [],
}).semaforo;

t('con ganancia sana el semáforo va en verde', semaforo({ costo: 300 }) === 'ok');
t('con margen neto bajo el 15% va en amarillo', semaforo({ costo: 900 }) === 'warn');
t('en pérdida va en rojo', semaforo({ costo: 300, gastos: 900 }) === 'danger');

/* ================================================================== */
console.log('\n── rentabilidad por producto');

// Dos productos en un mismo pedido con descuento: el descuento se prorratea.
const filas = calc.rentabilidadProductos({
  pedidos: [{ id: 'p1', estado: 'entregado', descuento: 1000 }],
  items: [
    { pedido_id: 'p1', producto_id: 'a', cantidad: 10, precio_unitario: 800, costo_unitario: 350 },
    { pedido_id: 'p1', producto_id: 'b', cantidad: 1, precio_unitario: 2000, costo_unitario: 900 },
  ],
  productos: [{ id: 'a', nombre: 'Empanada' }, { id: 'b', nombre: 'Tarta' }],
});

t('ordena por facturación', filas[0].nombre === 'Empanada');
t('el descuento se prorratea según lo que pesa cada línea',
  cerca(filas[0].facturacion, 7200) && cerca(filas[1].facturacion, 1800));

// Sin prorratear, esta suma no daría igual que el cierre y dos pantallas que
// miran lo mismo mostrarían números distintos.
const cierrePar = calc.cierreSemanal({
  pedidos: [{ id: 'p1', estado: 'entregado', descuento: 1000 }],
  items: [
    { pedido_id: 'p1', producto_id: 'a', cantidad: 10, precio_unitario: 800, costo_unitario: 350 },
    { pedido_id: 'p1', producto_id: 'b', cantidad: 1, precio_unitario: 2000, costo_unitario: 900 },
  ],
});
t('la facturación por producto cierra exacto contra las ventas del cierre',
  cerca(filas.reduce((a, f) => a + f.facturacion, 0), cierrePar.ventas));

t('el aporte al total suma 100%',
  cerca(filas.reduce((a, f) => a + f.aportePct, 0), 100));

t('usa los snapshots, no el precio de hoy',
  cerca(filas[0].costo, 3500));

t('un pedido no entregado no entra',
  calc.rentabilidadProductos({
    pedidos: [{ id: 'p1', estado: 'confirmado' }],
    items: [{ pedido_id: 'p1', producto_id: 'a', cantidad: 5, precio_unitario: 800, costo_unitario: 350 }],
    productos: [{ id: 'a', nombre: 'Empanada' }],
  }).length === 0);

t('un producto dado de baja no rompe el informe',
  calc.rentabilidadProductos({
    pedidos: [{ id: 'p1', estado: 'entregado' }],
    items: [{ pedido_id: 'p1', producto_id: 'fantasma', cantidad: 1, precio_unitario: 100, costo_unitario: 50 }],
    productos: [],
  })[0].nombre === 'Producto dado de baja');

/* ================================================================== */
console.log('\n── cuadrantes');

const conCuadrante = calc.cuadrantes([
  { nombre: 'A', unidades: 100, margenPct: 60 },
  { nombre: 'B', unidades: 5,   margenPct: 70 },
  { nombre: 'C', unidades: 90,  margenPct: 10 },
  { nombre: 'D', unidades: 3,   margenPct: 5 },
]);
const cuad = Object.fromEntries(conCuadrante.map((f) => [f.nombre, f.cuadrante]));

t('mucho volumen y buen margen es estrella', cuad.A === 'estrella');
t('poco volumen y buen margen es oportunidad', cuad.B === 'oportunidad');
t('mucho volumen y mal margen es para revisar', cuad.C === 'revisar');
t('poco volumen y mal margen es candidato a discontinuar', cuad.D === 'discontinuar');

/* ================================================================== */
console.log('\n── permisos');

auth.rol = 'trabajadora';
t('una trabajadora no carga movimientos de caja',
  !!(await tira(() => caja.registrarMovimiento({ origen: 'gasto_operativo', monto: 100 }))));
t('y no ve la tab de caja', !auth.puedeVer('caja'));

auth.rol = 'dirigente';
t('la comisión ve la caja', auth.puedeVer('caja'));
t('pero no carga movimientos: mira, no opera',
  !!(await tira(() => caja.registrarMovimiento({ origen: 'gasto_operativo', monto: 100 }))));
t('y sí puede exportar', auth.puede('exportar'));

auth.rol = 'admin';

/* ================================================================== */
console.log(`\n${ok} pasaron · ${mal} fallaron`);
process.exit(mal ? 1 : 0);
