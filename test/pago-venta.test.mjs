/**
 * Pago por venta: el 20% de la ganancia bruta para quien vende y entrega.
 *
 * Se congela al entregar y se cobra cuando paga el cliente: cada cobro genera
 * su parte. Lo que importa es que la plata no se duplique, que no cambie con
 * el pago por unidad de mañana (regla 4), que la caja y la rentabilidad lo vean
 * cada una a su tiempo (regla 5) y que nadie vea lo que cobró otra (regla 8).
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const { ui }       = await import('../js/ui.js');
const calc         = await import('../js/calc.js');
const ped          = await import('../js/modules/pedidos.js');
const prod         = await import('../js/modules/produccion.js');
const equipo       = await import('../js/modules/trabajadoras.js');

let ok = 0, mal = 0;
const t = (n, c) => { c ? (ok++, console.log('  ✓', n)) : (mal++, console.log('  ✗', n)); };
const cerca = (a, b) => Math.abs(a - b) < 0.005;

await seed();
await state.cargar();
auth.rol = 'admin';
auth.trabajadoraId = null;

const ana = state.trabajadoras.find((x) => x.nombre === 'Ana');
const maria = state.trabajadoras.find((x) => x.nombre === 'María');
const carne = state.productos.find((p) => p.nombre === 'Empanada de carne');   // $800, hay 50
const tarta = state.productos.find((p) => p.nombre === 'Tarta de verdura');    // $3500, hay 8

const pagosDe = async (pedidoId) => db.from('pago_venta').select().eq('pedido_id', pedidoId);
const suma = (xs) => xs.reduce((a, x) => a + (x.monto || 0), 0);
const hoy = ui.hoyISO();

console.log('\n── cuánto se paga por unidad vendida');
await prod.fijarPagoVenta(carne.id, 90);
await prod.fijarPagoVenta(tarta.id, 400);
t('queda en el producto', (await db.from('producto').select().eq('id', carne.id).single()).pago_venta === 90);
let fallo = null;
try { await prod.fijarPagoVenta(carne.id, -5); } catch (e) { fallo = e; }
t('un pago negativo no pasa', !!fallo);
t('la sugerencia es el 20% de la ganancia bruta',
  prod.pagoVentaSugerido({ precio_venta: 1500, costo_manual: 873 }) === Math.round((1500 - 873) * 0.2));
await state.cargar();

console.log('\n── un pedido entregado congela lo que le toca a quien vendió');
const { pedido: p1 } = await ped.crearPedido({
  cliente: { nombre: 'Nueve90' }, fechaEntrega: hoy,
  items: [{ producto_id: carne.id, cantidad: 24 }, { producto_id: tarta.id, cantidad: 2 }],
});
t('al cargarlo no hay vendedor ni pago', !p1.vendido_por && !(await pagosDe(p1.id)).length);

await ped.entregarPedido(p1.id, { vendidoPor: ana.id });
let e1 = await db.from('pedido').select().eq('id', p1.id).single();
t('queda Ana como vendedora', e1.vendido_por === ana.id);
t('se congela 24 × 90 + 2 × 400', e1.pago_venta_total === 24 * 90 + 2 * 400);
t('entregado e impago no genera pago: se cobra cuando paga el cliente', !(await pagosDe(p1.id)).length);

await prod.fijarPagoVenta(carne.id, 500);
t('subir el pago por unidad no toca lo ya entregado (regla 4)',
  (await db.from('pedido').select().eq('id', p1.id).single()).pago_venta_total === 24 * 90 + 2 * 400);
await prod.fijarPagoVenta(carne.id, 90);
await state.cargar();

console.log('\n── cada cobro genera su parte');
// total 24×800 + 2×3500 = 26.200; a Ana le tocan 2.960
await ped.registrarCobro(p1.id, { monto: 10000, medio: 'efectivo' });
let pv = await pagosDe(p1.id);
t('una seña genera la parte proporcional', pv.length === 1 && cerca(pv[0].monto, 2960 * 10000 / 26200));
t('a nombre de quien vendió, pendiente', pv[0].trabajadora_id === ana.id && pv[0].estado_pago === 'pendiente');

await ped.registrarCobro(p1.id, { monto: 16200, medio: 'transferencia' });
pv = await pagosDe(p1.id);
t('el saldo genera el resto', pv.length === 2);
t('entre los dos dan exacto lo congelado, sin centavos colgados', cerca(suma(pv), 2960));

await ped.generarPagosVenta(p1.id);
t('llamarlo de nuevo no duplica', (await pagosDe(p1.id)).length === 2);

console.log('\n── una seña antes de entregar');
const { pedido: p2 } = await ped.crearPedido({
  cliente: { nombre: 'Club' }, fechaEntrega: hoy,
  items: [{ producto_id: carne.id, cantidad: 12 }],
});
await ped.registrarCobro(p2.id, { monto: 4800, medio: 'efectivo' });
t('sin entregar no hay pago todavía', !(await pagosDe(p2.id)).length);
await ped.entregarPedido(p2.id, { vendidoPor: maria.id });
pv = await pagosDe(p2.id);
t('al entregar aparece lo de la seña', pv.length === 1 && cerca(pv[0].monto, 12 * 90 * 4800 / 9600));

console.log('\n── venta rápida: se entrega y se cobra en el acto');
auth.rol = 'trabajadora';
auth.trabajadoraId = maria.id;
const { pedido: vr } = await ped.registrarVenta({
  lineas: [{ producto: state.productoPorId(carne.id), cantidad: 6 }], medio: 'efectivo',
});
pv = await pagosDe(vr.id);
t('quien la cargó ya tiene su parte', pv.length === 1 && pv[0].trabajadora_id === maria.id && pv[0].monto === 6 * 90);
auth.rol = 'admin';
auth.trabajadoraId = null;

console.log('\n── la administración asigna o cambia el vendedor');
const { pedido: p3 } = await ped.crearPedido({
  cliente: { nombre: 'Agustina' }, fechaEntrega: hoy,
  items: [{ producto_id: tarta.id, cantidad: 1 }],
});
await ped.entregarPedido(p3.id, { vendidoPor: null });
await ped.registrarCobro(p3.id, { monto: 3500, medio: 'efectivo' });
t('sin vendedor, el cobro no genera pago', !(await pagosDe(p3.id)).length);
await ped.asignarVendedor(p3.id, ana.id);
pv = await pagosDe(p3.id);
t('al asignarlo se genera lo ya cobrado', pv.length === 1 && pv[0].trabajadora_id === ana.id && pv[0].monto === 400);
await ped.asignarVendedor(p3.id, maria.id);
pv = await pagosDe(p3.id);
t('cambiar de vendedor mueve lo pendiente, sin duplicar', pv.length === 1 && pv[0].trabajadora_id === maria.id);

// Lo de antes del pago por venta: pedido entregado sin monto congelado
const { pedido: viejo } = await ped.crearPedido({
  cliente: { nombre: 'Coka' }, fechaEntrega: hoy,
  items: [{ producto_id: carne.id, cantidad: 10 }],
});
await ped.entregarPedido(viejo.id, { vendidoPor: null });
await db.from('pedido').update({ pago_venta_total: null }).eq('id', viejo.id);
await ped.registrarCobro(viejo.id, { monto: 8000, medio: 'efectivo' });
await ped.asignarVendedor(viejo.id, ana.id);
t('un pedido viejo se congela al asignarlo, con el pago de hoy',
  (await db.from('pedido').select().eq('id', viejo.id).single()).pago_venta_total === 900
  && suma(await pagosDe(viejo.id)) === 900);

console.log('\n── anular saca lo pendiente');
const { pedido: p4 } = await ped.crearPedido({
  cliente: { nombre: 'Escuela' }, fechaEntrega: hoy,
  items: [{ producto_id: carne.id, cantidad: 5 }],
});
await ped.entregarPedido(p4.id, { vendidoPor: ana.id });
await ped.registrarCobro(p4.id, { monto: 4000, medio: 'efectivo' });
t('antes de anular hay pago', (await pagosDe(p4.id)).length === 1);
await ped.anularPedido(p4.id, 'Se cargó mal');
t('anulado, el pago pendiente se va', !(await pagosDe(p4.id)).length);

console.log('\n── la rentabilidad lo resta al entregar (devengado)');
const pedidos = await db.from('pedido').select();
const items = await db.from('pedido_item').select();
const c = calc.cierreSemanal({ pedidos, items });
const esperado = pedidos.filter((x) => x.estado === 'entregado' && x.vendido_por)
  .reduce((a, x) => a + (x.pago_venta_total || 0), 0);
t('el cierre suma lo congelado de los entregados con vendedor', cerca(c.pagoVenta, esperado) && c.pagoVenta > 0);
t('y lo resta de la ganancia neta', cerca(c.gananciaNeta, c.margenBruto - c.pagoVenta - c.costoLaboral - c.gastosOperativos));

console.log('\n── la liquidación lo paga y la caja lo registra (percibido)');
const resumenAdmin = await equipo.resumenSemana(hoy, hoy);
const filaAna = resumenAdmin.filas.find((f) => f.trabajadora.id === ana.id);
const ventasAna = suma((await db.from('pago_venta').select()).filter((v) => v.trabajadora_id === ana.id));
t('el resumen muestra lo que Ana cobró por vender', cerca(filaAna.porVentas, ventasAna));

auth.rol = 'trabajadora';
auth.trabajadoraId = maria.id;
const resumenMaria = await equipo.resumenSemana(hoy, hoy);
t('María ve solo lo suyo (regla 8)',
  resumenMaria.filas.length === 1 && resumenMaria.filas[0].trabajadora.id === maria.id);
const detalleAjeno = await ped.detallePedido(p1.id);
t('en el detalle de un pedido ajeno no ve lo que cobró Ana', detalleAjeno.pagosVenta.length === 0);
auth.rol = 'admin';
auth.trabajadoraId = null;

const cajaAntes = (await db.from('movimiento_caja').select()).length;
const r = await equipo.liquidarSemana(hoy, hoy);
const todos = await db.from('pago_venta').select();
t('lo liquidado incluye las ventas', cerca(r.porVentas, suma(todos)));
t('quedan pagadas', todos.every((v) => v.estado_pago === 'pagada' && v.fecha_pago === hoy));
const movs = await db.from('movimiento_caja').select();
const egreso = movs.find((m) => m.origen === 'jornal' && m.fecha === hoy);
t('un solo egreso en caja, que las suma', movs.length === cajaAntes + 1 && cerca(egreso.monto, r.total));

const liqs = await equipo.liquidacionesPagadas({ trabajadoraId: ana.id });
t('el comprobante de Ana trae lo de las ventas',
  liqs.length === 1 && cerca(liqs[0].porVentas, ventasAna)
  && equipo.textoComprobante(liqs[0]).includes('Por la venta y entrega'));

console.log('\n── un cobro de un pedido ya liquidado');
const { pedido: p5 } = await ped.crearPedido({
  cliente: { nombre: 'Nueve90' }, fechaEntrega: hoy,
  items: [{ producto_id: carne.id, cantidad: 10 }],
});
await ped.entregarPedido(p5.id, { vendidoPor: ana.id });
await ped.registrarCobro(p5.id, { monto: 3000, medio: 'efectivo' });
await equipo.liquidarSemana(hoy, hoy);
await ped.asignarVendedor(p5.id, maria.id);
pv = await pagosDe(p5.id);
t('lo ya pagado no se mueve aunque cambie el vendedor', pv.length === 1 && pv[0].trabajadora_id === ana.id);
await ped.registrarCobro(p5.id, { monto: 5000, medio: 'efectivo' });
pv = await pagosDe(p5.id);
t('el saldo va a la persona nueva y completa exacto lo congelado',
  pv.length === 2 && pv.find((x) => x.estado_pago === 'pendiente').trabajadora_id === maria.id && cerca(suma(pv), 900));

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
