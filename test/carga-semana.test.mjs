import "fake-indexeddb/auto";   // npm install fake-indexeddb
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const calc         = await import('../js/calc.js');
const prod         = await import('../js/modules/produccion.js');
const equipo       = await import('../js/modules/trabajadoras.js');
const pedidos      = await import('../js/modules/pedidos.js');

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
const ana = state.trabajadoras.find((x) => x.nombre === 'Ana');
await prod.fijarPagoProduccion(tarta.id, 0);      // cero a propósito: cierra y no paga
await prod.cerrarOrden(orden.id, {}, { productoras: ana.id });
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
  pagos: [{ producto: 'Empanada de carne', pago_produccion: 40 }],
  producciones: [{ fecha: '2026-10-06', trabajadora: 'Ana', items: [{ producto: 'Empanada de carne', cantidad: 48 }] }],
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
  pagos: [{ producto: 'Combo bondiola 6 porciones', pago_produccion: 100 }],
  producciones: [{ fecha: '2026-10-06', trabajadora: 'Ana', items: [{ producto: 'Combo bondiola 6 porciones', cantidad: 2 }] }],
}));
t('valida el costo de los productos sin receta', /no tiene receta ni costo manual/.test(err?.message));

err = await tira(() => prod.cargarSemana({
  recetas: [{ producto: 'Empanada de verdura', rinde_por_lote: 24, items: [{ insumo: 'Tapas de prueba', cantidad: 24 }] }],
  pagos: [{ producto: 'Empanada de verdura', pago_produccion: 40 }],
  producciones: [{ fecha: '2026-10-06', trabajadora: 'Ana', items: [{ producto: 'Empanada de verdura', cantidad: 24 }] }],
}));
t('valida que los insumos de la receta tengan costo', /Sin costo cargado: Tapas de prueba/.test(err?.message));

auth.rol = 'trabajadora';
err = await tira(() => prod.cargarSemana({ compras: [] }));
t('la trabajadora no carga semanas', /Sin permiso/.test(err?.message));
auth.rol = 'admin';

/* ================================================================== */
console.log('\n── cargarSemana: la semana de vuelta del receso');

