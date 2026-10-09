import "fake-indexeddb/auto";   // npm install fake-indexeddb
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const calc         = await import('../js/calc.js');
const prod         = await import('../js/modules/produccion.js');

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };
const cerca = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const tira = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

await seed();
await state.cargar();
auth.rol = 'admin';

const contar = async (tabla) => (await db.from(tabla).select()).length;
const porNombre = async (tabla, nombre) => (await db.from(tabla).select()).find((x) => x.nombre === nombre);

/** Cuántas filas hay en las tablas que una carga podría tocar. */
const foto = async () => Object.fromEntries(await Promise.all(
  ['insumo', 'compra_insumo', 'movimiento_caja', 'movimiento_stock_insumo', 'movimiento_stock_producto',
    'receta_item', 'orden_produccion'].map(async (tb) => [tb, await contar(tb)]),
));
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ================================================================== */
console.log('\n── costo ponderado al volver de un receso');

t('con stock previo cero, el costo es el de la compra', calc.costoPonderado(0, 9500, 4, 10000) === 10000);
t('con stock previo negativo, también', calc.costoPonderado(-3, 9500, 4, 10000) === 10000);

const mapaL = new Map([['c', { costo_unitario: 10000, unidad_medida: 'kg' }]]);
const loteC = [{ insumo_id: 'c', cantidad: 500, unidad_medida: 'g', merma_pct: 10 }];
t('costoLote: 550 g con merma a $10.000/kg', calc.costoLote(loteC, mapaL) === 5500);
t('costoProducto = costoLote / rinde', calc.costoProducto(loteC, mapaL, 10) === 550);
t('margenPct', calc.margenPct(800, 600) === 25);

/* ================================================================== */
console.log('\n── alta de insumo');

const tapas = await prod.crearInsumo({ nombre: 'Tapas de prueba', categoria: 'Almacén', unidad_medida: 'unidad', stock_minimo: 24 });
t('nace con stock cero', tapas.stock_actual === 0);
t('nace con costo cero: lo pone la primera compra', tapas.costo_unitario === 0);
t('queda en la unidad de negocio', tapas.unidad_negocio_id === state.unidadNegocio.id);

let err = await tira(() => prod.crearInsumo({ nombre: '  tapas DE prueba ', unidad_medida: 'unidad' }));
t('no duplica un nombre aunque cambien mayúsculas y espacios', /Ya hay/.test(err?.message));
err = await tira(() => prod.crearInsumo({ nombre: 'Algo', unidad_medida: 'kilos' }));
t('rechaza una unidad que no existe', /Unidad desconocida/.test(err?.message));
err = await tira(() => prod.crearInsumo({ nombre: ' ', unidad_medida: 'kg' }));
t('rechaza el nombre vacío', !!err);

auth.rol = 'trabajadora';
err = await tira(() => prod.crearInsumo({ nombre: 'Otro', unidad_medida: 'kg' }));
t('la trabajadora no da de alta insumos', /Sin permiso/.test(err?.message));
auth.rol = 'admin';

/* ================================================================== */
console.log('\n── ajustarStock con la forma del importador');

const tartaV = await porNombre('producto', 'Tarta de verdura');
const delta = await prod.ajustarStock({ tabla: 'producto', id: tartaV.id, cantidad_nueva: 5, motivo: 'Conteo' });
t('devuelve la diferencia', delta === 5 - tartaV.stock_actual);
err = await tira(() => prod.ajustarStock({ tabla: 'pedido', id: tartaV.id, cantidad_nueva: 0, motivo: 'x' }));
t('solo insumo o producto', /insumo o producto/.test(err?.message));
err = await tira(() => prod.ajustarStock({ tabla: 'producto', id: tartaV.id, cantidad_nueva: 0, motivo: '' }));
t('sin motivo no ajusta', /motivo/.test(err?.message));

/* ================================================================== */
console.log('\n── reinicio de stock');

const antesReinicio = await foto();
const cajaAntes = await contar('movimiento_caja');
const harinaAntes = await porNombre('insumo', 'Harina 000');

err = await tira(() => prod.reiniciarStock('  '));
t('sin motivo no reinicia', /motivo/.test(err?.message));
t('y no escribió nada', igual(await foto(), antesReinicio));

const conStockI = (await db.from('insumo').select()).filter((i) => i.stock_actual).length;
const conStockP = (await db.from('producto').select()).filter((p) => p.stock_actual).length;
const r = await prod.reiniciarStock('Vuelta del receso: conteo en cero');

