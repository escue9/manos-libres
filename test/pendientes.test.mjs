/**
 * Lo pendiente de entrega, para exportar: por cliente y por producto.
 *
 * Lo que importa es que entre solo lo que falta entregar (ni lo entregado, ni
 * lo anulado, ni la venta de mostrador), que lo que falta cobrar descuente la
 * seña, y que los totales por producto sumen los de todos los clientes.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { seed }  = await import('../js/db.js');
const { state } = await import('../js/state.js');
const { auth }  = await import('../js/auth.js');
const ped       = await import('../js/modules/pedidos.js');

let ok = 0, mal = 0;
const t = (n, c) => { c ? (ok++, console.log('  ✓', n)) : (mal++, console.log('  ✗', n)); };

await seed();
await state.cargar();
auth.rol = 'admin';

const producto = (n) => state.productos.find((p) => p.nombre === n);
const carne = producto('Empanada de carne');
const tarta = producto('Tarta de carne');

console.log('\n── sin pedidos no hay nada pendiente');
let r = await ped.pendientesDeEntrega();
t('vacío', !r.pedidos.length && !r.productos.length && r.total === 0);

console.log('\n── dos clientes, un entregado, un anulado y una venta de mostrador');
const wenci = await ped.crearPedido({
  cliente: { nombre: 'Wenci' }, fechaEntrega: '2026-10-14',
  items: [{ producto_id: carne.id, cantidad: 12 }, { producto_id: tarta.id, cantidad: 1 }],
});
const santi = await ped.crearPedido({
  cliente: { nombre: 'Santi' }, fechaEntrega: '2026-10-13',
  items: [{ producto_id: carne.id, cantidad: 6 }],
});
const entregado = await ped.crearPedido({
  cliente: { nombre: 'Club' }, fechaEntrega: '2026-10-13',
  items: [{ producto_id: tarta.id, cantidad: 1 }],
});
await ped.entregarPedido(entregado.pedido.id);
const anulado = await ped.crearPedido({
  cliente: { nombre: 'Escuela' }, fechaEntrega: '2026-10-13',
  items: [{ producto_id: carne.id, cantidad: 24 }],
});
await ped.anularPedido(anulado.pedido.id, 'Lo dieron de baja');
await ped.registrarVenta({ lineas: [{ producto: carne, cantidad: 2 }], medio: 'efectivo' });
await ped.registrarCobro(wenci.pedido.id, { monto: 1000, medio: 'efectivo' });

r = await ped.pendientesDeEntrega();
t('entran solo los dos abiertos', r.pedidos.length === 2);
t('ordenados por fecha de entrega: Santi (13) antes que Wenci (14)',
  r.pedidos[0].nombreCliente === 'Santi' && r.pedidos[1].nombreCliente === 'Wenci');

const deWenci = r.pedidos[1];
t('Wenci lleva dos productos', deWenci.lineas.length === 2);
t('lo que falta cobrar descuenta la seña', Math.abs(deWenci.resta - (wenci.pedido.total - 1000)) < 1e-6);
t('el total y lo que falta cobrar suman los dos pedidos',
  Math.abs(r.total - (wenci.pedido.total + santi.pedido.total)) < 1e-6
  && Math.abs(r.aCobrar - (wenci.pedido.total - 1000 + santi.pedido.total)) < 1e-6);

const empanadas = r.productos.find((x) => x.producto_id === carne.id);
t('empanadas de carne: 18 entre los dos, sin las anuladas ni las de mostrador', empanadas?.total === 18);
t('con el detalle por cliente',
  empanadas.porCliente.length === 2
  && empanadas.porCliente.some((c) => c.nombre === 'Wenci' && c.cantidad === 12)
  && empanadas.porCliente.some((c) => c.nombre === 'Santi' && c.cantidad === 6));
t('la tarta entregada no suma: queda solo la de Wenci',
  r.productos.find((x) => x.producto_id === tarta.id)?.total === 1);

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
