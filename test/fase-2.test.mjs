/**
 * fase-2.test.mjs — Clientes · Pedidos · Entrega · Cobros · Anulación
 *
 * Lo que más importa acá es que NO pasen cosas: que cargar un pedido no toque
 * el stock, que entregar no sume a la caja, que cobrar no sume dos veces, que
 * no se pueda cobrar de más, y que editar un pedido no recalcule el precio que
 * ya se le dijo al cliente.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const { ui }       = await import('../js/ui.js');
const ped          = await import('../js/modules/pedidos.js');
const calc         = await import('../js/calc.js');

let ok = 0, mal = 0;
const t = (n, c) => { c ? (ok++, console.log('  ✓', n)) : (mal++, console.log('  ✗', n)); };
const falla = async (n, fn) => {
  try { await fn(); t(n, false); } catch { t(n, true); }
};

await seed();
auth.rol = 'admin';
await state.cargar();

const carne = state.productos.find((p) => p.nombre === 'Empanada de carne');
const tarta = state.productos.find((p) => p.nombre === 'Tarta de verdura');
const hoy = ui.hoyISO();

/* ================================================================== */
console.log('\n── clientes');

const club = await ped.guardarCliente({
  nombre: 'Club Uncas', telefono: '2494 55-1234', tipo: 'club', direccion: 'Ruta 226',
});
t('crea el cliente', !!club.id && club.nombre === 'Club Uncas');
t('normaliza el tipo', club.tipo === 'club');

await falla('no deja dos clientes con el mismo teléfono',
  () => ped.guardarCliente({ nombre: 'Otro', telefono: '249455 1234' }));

await falla('exige nombre', () => ped.guardarCliente({ nombre: '  ' }));

const vecina = await ped.guardarCliente({ nombre: 'Vecina del CIC', telefono: '' });
t('deja crear sin teléfono', !!vecina.id);

const porTel = await ped.buscarPorTelefono('(2494) 551234');
t('encuentra por teléfono con cualquier formato', porTel?.id === club.id);

t('segmento: sin pedidos es nuevo', calc.segmentoCliente(0) === 'nuevo');
t('segmento: 2 pedidos es frecuente', calc.segmentoCliente(2) === 'frecuente');
t('segmento: 5 pedidos es fiel', calc.segmentoCliente(5) === 'fiel');

t('estado de pago: sin cobrar es impago', calc.estadoPago(1000, 0) === 'impago');
t('estado de pago: parcial es seña', calc.estadoPago(1000, 400) === 'sena');
t('estado de pago: completo es pagado', calc.estadoPago(1000, 1000) === 'pagado');
t('estado de pago: tolera el centavo del redondeo',
  calc.estadoPago(16600, 16599.9999999) === 'pagado');

/* ================================================================== */
console.log('\n── cargar un pedido');

const { pedido, faltantes } = await ped.crearPedido({
  clienteId: club.id,
  canal: 'whatsapp',
  fechaEntrega: hoy,
  descuento: 1000,
  items: [
    { producto_id: carne.id, cantidad: 10 },
    { producto_id: tarta.id, cantidad: 2 },
  ],
});

t('nace confirmado si hay stock', pedido.estado === 'confirmado');
t('total = 10×800 + 2×3500 − 1000', pedido.total === 14000);
t('nace impago', pedido.estado_pago === 'impago' && pedido.monto_cobrado === 0);
t('no hay faltantes', faltantes.length === 0);
t('no es una venta de mostrador', pedido.es_mostrador !== true);
t('guarda quién lo cargó', pedido.created_by_rol === 'admin');

const itemsPedido = await db.from('pedido_item').select().eq('pedido_id', pedido.id);
t('guarda 2 líneas', itemsPedido.length === 2);
t('congela el precio', itemsPedido.find((i) => i.producto_id === carne.id).precio_unitario === 800);
t('congela el costo', itemsPedido.find((i) => i.producto_id === carne.id).costo_unitario === 350);

await state.cargar();
t('cargar el pedido NO toca el stock', state.productoPorId(carne.id).stock_actual === 50);
t('cargar el pedido NO toca la caja', (await db.from('movimiento_caja').select()).length === 0);

await falla('no deja un pedido sin productos',
  () => ped.crearPedido({ clienteId: club.id, fechaEntrega: hoy, items: [] }));

await falla('no deja descuento mayor que el pedido', () => ped.crearPedido({
  clienteId: club.id, fechaEntrega: hoy, descuento: 99999,
  items: [{ producto_id: carne.id, cantidad: 1 }],
}));

await falla('no deja crear un pedido ya entregado', () => ped.crearPedido({
  clienteId: club.id, fechaEntrega: hoy, estado: 'entregado',
  items: [{ producto_id: carne.id, cantidad: 1 }],
}));

/* --- falta stock: el pedido entra en producción --- */

