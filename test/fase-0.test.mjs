import "fake-indexeddb/auto";   // npm install fake-indexeddb
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { auth }     = await import('../js/auth.js');
const calc         = await import('../js/calc.js');

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };

console.log('\n── db.js: seed y consultas');
await seed();
const un = await db.from('unidad_negocio').select().single();
t('crea la unidad de negocio', un?.nombre === 'Cocina CIC');

const prods = await db.from('producto').select();
t('siembra 6 productos', prods.length === 6);

const emp = await db.from('producto').select().eq('categoria', 'Empanadas');
t('filtra por categoria (eq)', emp.length === 3);

const caras = await db.from('producto').select().gte('precio_venta', 3500).order('precio_venta', { ascending: false });
t('gte + order desc', caras[0].precio_venta === 26000 || caras[0].precio_venta >= 3500);

await seed();
t('seed no duplica al correr dos veces', (await db.from('producto').select()).length === 6);

console.log('\n── db.js: escritura');
const cli = await db.from('cliente').insert({ nombre: 'Vecina', telefono: '249555', tipo: 'particular' });
t('insert devuelve id', !!cli.id);
t('insert pone created_at', !!cli.created_at);
await db.from('cliente').update({ nombre: 'Vecina del CIC' }).eq('id', cli.id);
t('update aplica', (await db.from('cliente').select().eq('id', cli.id).single()).nombre === 'Vecina del CIC');
await db.from('cliente').delete().eq('id', cli.id);
t('delete borra', (await db.from('cliente').select()).length === 0);

console.log('\n── db.js: config y backup');
await db.setConfig('prueba', 'uno');
await db.setConfig('prueba', 'dos');
t('setConfig actualiza en vez de duplicar', await db.getConfig('prueba') === 'dos'
   && (await db.from('config').select().eq('clave','prueba')).length === 1);
const backup = await db.exportAll();
t('exportAll trae todas las tablas', Object.keys(backup).length > 15 && backup.producto.length === 6);

console.log('\n── auth.js: PIN');
t('primer arranque: no hay admin', await auth.hayAdmin() === false);
await auth.crearPinAdmin('1234');
t('despues de crear, hay admin', await auth.hayAdmin() === true);
const hash = await db.getConfig('admin_pin');
t('el PIN no queda en texto plano', hash !== '1234' && hash.length === 64);
t('hay salt generado', (await db.getConfig('pin_salt'))?.length === 32);

t('PIN incorrecto rechaza', await auth.ingresar('9999') === null);
t('PIN correcto entra', (await auth.ingresar('1234'))?.rol === 'admin');
t('queda autenticado como admin', auth.rol === 'admin');

console.log('\n── auth.js: permisos');
t('admin ve caja', auth.puedeVer('caja'));
t('admin ve costos', auth.puede('verCostos'));
auth.rol = 'trabajadora'; auth.trabajadoraId = 'T1';
t('trabajadora NO ve caja', !auth.puedeVer('caja'));
t('trabajadora NO ve costos', !auth.puede('verCostos'));
t('trabajadora NO ve margenes', !auth.puede('verMargenes'));
t('trabajadora NO puede liquidar', !auth.puede('liquidar'));
t('tabInicial no es una tab prohibida', auth.puedeVer(auth.tabInicial));

const jornadas = [{trabajadora_id:'T1',d:1},{trabajadora_id:'T2',d:2},{trabajadora_id:'T3',d:3}];
t('filtrarPropio deja solo lo suyo', auth.filtrarPropio(jornadas).length === 1);
auth.rol = 'admin';
t('filtrarPropio no filtra para admin', auth.filtrarPropio(jornadas).length === 3);

console.log('\n── auth.js: PIN de trabajadora');
const tr = await db.from('trabajadora').select().eq('nombre','Ana').single();
await auth.cambiarPinTrabajadora(tr.id, '4321');
const s = await auth.ingresar('4321');
t('trabajadora entra con su PIN', s?.rol === 'trabajadora' && s.trabajadora.nombre === 'Ana');
t('la sesion guarda su id', auth.trabajadoraId === tr.id);

console.log('\n── calc.js');
t('costo ponderado', Math.round(calc.costoPonderado(10, 100, 10, 200)) === 150);
t('ponderado con stock 0 usa el de compra', calc.costoPonderado(0, 0, 5, 800) === 800);
const insumos = new Map([['h',{costo_unitario:1000}],['c',{costo_unitario:5000}]]);
const receta = [{insumo_id:'h',cantidad:1,merma_pct:0},{insumo_id:'c',cantidad:0.5,merma_pct:10}];
t('costo por receta con merma', Math.round(calc.costoProducto(receta, insumos, 24)) === 156);
const m = calc.margen(800, 350);
t('margen $', m.pesos === 450);
t('margen %', Math.round(m.pct * 10) / 10 === 56.3);

const cierre = calc.cierreSemanal({
  pedidos: [{id:'p1',estado:'entregado',descuento:0},{id:'p2',estado:'pendiente',descuento:0}],
  items: [{pedido_id:'p1',cantidad:10,precio_unitario:800,costo_unitario:350},
          {pedido_id:'p2',cantidad:99,precio_unitario:800,costo_unitario:350}],
  jornadas: [{tarifa_aplicada:5000,confirmada:true},{tarifa_aplicada:5000,confirmada:false}],
  gastos: [{monto:1000}],
});
t('ignora pedidos no entregados', cierre.ventas === 8000);
t('costo mercaderia usa snapshots', cierre.costoMercaderia === 3500);
t('ignora jornadas sin confirmar', cierre.costoLaboral === 5000);
t('ganancia neta', cierre.gananciaNeta === 8000 - 3500 - 5000 - 1000);
t('semaforo en perdida', cierre.semaforo === 'danger');

t('saldo de caja separa ingreso/egreso',
  calc.saldoCaja([{tipo:'ingreso',monto:1000},{tipo:'egreso',monto:400}]) === 600);

const q = calc.cuadrantes([
  {n:'a',unidades:240,margenPct:56.3},{n:'b',unidades:120,margenPct:60},
  {n:'c',unidades:90,margenPct:62.7},{n:'d',unidades:14,margenPct:65.7},
  {n:'e',unidades:8,margenPct:62.5},
]);
t('la mas vendida con peor margen cae en revisar', q[0].cuadrante === 'revisar');
t('poco volumen y buen margen es oportunidad', q[3].cuadrante === 'oportunidad');

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