t('cuenta los insumos ajustados', r.insumos === conStockI);
t('cuenta los productos ajustados', r.productos === conStockP);
t('todos los insumos en cero', (await db.from('insumo').select()).every((i) => i.stock_actual === 0));
t('todos los productos en cero', (await db.from('producto').select()).every((p) => p.stock_actual === 0));

const movH = (await db.from('movimiento_stock_insumo').select().eq('insumo_id', harinaAntes.id)).at(-1);
t('el ajuste guarda la diferencia, negativa', movH.tipo === 'ajuste' && movH.cantidad === -harinaAntes.stock_actual);
t('el ajuste guarda el motivo', movH.motivo === 'Vuelta del receso: conteo en cero');
t('no toca caja', await contar('movimiento_caja') === cajaAntes);
t('no toca el costo unitario', (await porNombre('insumo', 'Harina 000')).costo_unitario === harinaAntes.costo_unitario);

const otra = await prod.reiniciarStock('De nuevo');
t('lo que ya estaba en cero no genera movimiento', otra.insumos === 0 && otra.productos === 0);

const delReinicio = [
  ...await db.from('movimiento_stock_insumo').select().eq('referencia_id', r.referencia),
  ...await db.from('movimiento_stock_producto').select().eq('referencia_id', r.referencia),
];
t('todos los ajustes del reinicio comparten referencia', delReinicio.length === r.insumos + r.productos);

/* ================================================================== */
console.log('\n── cerrar una orden sin receta');

const combo = await porNombre('producto', 'Combo bondiola 6 porciones');   // costo_manual 0
let orden = await prod.crearOrden({ fecha: '2026-10-01', items: [{ producto_id: combo.id, cantidad: 3 }] });
err = await tira(() => prod.cerrarOrden(orden.id, {}, {}));
t('sin receta y sin costo manual no cierra', /Sin costo para congelar/.test(err?.message));
t('la orden vuelve a planificada', (await db.from('orden_produccion').select().eq('id', orden.id).single()).estado === 'planificada');
t('y el stock no se movió', (await porNombre('producto', combo.nombre)).stock_actual === 0);

t('crearOrden devuelve los requeridos vs disponibles', Array.isArray(orden.requerimientos) && Array.isArray(orden.faltantes));

const tarta = await porNombre('producto', 'Tarta de carne');               // costo_manual 1500
const movInsumoAntes = await contar('movimiento_stock_insumo');
orden = await prod.crearOrden({ fecha: '2026-10-01', items: [{ producto_id: tarta.id, cantidad: 4 }] });
await prod.cerrarOrden(orden.id, {}, {});
const itTarta = (await db.from('produccion_item').select().eq('orden_produccion_id', orden.id))[0];
t('con costo manual cierra y lo congela', itTarta.costo_unitario_snapshot === 1500);
t('suma el producto', (await porNombre('producto', tarta.nombre)).stock_actual === 4);
t('no descuenta insumos', await contar('movimiento_stock_insumo') === movInsumoAntes);

/* ================================================================== */
console.log('\n── cargarSemana: si algo está mal, no escribe nada');

const antes = await foto();

err = await tira(() => prod.cargarSemana({
  reinicio: { motivo: '' },
  insumos_nuevos: [{ nombre: 'Harina 000', unidad_medida: 'kg' }],
  compras: [
    { insumo: 'Harina 000', cantidad: 10, costo_total: 15000 },          // esta está bien
    { insumo: 'Harina 0000', cantidad: 10, costo_total: 15000 },
    { insumo: 'Aceite', cantidad: 2, unidad_medida: 'kg', costo_total: 5000 },
  ],
  recetas: [{ producto: 'Empanada de carne', rinde_por_lote: 24, items: [{ insumo: 'Carne picada', cantidad: 1, unidad_medida: 'l' }] }],
  producciones: [{ fecha: '06/10/2026', items: [{ producto: 'Empanada de pollo', cantidad: 10 }] }],
}));
t('tira error', !!err);
t('junta todos los problemas, no solo el primero', err?.errores?.length === 6);
t('dice dónde está cada uno', err?.errores?.some((e) => e.startsWith('compras[1]')));
t('avisa el reinicio sin motivo', err?.errores?.some((e) => /reinicio: falta el motivo/.test(e)));
t('avisa el insumo duplicado', err?.errores?.some((e) => /ya existe un insumo "Harina 000"/.test(e)));
t('avisa las unidades que no se convierten', err?.errores?.some((e) => /compras\[2\].*No se puede convertir de kg a l/.test(e)));
t('no escribió nada, ni la compra que estaba bien', igual(await foto(), antes));