const cajaSemana = await contar('movimiento_caja');
const rocio = await equipo.guardarTrabajadora({ nombre: 'Rocío' });
await state.cargar();

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
  pagos: [
    { producto: 'Empanada de carne', pago_produccion: 40 },
    { producto: 'Tarta de verdura',  pago_produccion: 300 },
  ],
  producciones: [
    { fecha: '2026-10-06', notas: 'Primera jornada de Rocío', trabajadora: 'Rocío',
      items: [{ producto: 'Empanada de carne', cantidad: 48 }] },
    { fecha: '2026-10-07', items: [
      { producto: 'Tarta de verdura', cantidad: 3, trabajadora: 'Rocío' },
      { producto: 'Tarta de verdura', cantidad: 1, trabajadora: 'Ana' },
    ] },
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
t('congela el costo de la receta más lo que cobra quien la hace', cerca(snapEmp.costo_unitario_snapshot, costoEmp + 40));
t('el producto sin receta congela su costo manual más el pago', snapTarta.costo_unitario_snapshot === 1200 + 300);

/* --- lo que cobra cada una --- */
const pagosSemana = await db.from('pago_produccion').select().gte('fecha', '2026-10-06');
const deRocio = pagosSemana.filter((p) => p.trabajadora_id === rocio.id);
const deAna = pagosSemana.filter((p) => p.trabajadora_id === ana.id);
t('fija el pago por unidad de cada producto', (await pr('Empanada de carne')).pago_produccion === 40);
t('Rocío cobra sus 48 empanadas y sus 3 tartas',
  deRocio.length === 2 && deRocio.reduce((a, p) => a + p.total, 0) === 48 * 40 + 3 * 300);
t('Ana cobra la tarta que hizo ella', deAna.length === 1 && deAna[0].cantidad === 1 && deAna[0].total === 300);
t('la tarta se cargó en una sola línea con su reparto',
  (await db.from('produccion_item').select().eq('orden_produccion_id', oTarta.id)).length === 1);
t('cargado por la administración, entra confirmado', pagosSemana.every((p) => p.confirmada && p.estado_pago === 'pendiente'));
t('congela el monto por unidad', deRocio.every((p) => p.pago_unitario === (p.producto_id === snapEmp.producto_id ? 40 : 300)));
t('la mano de obra de la orden es lo que se paga', oEmp.costo_mano_obra === 48 * 40 && oTarta.costo_mano_obra === 4 * 300);
t('la carga no movió la caja por los pagos: eso pasa al liquidar',
  (await db.from('movimiento_caja').select()).slice(cajaSemana).every((m) => m.origen === 'compra_insumo'));

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

// La venta congela el costo con la paga adentro: el margen que se ve es el real
const empHoy = await pr('Empanada de carne');
const { pedido: venta } = await pedidos.registrarVenta({
  lineas: [{ producto: empHoy, cantidad: 2 }], medio: 'efectivo',
});
const [itemVenta] = await db.from('pedido_item').select().eq('pedido_id', venta.id);
t('la venta congela materiales más el pago por producción',
  cerca(itemVenta.costo_unitario, empHoy.costo_calculado + 40));

t('state queda al día para la pantalla', state.insumos.some((i) => i.nombre === 'Tapas de empanada'));

/** La foto de antes, más las tablas que tocan las secciones nuevas. */
const fotoTodo = async () => Object.fromEntries(await Promise.all(
  ['insumo', 'producto', 'compra_insumo', 'movimiento_caja', 'movimiento_stock_insumo',
    'movimiento_stock_producto', 'receta_item', 'orden_produccion', 'pago_produccion',
    'cliente', 'pedido', 'pedido_item', 'cobro'].map(async (tb) => [tb, await contar(tb)]),
));

/* ================================================================== */
console.log('\n── productos nuevos');

const rProd = await prod.cargarSemana({
  productos_nuevos: [{ nombre: 'Pizzeta de prueba', categoria: 'Pizzas', unidad_venta: 'unidad', precio_venta: 1500, stock_minimo: 0 }],
});
const pizzeta = await pr('Pizzeta de prueba');
t('crea el producto', rProd.productos[0] === 'Pizzeta de prueba' && pizzeta?.precio_venta === 1500);
t('nace con stock cero', pizzeta.stock_actual === 0);
t('sin costo propio: lo pone la receta', pizzeta.costo_manual == null && pizzeta.costo_calculado == null);
t('rinde 1 y sin pago definido', pizzeta.rinde_por_lote === 1 && pizzeta.pago_produccion == null);

err = await tira(() => prod.crearProducto({ nombre: ' pizzeta DE PRUEBA ', precio_venta: 100 }));
t('no duplica un nombre aunque cambien mayúsculas', /Ya hay un producto/.test(err?.message));
err = await tira(() => prod.crearProducto({ nombre: 'Sin precio' }));
t('sin precio no nace', /precio/.test(err?.message));
auth.rol = 'trabajadora';
err = await tira(() => prod.crearProducto({ nombre: 'Otro producto', precio_venta: 100 }));
t('la trabajadora no da de alta productos', /Sin permiso/.test(err?.message));
auth.rol = 'admin';

/* ================================================================== */
console.log('\n── precios');

const itemsAntes = JSON.stringify(await db.from('pedido_item').select());
const tartaAntes = await pr('Tarta de verdura');
const rPrecio = await prod.cargarSemana({ precios: [{ producto: 'tarta de verdura', precio_venta: 4000 }] });
t('cambia el precio', (await pr('Tarta de verdura')).precio_venta === 4000);
t('el resumen dice de cuánto a cuánto', rPrecio.precios[0].precioPrevio === tartaAntes.precio_venta && rPrecio.precios[0].precio === 4000);
t('no toca ningún snapshot de lo ya vendido (regla 4)', JSON.stringify(await db.from('pedido_item').select()) === itemsAntes);

const flojo = await prod.guardarPrecio(tartaAntes.id, 1600);
t('guardarPrecio avisa el margen bajo', flojo.alerta?.producto === 'Tarta de verdura' && flojo.margenPct < calc.MARGEN_MINIMO);
const sano = await prod.guardarPrecio(tartaAntes.id, 4000);
t('y no avisa cuando el margen está bien', sano.alerta === null);
err = await tira(() => prod.guardarPrecio(tartaAntes.id, -5));
t('un precio negativo no pasa', !!err);
auth.rol = 'trabajadora';
err = await tira(() => prod.guardarPrecio(tartaAntes.id, 10));
t('la trabajadora no cambia precios', /Sin permiso/.test(err?.message));
auth.rol = 'admin';

/* ================================================================== */
console.log('\n── stock inicial');

const salAntes = await ins('Sal fina');
const cajaSI = await contar('movimiento_caja');
const fotoSI = await fotoTodo();
err = await tira(() => prod.cargarSemana({ stock_inicial: [{ insumo: 'Sal fina', cantidad: 500, unidad_medida: 'g', costo_unitario: 2 }] }));
t('sin motivo no carga', /falta el motivo/.test(err?.message));
t('y no escribió nada', igual(await fotoTodo(), fotoSI));

const rSI = await prod.cargarSemana({
  stock_inicial: [{ insumo: 'sal fina', cantidad: 500, unidad_medida: 'g', costo_unitario: 2, motivo: 'Quedó del receso' }],
});
const sal = await ins('Sal fina');
t('suma el stock en la unidad del insumo', cerca(sal.stock_actual, (salAntes.stock_actual || 0) + 0.5, 1e-9));
t('pasa $2 por g a $2.000 por kg y pondera contra lo que había',
  cerca(sal.costo_unitario, calc.costoPonderado(salAntes.stock_actual || 0, salAntes.costo_unitario || 0, 0.5, 2000)));
t('NO genera movimiento de caja', await contar('movimiento_caja') === cajaSI);
const movSal = (await db.from('movimiento_stock_insumo').select().eq('insumo_id', sal.id))
  .find((m) => m.motivo === 'Quedó del receso');
t('deja un ajuste con su motivo', movSal?.tipo === 'ajuste' && cerca(movSal.cantidad, 0.5, 1e-9) && movSal.motivo === 'Quedó del receso');
t('el resumen lo cuenta', rSI.stockInicial[0].insumo === 'Sal fina');

const vacio = await prod.crearInsumo({ nombre: 'Insumo sin stock', unidad_medida: 'kg' });
await prod.cargarStockInicial({ insumoId: vacio.id, cantidad: 2, costoUnitario: 700, motivo: 'Inventario' });
t('con stock cero el costo es el dado', (await ins('Insumo sin stock')).costo_unitario === 700);

/* ================================================================== */
console.log('\n── ventas');

const tartaV2 = await pr('Tarta de verdura');
const cajaV = await db.from('movimiento_caja').select();
const fotoV = await fotoTodo();

err = await tira(() => prod.cargarSemana({
  ventas: [{ cliente: { nombre: 'Cliente goloso', tipo: 'particular' }, canal: 'otro', fecha_entrega: '2026-10-01',
    entregado: true, items: [{ producto: 'Tarta de verdura', cantidad: tartaV2.stock_actual + 1 }], cobros: [] }],
}));
t('una venta que deja stock negativo falla en la validación', /deja stock negativo: Tarta de verdura/.test(err?.message));
t('y no escribe nada: ni el cliente', igual(await fotoTodo(), fotoV));

const rV = await prod.cargarSemana({
  ventas: [
    { cliente: { nombre: 'Club de prueba', tipo: 'club' }, canal: 'otro', fecha_entrega: '2026-10-01',
      entregado: true, items: [{ producto: 'Tarta de verdura', cantidad: 1 }], cobros: [], notas: 'Paga el lunes' },
    { cliente: { nombre: 'club DE prueba', tipo: 'club' }, canal: 'whatsapp', fecha_entrega: '2026-10-02',
      entregado: true, items: [{ producto: 'Tarta de verdura', cantidad: 1 }],
      cobros: [{ monto: 4000, medio: 'transferencia', fecha: '2026-10-02' }] },
  ],
});
const [pImpago, pPago] = rV.ventas.pedidos;
const pedImpago = await db.from('pedido').select().eq('id', pImpago.id).single();
t('una venta con fecha pasada se carga igual', pedImpago.fecha_entrega === '2026-10-01' && pedImpago.fecha_pedido === '2026-10-01');
t('entregada sin cobro queda entregada e impaga', pedImpago.estado === 'entregado' && pedImpago.estado_pago === 'impago');
t('con cobro queda pagada', pPago.estadoPago === 'pagado' && pPago.cobrado === 4000);
const idsCajaV = new Set(cajaV.map((m) => m.id));
const cajaNueva = (await db.from('movimiento_caja').select()).filter((m) => !idsCajaV.has(m.id));
t('solo la cobrada genera ingreso en caja, con su fecha y medio', cajaNueva.length === 1
  && cajaNueva[0].tipo === 'ingreso' && cajaNueva[0].origen === 'cobro' && cajaNueva[0].monto === 4000
  && cajaNueva[0].fecha === '2026-10-02' && cajaNueva[0].medio === 'transferencia');
t('el cliente se crea una vez y la segunda lo encuentra por nombre',
  (await db.from('cliente').select()).filter((c) => c.nombre.toLowerCase() === 'club de prueba').length === 1);
t('descuenta el stock de las dos', (await pr('Tarta de verdura')).stock_actual === tartaV2.stock_actual - 2);
const [itVentaTarta] = await db.from('pedido_item').select().eq('pedido_id', pImpago.id);
t('congela el precio y el costo del momento', itVentaTarta.precio_unitario === 4000
  && cerca(itVentaTarta.costo_unitario, calc.costoEfectivo(tartaV2)));
t('el resumen trae vendido, cobrado y saldo por cliente', rV.ventas.totalVendido === 8000
  && rV.ventas.totalCobrado === 4000 && rV.ventas.saldoPorCliente['Club de prueba'] === 4000);

err = await tira(() => prod.cargarSemana({
  ventas: [{ cliente: { nombre: 'X', tipo: 'particular' }, canal: 'otro', fecha_entrega: '2026-10-01', entregado: false,
    items: [{ producto: 'Tarta de verdura', cantidad: 1 }], cobros: [{ monto: 9999999, medio: 'efectivo' }] }],
}));
t('no se cobra más que el total', /superan el total/.test(err?.message));

/* ================================================================== */
console.log('\n── un error en productos_nuevos frena todo');

const fotoE = await fotoTodo();
err = await tira(() => prod.cargarSemana({
  productos_nuevos: [{ nombre: 'Tarta de verdura', precio_venta: 100 }],
  compras: [{ insumo: 'Harina 000', cantidad: 1, costo_total: 1000, fecha: '2026-10-05' }],
}));
t('avisa el producto duplicado', /productos_nuevos\[0\]: ya existe un producto "Tarta de verdura"/.test(err?.message));
t('y no escribe ni la compra que estaba bien', igual(await fotoTodo(), fotoE));

/* ================================================================== */
console.log('\n── la semana real del 06/10 al 09/10, de punta a punta');

// El JSON no está en el repo (cargas/ va en .gitignore: tiene datos de
// clientes y el repo es público). Si no está en esta compu, se saltea con aviso
const { readFile } = await import('node:fs/promises');
const semanaReal = await readFile(new URL('../cargas/2026-10-06_semana.json', import.meta.url), 'utf8')
  .then(JSON.parse).catch(() => null);
if (!semanaReal) console.log('  ⚠ cargas/2026-10-06_semana.json no está en esta compu: se saltea');
else {

  await db.reset();
  await seed();
  await state.cargar();
  const rocioReal = await equipo.guardarTrabajadora({ nombre: 'Rocío' });
  await state.cargar();

  const r = await prod.cargarSemana(semanaReal);
  const caja = await db.from('movimiento_caja').select();
  const egresosCompra = caja.filter((m) => m.origen === 'compra_insumo').reduce((a, m) => a + m.monto, 0);
  const ingresos = caja.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);

  t('egresos de compras $427.886', egresosCompra === 427886 && r.totalEgresos === 427886);
  t('ventas $619.500', r.ventas.totalVendido === 619500);
  t('cobrado $91.000, y es lo único que entró a caja', r.ventas.totalCobrado === 91000 && ingresos === 91000);
  // Los nombres salen del JSON: el repo es público y no los repite
  const deudor = semanaReal.ventas.find((v) => !v.cobros.length).cliente.nombre;
  t('el revendedor que paga el lunes debe $528.500', r.ventas.saldoPorCliente[deudor] === 528500);
  t('el stock inicial no movió la caja: 16 compras y 3 cobros', caja.length === 19);

  const deLaSemana = ['Empanada de carne', 'Empanada jamón y queso', 'Empanada de roquefort',
    'Pizza muzzarella', 'Bondiola desmechada (porción)', 'Pizzeta'];
  const productosFin = await db.from('producto').select();
  t('producto terminado en 0 para todo lo de la semana', deLaSemana.every((n) =>
    cerca(productosFin.find((p) => p.nombre === n)?.stock_actual ?? NaN, 0, 1e-9)));
  t('tapas de empanada en 0', cerca((await ins('Tapas de empanada')).stock_actual, 0, 1e-9));
  t('carne picada en 0', cerca((await ins('Carne picada')).stock_actual, 0, 1e-9));
  t('harina y levadura del stock inicial, justas', cerca((await ins('Harina 000')).stock_actual, 0, 1e-9)
    && cerca((await ins('Levadura')).stock_actual, 0, 1e-9));
  t('la levadura queda a $8 el g: se mide en g', (await ins('Levadura')).costo_unitario === 8);

  const pagosRocio = (await db.from('pago_produccion').select()).filter((p) => p.trabajadora_id === rocioReal.id);
  t('pago_produccion de Rocío $192.620', cerca(pagosRocio.reduce((a, p) => a + p.total, 0), 192620));

  const [orden] = await db.from('orden_produccion').select();
  const ajusteCajas = (await db.from('movimiento_stock_insumo').select())
    .find((m) => m.tipo === 'ajuste' && m.referencia_id == null && /Cajas: se compraron 20/.test(m.motivo || ''));
  t('la orden cierra con motivo_ajuste', orden.estado === 'cerrada' && r.ordenes[0].ajustados === 1);
  // 4 con el redondeo de la receta: 8,0833 cajas por lote es 97/12 cortado
t('faltan 4 cajas', cerca(ajusteCajas?.cantidad ?? NaN, 4, 0.001));

  const nombres = semanaReal.ventas.map((v) => v.cliente.nombre);
  t('crea los cuatro productos nuevos y los cuatro clientes', r.productos.length === 4
    && (await db.from('cliente').select()).filter((c) => nombres.includes(c.nombre)).length === 4);
  const impago = r.ventas.pedidos.find((p) => p.cliente === deudor);
  t('y ese pedido queda entregado e impago', impago.estado === 'entregado' && impago.estadoPago === 'impago');
}

/* ================================================================== */
console.log(`\n${ok} bien · ${mal} mal\n`);
process.exit(mal ? 1 : 0);