const grande = await ped.crearPedido({
  clienteId: vecina.id,
  fechaEntrega: hoy,
  items: [{ producto_id: tarta.id, cantidad: 30 }],   // hay 8
});
t('si falta producto terminado el pedido entra en producción',
  grande.pedido.estado === 'en_produccion');
t('avisa cuánto falta', grande.faltantes[0].falta === 22);

const demanda = await ped.demandaPendiente();
const demTarta = demanda.find((d) => d.producto_id === tarta.id);
t('la demanda pendiente suma los pedidos abiertos', demTarta.pedido === 32);
t('la demanda pendiente descuenta el stock', demTarta.falta === 24);

/* ================================================================== */
console.log('\n── editar el pedido');

// Sube el precio de la empanada DESPUÉS de cargado el pedido
await db.from('producto').update({ precio_venta: 1200 }).eq('id', carne.id);

await ped.actualizarPedido(pedido.id, {
  items: [
    { producto_id: carne.id, cantidad: 12 },     // línea que ya estaba
    { producto_id: tarta.id, cantidad: 2 },
  ],
  descuento: 1000,
});

const itemsEditado = await db.from('pedido_item').select().eq('pedido_id', pedido.id);
const lineaCarne = itemsEditado.find((i) => i.producto_id === carne.id);
t('la línea que ya estaba conserva su precio congelado', lineaCarne.precio_unitario === 800);
t('actualiza la cantidad', lineaCarne.cantidad === 12);

const pedidoEditado = await db.from('pedido').select().eq('id', pedido.id).single();
t('recalcula el total con el precio viejo', pedidoEditado.total === 12 * 800 + 2 * 3500 - 1000);

await db.from('producto').update({ precio_venta: 800 }).eq('id', carne.id);

await ped.actualizarPedido(pedido.id, {
  items: [{ producto_id: carne.id, cantidad: 10 }, { producto_id: tarta.id, cantidad: 2 }],
  descuento: 1000,
});
const vueltaAtras = await db.from('pedido').select().eq('id', pedido.id).single();
t('vuelve a 14.000', vueltaAtras.total === 14000);

await ped.cambiarEstadoPedido(pedido.id, 'listo');
t('cambia de estado', (await db.from('pedido').select().eq('id', pedido.id).single()).estado === 'listo');

await falla('cambiarEstado no entrega', () => ped.cambiarEstadoPedido(pedido.id, 'entregado'));

/* ================================================================== */
console.log('\n── entregar');

await ped.entregarPedido(pedido.id);
const entregado = await db.from('pedido').select().eq('id', pedido.id).single();
t('queda entregado', entregado.estado === 'entregado');

await state.cargar();
t('descuenta el stock de empanadas', state.productoPorId(carne.id).stock_actual === 40);
t('descuenta el stock de tartas', state.productoPorId(tarta.id).stock_actual === 6);

const movStock = await db.from('movimiento_stock_producto').select().eq('referencia_id', pedido.id);
t('deja un movimiento de stock por producto', movStock.length === 2);
t('el movimiento es de venta y negativo',
  movStock.every((m) => m.tipo === 'venta' && m.cantidad < 0));

t('entregar NO toca la caja', (await db.from('movimiento_caja').select()).length === 0);
t('entregado sigue impago', entregado.estado_pago === 'impago');

await falla('no se entrega dos veces', () => ped.entregarPedido(pedido.id));
await falla('un pedido entregado no se edita',
  () => ped.actualizarPedido(pedido.id, { notas: 'tarde' }));

/* ================================================================== */
console.log('\n── cobrar');

const sena = await ped.registrarCobro(pedido.id, { monto: 5000, medio: 'transferencia' });
t('la seña deja el pedido con seña', sena.estadoPago === 'sena');
t('informa lo que resta', sena.resta === 9000);

const conSena = await db.from('pedido').select().eq('id', pedido.id).single();
t('acumula el monto cobrado', conSena.monto_cobrado === 5000);

const movs1 = await db.from('movimiento_caja').select();
t('el cobro genera UN ingreso automático', movs1.length === 1);
t('el ingreso apunta al cobro',
  movs1[0].tipo === 'ingreso' && movs1[0].origen === 'cobro' && movs1[0].referencia_id === sena.cobro.id);
t('la caja percibida es la seña, no el total', calc.saldoCaja(movs1) === 5000);

await falla('no se puede cobrar de más',
  () => ped.registrarCobro(pedido.id, { monto: 9001, medio: 'efectivo' }));
await falla('no se puede cobrar cero',
  () => ped.registrarCobro(pedido.id, { monto: 0, medio: 'efectivo' }));

const saldo = await ped.registrarCobro(pedido.id, { monto: 9000, medio: 'efectivo' });
t('el saldo lo deja pagado', saldo.estadoPago === 'pagado' && saldo.resta === 0);
t('la caja ya tiene los 14.000', calc.saldoCaja(await db.from('movimiento_caja').select()) === 14000);

await falla('cobrado no se vuelve a cobrar',
  () => ped.registrarCobro(pedido.id, { monto: 1, medio: 'efectivo' }));

