import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const ped          = await import('../js/modules/pedidos.js');
const calc         = await import('../js/calc.js');

let ok=0, mal=0;
const t=(n,c)=>{c?(ok++,console.log('  ✓',n)):(mal++,console.log('  ✗',n));};

await seed();
await state.cargar();
auth.entrarComo ? null : null;
auth.rol='admin';

const carne = state.productos.find(p=>p.nombre==='Empanada de carne');
const tarta = state.productos.find(p=>p.nombre==='Tarta de verdura');
const stockCarneAntes = carne.stock_actual;   // 50
const stockTartaAntes = tarta.stock_actual;   // 8

console.log('\n── venta rápida: transacción');

// Simulamos el carrito del módulo inyectándolo por la vía pública
// (registrarVenta lee el carrito interno, así que reproducimos la venta
//  llamando a la misma cadena que arma el módulo)
const lineas = [{p:carne, q:12},{p:tarta, q:2}];
const totalEsperado = 12*800 + 2*3500;   // 9600 + 7000 = 16600

// Llamamos a la función REAL del módulo
const { pedido } = await ped.registrarVenta({
  lineas: lineas.map(l => ({ producto: l.p, cantidad: l.q })),
  medio: 'efectivo',
});

t('el pedido nace entregado y pagado',
  pedido.estado==='entregado' && pedido.estado_pago==='pagado');
t('total correcto', pedido.total === 16600);
t('el total lo calcula la funcion, no el llamador', pedido.total === totalEsperado);

const items = await db.from('pedido_item').select().eq('pedido_id', pedido.id);
t('guarda 2 lineas', items.length===2);
t('congela precio_unitario', items.find(i=>i.producto_id===carne.id).precio_unitario===800);
t('congela costo_unitario', items.find(i=>i.producto_id===carne.id).costo_unitario===350);

const cobros = await db.from('cobro').select().eq('pedido_id', pedido.id);
t('registra el cobro', cobros.length===1 && cobros[0].monto===16600);

const movs = await db.from('movimiento_caja').select();
t('genera UN movimiento de caja automatico', movs.length===1);
t('el movimiento es ingreso y apunta al cobro',
  movs[0].tipo==='ingreso' && movs[0].origen==='cobro' && movs[0].referencia_id===cobros[0].id);

await state.cargar();
t('descuenta stock de empanadas',
  state.productoPorId(carne.id).stock_actual === stockCarneAntes-12);
t('descuenta stock de tartas',
  state.productoPorId(tarta.id).stock_actual === stockTartaAntes-2);

const ms = await db.from('movimiento_stock_producto').select();
t('deja rastro de stock por cada producto', ms.length===2);
t('el movimiento de stock es negativo', ms.every(m=>m.cantidad<0 && m.tipo==='venta'));

console.log('\n── el cierre semanal ve esta venta');
const pedidosSem = await db.from('pedido').select();
const itemsSem   = await db.from('pedido_item').select();
const c = calc.cierreSemanal({pedidos:pedidosSem, items:itemsSem, jornadas:[], gastos:[]});
t('ventas = 16.600', c.ventas===16600);
t('costo mercaderia = 12*350 + 2*1200', c.costoMercaderia===12*350+2*1200);
t('margen bruto', c.margenBruto===16600-(4200+2400));
t('caja percibida coincide', calc.saldoCaja(movs)===16600);

console.log('\n── permisos en la venta');
auth.rol='trabajadora';
t('la trabajadora puede entrar a pedidos', auth.puedeVer('pedidos'));
t('la trabajadora NO ve la caja', !auth.puedeVer('caja'));
t('la trabajadora NO ve costos', !auth.puede('verCostos'));

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal?1:0);