// Faltante: la tercera parte de la semana falla por lo que hicieron las dos primeras
const semanaCorta = {
  compras: [{ insumo: 'Carne picada', cantidad: 1, costo_total: 10000 }],
  recetas: [{ producto: 'Empanada de carne', rinde_por_lote: 24, items: [{ insumo: 'Carne picada', cantidad: 1, unidad_medida: 'kg' }] }],
  producciones: [{ fecha: '2026-10-06', items: [{ producto: 'Empanada de carne', cantidad: 48 }] }],
};
err = await tira(() => prod.cargarSemana(semanaCorta));
t('ve el faltante de la producción antes de escribir la compra', /falta stock de Carne picada \(hacen falta 2 kg, hay 1\)/.test(err?.message));
t('y no escribió nada', igual(await foto(), antes));

const conMotivo = await prod.cargarSemana(
  { ...semanaCorta, producciones: [{ ...semanaCorta.producciones[0], motivo_ajuste: 'Carne de donación sin cargar' }] },
  { soloValidar: true },
);
t('con motivo_ajuste pasa la validación', conMotivo.plan.producciones.length === 1);
t('soloValidar no escribe', igual(await foto(), antes));

err = await tira(() => prod.cargarSemana({
  producciones: [{ fecha: '2026-10-06', items: [{ producto: 'Combo bondiola 6 porciones', cantidad: 2 }] }],
}));
t('valida el costo de los productos sin receta', /no tiene receta ni costo manual/.test(err?.message));

err = await tira(() => prod.cargarSemana({
  recetas: [{ producto: 'Empanada de verdura', rinde_por_lote: 24, items: [{ insumo: 'Tapas de prueba', cantidad: 24 }] }],
  producciones: [{ fecha: '2026-10-06', items: [{ producto: 'Empanada de verdura', cantidad: 24 }] }],
}));
t('valida que los insumos de la receta tengan costo', /Sin costo cargado: Tapas de prueba/.test(err?.message));

auth.rol = 'trabajadora';
err = await tira(() => prod.cargarSemana({ compras: [] }));
t('la trabajadora no carga semanas', /Sin permiso/.test(err?.message));
auth.rol = 'admin';

/* ================================================================== */
console.log('\n── cargarSemana: la semana de vuelta del receso');

const cajaSemana = await contar('movimiento_caja');

const res = await prod.cargarSemana({
  reinicio: { motivo: 'Vuelta del receso' },
  insumos_nuevos: [{ nombre: 'Tapas de empanada', categoria: 'Almacén', unidad_medida: 'unidad', stock_minimo: 48 }],
  compras: [
    { insumo: 'Harina 000',        cantidad: 10,   costo_total: 15000, proveedor: 'Molino', fecha: '2026-10-05' },
    { insumo: 'Carne picada',      cantidad: 4000, unidad_medida: 'g', costo_total: 40000, proveedor: 'Carnicería', fecha: '2026-10-05' },
    { insumo: 'cebolla',           cantidad: 2,    costo_total: 2000,  fecha: '2026-10-05' },
    { insumo: 'Tapas de empanada', cantidad: 48,   costo_total: 9600,  fecha: '2026-10-05', medio: 'transferencia' },
  ],
  recetas: [{
    producto: 'Empanada de carne', rinde_por_lote: 24,
    items: [
      { insumo: 'Carne picada',      cantidad: 1000, unidad_medida: 'g', merma_pct: 10 },
      { insumo: 'Cebolla',           cantidad: 500,  unidad_medida: 'g' },
      { insumo: 'Tapas de empanada', cantidad: 24,   unidad_medida: 'unidad' },
    ],
  }],
  producciones: [
    { fecha: '2026-10-06', notas: 'Primera jornada de Rocío', items: [{ producto: 'Empanada de carne', cantidad: 48 }] },
    { fecha: '2026-10-07', items: [{ producto: 'Tarta de verdura', cantidad: 4 }] },
  ],
});

const ins = async (n) => porNombre('insumo', n);
const pr = async (n) => porNombre('producto', n);

t('crea el insumo nuevo', (await ins('Tapas de empanada'))?.unidad_medida === 'unidad');
t('el costo de la compra reemplaza al viejo, porque el stock estaba en cero', (await ins('Harina 000')).costo_unitario === 1500);
t('convierte los gramos de la compra a la unidad del insumo', (await ins('Carne picada')).costo_unitario === 10000);
t('encuentra el insumo aunque esté en minúscula', (await ins('Cebolla')).costo_unitario === 1000);