/* ================================================================== */
console.log('\n── rentabilidad vs caja (regla 5)');

const cierre = calc.cierreSemanal({
  pedidos: await db.from('pedido').select(),
  items: await db.from('pedido_item').select(),
  jornadas: [], gastos: [],
});
t('las ventas solo cuentan lo entregado', cierre.ventas === 14000);
t('el pedido en producción no suma a la ganancia', cierre.ventas !== 14000 + 30 * 3500);
t('costo de mercadería con snapshots', cierre.costoMercaderia === 10 * 350 + 2 * 1200);
t('margen bruto', cierre.margenBruto === 14000 - 5900);

/* ================================================================== */
console.log('\n── anular');

const anulado = await ped.anularPedido(pedido.id, 'El club canceló el evento');
t('devuelve el stock', anulado.stockDevuelto === 12);
t('devuelve la plata cobrada', anulado.devuelto === 14000);

await state.cargar();
t('las empanadas volvieron al stock', state.productoPorId(carne.id).stock_actual === 50);
t('las tartas volvieron al stock', state.productoPorId(tarta.id).stock_actual === 8);

const movsFinal = await db.from('movimiento_caja').select();
t('la caja queda en cero por la devolución', calc.saldoCaja(movsFinal) === 0);
t('los cobros NO se borran: quedan en el historial',
  (await db.from('cobro').select().eq('pedido_id', pedido.id)).length === 2);

const cierreFinal = calc.cierreSemanal({
  pedidos: await db.from('pedido').select(),
  items: await db.from('pedido_item').select(),
  jornadas: [], gastos: [],
});
t('el pedido anulado sale de la rentabilidad', cierreFinal.ventas === 0);

const anuladoRow = await db.from('pedido').select().eq('id', pedido.id).single();
t('el motivo queda escrito', /El club canceló el evento/.test(anuladoRow.notas || ''));

await falla('no se anula dos veces', () => ped.anularPedido(pedido.id, 'otra vez'));
await falla('anular exige motivo', () => ped.anularPedido(grande.pedido.id, '   '));

/* ================================================================== */
console.log('\n── agenda y alertas');

const enAgenda = await ped.pedidosDeSemana(ui.hoyISO(ui.inicioSemana()), ui.hoyISO(ui.finSemana()));
t('la agenda trae los pedidos de la semana', enAgenda.some((p) => p.id === grande.pedido.id));

const alertas = await ped.alertasPedidos();
t('avisa la entrega de hoy que no está lista',
  alertas.enRiesgo.some((p) => p.id === grande.pedido.id));
t('el anulado no aparece en riesgo',
  !alertas.enRiesgo.some((p) => p.id === pedido.id));

/* ================================================================== */
console.log('\n── clientes: campos derivados');

const resumenes = await ped.resumenClientes();
const rClub = resumenes.find((r) => r.cliente.id === club.id);
t('el pedido anulado no cuenta para el cliente', rClub.cantidad === 0);
t('ni para lo gastado', rClub.total === 0);

const rVecina = resumenes.find((r) => r.cliente.id === vecina.id);
t('el pedido abierto sí cuenta', rVecina.cantidad === 1);
t('todavía no debe nada: no se entregó', rVecina.impago === 0);

/* ================================================================== */
console.log('\n── venta rápida sigue funcionando');

const antesCarne = state.productoPorId(carne.id).stock_actual;
const venta = await ped.registrarVenta({
  lineas: [{ producto: state.productoPorId(carne.id), cantidad: 3 }],
  medio: 'efectivo',
});
t('la venta nace entregada y pagada',
  venta.pedido.estado === 'entregado' && venta.pedido.estado_pago === 'pagado');
t('queda marcada como mostrador', venta.pedido.es_mostrador === true);
await state.cargar();
t('descuenta el stock en el acto', state.productoPorId(carne.id).stock_actual === antesCarne - 3);

/* ================================================================== */
console.log('\n── permisos');

auth.rol = 'trabajadora';
t('la trabajadora puede cargar pedidos', auth.puede('cargarPedidos'));
t('la trabajadora puede cargar un cliente', auth.puede('gestionarClientes'));
t('la trabajadora NO puede anular', !auth.puede('anularPedidos'));
await falla('anular está cerrado por la función, no por la interfaz',
  () => ped.anularPedido(grande.pedido.id, 'me equivoqué'));
t('la trabajadora NO ve la tab de clientes', !auth.puedeVer('clientes'));

auth.rol = 'dirigente';
t('la comisión no carga pedidos', !auth.puede('cargarPedidos'));
await falla('la comisión no puede cobrar',
  () => ped.registrarCobro(grande.pedido.id, { monto: 100, medio: 'efectivo' }));
await falla('la comisión no puede entregar', () => ped.entregarPedido(grande.pedido.id));
await falla('la comisión no puede tocar clientes',
  () => ped.guardarCliente({ nombre: 'Colado' }));

auth.rol = 'admin';

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
