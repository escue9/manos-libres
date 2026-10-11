/**
 * La lista de compras: lo que falta comprar para cumplir los pedidos abiertos.
 *
 * Se calcula al vuelo desde los pedidos, las recetas y el stock. Lo que importa
 * es que cuente solo lo que falta (no lo que ya hay), que se mueva sola cuando
 * cambian los pedidos y que no esconda los productos sin receta.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const ped          = await import('../js/modules/pedidos.js');
const prod         = await import('../js/modules/produccion.js');

let ok = 0, mal = 0;
const t = (n, c) => { c ? (ok++, console.log('  ✓', n)) : (mal++, console.log('  ✗', n)); };

await seed();
await state.cargar();
auth.rol = 'admin';

const producto = (n) => state.productos.find((p) => p.nombre === n);
const insumo = (n) => state.insumos.find((i) => i.nombre === n);

const tarta = producto('Tarta de carne');        // hay 4
const combo = producto('Combo bondiola 6 porciones');   // hay 0 y no tiene receta
const carne = insumo('Carne picada');            // hay 8 kg
const harina = insumo('Harina 000');             // hay 25 kg

// Una tarta: 1 kg de carne y 0,5 kg de harina por lote de 4
await prod.guardarReceta(tarta.id, [
  { insumo_id: carne.id, cantidad: 1, unidad_medida: 'kg' },
  { insumo_id: harina.id, cantidad: 500, unidad_medida: 'g' },
], 4);

console.log('\n── sin pedidos no hay nada que comprar');
let lista = await prod.listaDeCompras();
t('la lista está vacía', !lista.items.length && !lista.productos.length);

console.log('\n── un pedido que el stock de producto cubre');
await ped.crearPedido({
  cliente: { nombre: 'Club' }, fechaEntrega: '2026-10-13',
  items: [{ producto_id: tarta.id, cantidad: 4 }],
});
lista = await prod.listaDeCompras();
t('con las 4 tartas hechas no hay que producir ni comprar', !lista.productos.length && !lista.items.length);

console.log('\n── un pedido que no alcanza');
// 4 + 40 = 44 tartas pedidas, hay 4: faltan 40 = 10 lotes = 10 kg de carne y 5 kg de harina
const grande = await ped.crearPedido({
  cliente: { nombre: 'Escuela' }, fechaEntrega: '2026-10-14',
  items: [{ producto_id: tarta.id, cantidad: 40 }],
});
t('crearPedido avisa que falta', grande.faltantes.length === 1);
lista = await prod.listaDeCompras();
const deCarne = lista.items.find((i) => i.insumo.id === carne.id);
t('falta producir 40 tartas', lista.productos.length === 1 && lista.productos[0].falta === 40);
t('se compra solo lo que no hay: 10 kg pedidos, 8 en stock, comprar 2',
  Math.abs(deCarne?.comprar - 2) < 1e-9 && Math.abs(deCarne.requerido - 10) < 1e-9);
t('la harina alcanza (5 kg de 25) y no entra en la lista',
  !lista.items.some((i) => i.insumo.id === harina.id));
t('el texto para WhatsApp nombra el insumo y la cantidad',
  prod.textoListaDeCompras(lista).includes('Carne picada: 2 kg'));

console.log('\n── un producto sin receta no se esconde');
await ped.crearPedido({
  cliente: { nombre: 'Escuela' }, fechaEntrega: '2026-10-14',
  items: [{ producto_id: combo.id, cantidad: 2 }],
});
lista = await prod.listaDeCompras();
t('figura como sin receta', lista.sinReceta.some((p) => p.id === combo.id));
t('y la carne de las tartas sigue en la lista', lista.items.some((i) => i.insumo.id === carne.id));

console.log('\n── la lista se mueve sola con los pedidos');
await ped.anularPedido(grande.pedido.id, 'Lo dieron de baja');
lista = await prod.listaDeCompras();
t('anulado el pedido grande, la carne sale de la lista',
  !lista.items.some((i) => i.insumo.id === carne.id));
t('el pedido chico, que el stock cubre, no la vuelve a meter',
  !lista.productos.some((p) => p.producto.id === tarta.id));

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