t('harina: lo comprado, sin consumo', (await ins('Harina 000')).stock_actual === 10);
t('carne: 4 kg menos 2 lotes de 1,1 kg', cerca((await ins('Carne picada')).stock_actual, 1.8, 1e-9));
t('cebolla: 2 kg menos 1 kg', cerca((await ins('Cebolla')).stock_actual, 1, 1e-9));
t('tapas: 48 menos 48', cerca((await ins('Tapas de empanada')).stock_actual, 0, 1e-9));
t('un insumo que no se compró queda en cero', (await ins('Acelga')).stock_actual === 0);

t('empanadas: cero del reinicio más 48', (await pr('Empanada de carne')).stock_actual === 48);
t('tartas: cero del reinicio más 4', (await pr('Tarta de verdura')).stock_actual === 4);
t('lo que no se produjo queda en cero', (await pr('Empanada de verdura')).stock_actual === 0);

// (1,1 kg × $10.000 + 0,5 kg × $1.000 + 24 × $200) ÷ 24
const costoEmp = (11000 + 500 + 4800) / 24;
t('la receta queda costeada con las compras de la semana', cerca((await pr('Empanada de carne')).costo_calculado, costoEmp));

const ordenes = await db.from('orden_produccion').select();
const oEmp = ordenes.find((o) => o.id === res.ordenes[0].id);
const oTarta = ordenes.find((o) => o.id === res.ordenes[1].id);
t('dos órdenes cerradas', oEmp.estado === 'cerrada' && oTarta.estado === 'cerrada');
t('con su fecha y sus notas', oEmp.fecha === '2026-10-06' && oEmp.notas === 'Primera jornada de Rocío');
t('el costo de insumos de la orden es el de dos lotes', cerca(oEmp.costo_insumos, costoEmp * 48));

const snapEmp = (await db.from('produccion_item').select().eq('orden_produccion_id', oEmp.id))[0];
const snapTarta = (await db.from('produccion_item').select().eq('orden_produccion_id', oTarta.id))[0];
t('congela el costo de la receta', cerca(snapEmp.costo_unitario_snapshot, costoEmp));
t('el producto sin receta congela su costo manual', snapTarta.costo_unitario_snapshot === 1200);

const caja = (await db.from('movimiento_caja').select()).slice(cajaSemana);
t('un egreso automático por compra, y nada más', caja.length === 4
  && caja.every((m) => m.tipo === 'egreso' && m.origen === 'compra_insumo'));
t('el egreso suma lo pagado', caja.reduce((a, m) => a + m.monto, 0) === 66600);
t('respeta el medio de pago', caja.some((m) => m.medio === 'transferencia' && m.monto === 9600));
t('la compra queda con la fecha de la compra', (await db.from('compra_insumo').select()).at(-1).fecha === '2026-10-05');

t('el resumen cuenta lo que hizo', res.compras.length === 4 && res.recetas.length === 1
  && res.ordenes.length === 2 && res.insumos[0] === 'Tapas de empanada');
t('avisa el margen bajo: 85% del precio se va en insumos',
  res.alertas.some((a) => a.producto === 'Empanada de carne' && a.margenPct < calc.MARGEN_MINIMO));
const alerta = res.alertas.find((a) => a.producto === 'Empanada de carne');
t('la alerta trae el texto del PDR', alerta?.texto === `Empanada de carne bajó a ${alerta.margenPct.toFixed(1)}% de margen.`);
t('el resumen trae los egresos generados', res.egresos.length === 4 && res.totalEgresos === 66600);
t('el resumen trae el stock final de cada insumo',
  cerca(res.stock.insumos.find((i) => i.nombre === 'Carne picada').stock, 1.8, 1e-9));
t('y de cada producto', res.stock.productos.find((p) => p.nombre === 'Empanada de carne').stock === 48);

// La alerta de compra lleva adelante qué insumo subió
const compraCara = await prod.registrarCompra({ insumoId: (await ins('Carne picada')).id, cantidad: 1, costoTotal: 30000 });
t('la compra que sube el costo lo dice', compraCara.alertas.some((a) =>
  a.texto?.startsWith('Subió el costo de carne picada. Empanada de carne bajó a')));

t('state queda al día para la pantalla', state.insumos.some((i) => i.nombre === 'Tapas de empanada'));

/* ================================================================== */
console.log(`\n${ok} bien · ${mal} mal\n`);
process.exit(mal ? 1 : 0);
