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
const r2 = (n) => Math.round(n * 100) / 100;
const cerca = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const tira = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

await seed();
await state.cargar();
auth.rol = 'admin';

const insumo = (n) => state.insumos.find((i) => i.nombre === n);
const leer = (tabla, id) => db.from(tabla).select().eq('id', id).single();

/* ================================================================== */
console.log('\n── conversión de unidades');

t('kg a g',  calc.convertir(1, 'kg', 'g') === 1000);
t('g a kg',  calc.convertir(500, 'g', 'kg') === 0.5);
t('l a ml',  calc.convertir(2, 'l', 'ml') === 2000);
t('ml a l',  calc.convertir(250, 'ml', 'l') === 0.25);
t('la misma unidad no se toca', calc.convertir(3, 'kg', 'kg') === 3);

let err = await tira(() => calc.convertir(1, 'kg', 'l'));
t('masa y volumen no se mezclan', !!err);
err = await tira(() => calc.convertir(1, 'unidad', 'g'));
t('unidad no se convierte a peso', !!err);

t('unidades compatibles con kg', calc.unidadesCompatibles('kg').join() === 'kg,g');
t('unidades compatibles con ml', calc.unidadesCompatibles('ml').join() === 'l,ml');

// El caso que motivó todo: una receta que mezcla gramos con kilos
const mapa = new Map([['h', { costo_unitario: 1200, unidad_medida: 'kg' }]]);
t('250 g de un insumo de $1.200/kg cuestan $300',
  calc.costoProducto([{ insumo_id: 'h', cantidad: 250, unidad_medida: 'g', merma_pct: 0 }], mapa, 1) === 300);

/* ================================================================== */
console.log('\n── compra de insumo: promedio ponderado');

const harina = insumo('Harina 000');       // 25 kg a $1.200
const carne  = insumo('Carne picada');     // 8 kg a $9.500
const cebolla = insumo('Cebolla');         // 6 kg a $1.400

const compra = await prod.registrarCompra({
  insumoId: harina.id, cantidad: 25, costoTotal: 40000, proveedor: 'Molino Tandil',
});

let h = await leer('insumo', harina.id);
t('suma el stock comprado', h.stock_actual === 50);
t('el costo queda ponderado, no reemplazado', h.costo_unitario === 1400);
t('no toma el costo de la última compra', h.costo_unitario !== 1600);
t('guarda el proveedor', h.proveedor_habitual === 'Molino Tandil');

const compras = await db.from('compra_insumo').select();
t('registra la compra', compras.length === 1 && compras[0].costo_total === 40000);

let caja = await db.from('movimiento_caja').select();
t('genera UN egreso automático en caja', caja.length === 1);
t('el egreso apunta a la compra',
  caja[0].tipo === 'egreso' && caja[0].origen === 'compra_insumo'
  && caja[0].referencia_id === compra.compra.id && caja[0].monto === 40000);

let movH = await db.from('movimiento_stock_insumo').select().eq('insumo_id', harina.id);
t('deja el movimiento de stock', movH.length === 1 && movH[0].tipo === 'compra' && movH[0].cantidad === 25);

err = await tira(() => prod.registrarCompra({ insumoId: harina.id, cantidad: 0, costoTotal: 100 }));
t('no acepta cantidad cero', !!err);

/* ================================================================== */
console.log('\n── receta y costeo');

await state.cargar();
const empanada = state.productos.find((p) => p.nombre === 'Empanada de carne');

// Por lote de 24: 1 kg de harina + 500 g de carne con 10% de merma + 200 g de cebolla
let alertas = await prod.guardarReceta(empanada.id, [
  { insumo_id: harina.id,  cantidad: 1,   unidad_medida: 'kg', merma_pct: 0 },
  { insumo_id: carne.id,   cantidad: 500, unidad_medida: 'g',  merma_pct: 10 },
  { insumo_id: cebolla.id, cantidad: 200, unidad_medida: 'g',  merma_pct: 0 },
], 24);

let emp = await leer('producto', empanada.id);
// (1×1400) + (0,5×9500×1,1) + (0,2×1400) = 6905 el lote ÷ 24
t('costea la receta convirtiendo g a kg', r2(emp.costo_calculado) === 287.71);
t('el costo calculado pisa al manual', calc.costoEfectivo(emp) === emp.costo_calculado);
t('con buen margen no alerta', alertas.length === 0);

err = await tira(() => prod.guardarReceta(empanada.id, [
  { insumo_id: harina.id, cantidad: 1, unidad_medida: 'l', merma_pct: 0 },
], 24));
t('rechaza una unidad incompatible con la del insumo', !!err);

/* ================================================================== */
console.log('\n── insumos requeridos vs disponibles');

const reqs = await prod.requerimientos([{ producto_id: empanada.id, cantidad: 48 }]);
const reqCarne = reqs.find((r) => r.insumo.id === carne.id);

t('pide los tres insumos de la receta', reqs.length === 3);
t('dos lotes piden 1,1 kg de carne (merma incluida)', cerca(reqCarne.requerido, 1.1));
t('muestra lo disponible', reqCarne.disponible === 8);
t('no falta nada', reqs.every((r) => r.falta === 0));

const muchos = await prod.requerimientos([{ producto_id: empanada.id, cantidad: 2400 }]);
t('con 100 lotes falta carne', muchos.find((r) => r.insumo.id === carne.id).falta > 0);
t('el faltante ordena primero', muchos[0].falta > 0);

/* ================================================================== */
console.log('\n── orden de producción');

const ana = state.trabajadoras.find((x) => x.nombre === 'Ana');
const maria = state.trabajadoras.find((x) => x.nombre === 'María');

// La tarifa vigente al día de la orden, que no es la de la ficha
await db.from('tarifa_historica').insert({
  trabajadora_id: ana.id, tarifa_dia: 6000, vigente_desde: '2026-01-01',
});

const orden = await prod.crearOrden({ items: [{ producto_id: empanada.id, cantidad: 48 }] });
t('la orden nace planificada', orden.estado === 'planificada');

let jornadas = await prod.asignarTrabajadoras(orden.id, [ana.id, maria.id]);
t('asignar crea una jornada por trabajadora', jornadas.length === 2);
t('la jornada se vincula a la orden', jornadas.every((j) => j.orden_produccion_id === orden.id));
t('congela la tarifa histórica, no trabajadora.tarifa_dia',
  jornadas.find((j) => j.trabajadora_id === ana.id).tarifa_aplicada === 6000 && ana.tarifa_dia === 5000);
t('la cargada por admin entra confirmada',
  jornadas.every((j) => j.confirmada && j.origen_carga === 'admin'));

jornadas = await prod.asignarTrabajadoras(orden.id, [ana.id, maria.id]);
t('reasignar lo mismo no duplica jornadas', jornadas.length === 2);

jornadas = await prod.asignarTrabajadoras(orden.id, [ana.id]);
t('sacar a alguien le borra la jornada', jornadas.length === 1);

const cierre = await prod.cerrarOrden(orden.id, {}, {});   // sin tocar: cierra con lo planificado
const ordenCerrada = await leer('orden_produccion', orden.id);

t('la orden queda cerrada', ordenCerrada.estado === 'cerrada' && !!ordenCerrada.cerrada_at);

h = await leer('insumo', harina.id);
let c = await leer('insumo', carne.id);
let ce = await leer('insumo', cebolla.id);

t('descuenta la harina de dos lotes', cerca(h.stock_actual, 48));
t('descuenta la carne con la merma aplicada', cerca(c.stock_actual, 8 - 1.1));
t('descuenta la cebolla convertida a kg', cerca(ce.stock_actual, 6 - 0.4));

emp = await leer('producto', empanada.id);
t('suma el producto terminado', emp.stock_actual === 50 + 48);

const [pitem] = await db.from('produccion_item').select().eq('orden_produccion_id', orden.id);
t('guarda la cantidad real', pitem.cantidad_real === 48);
t('congela el costo unitario', r2(pitem.costo_unitario_snapshot) === 287.71);

t('el costo de insumos de la orden es el de la receta por lo producido',
  cerca(cierre.costoInsumos, 287.708333 * 48, 0.5));
t('imputa la mano de obra de las jornadas vinculadas',
  cierre.costoManoObra === 6000 && ordenCerrada.costo_mano_obra === 6000);

const movs = await db.from('movimiento_stock_insumo').select().eq('tipo', 'produccion');
t('deja un movimiento de stock por insumo consumido', movs.length === 3);
t('el consumo es negativo y apunta a la orden',
  movs.every((m) => m.cantidad < 0 && m.referencia_id === orden.id));

const movP = await db.from('movimiento_stock_producto').select().eq('tipo', 'produccion');
t('deja el movimiento del producto terminado', movP.length === 1 && movP[0].cantidad === 48);

err = await tira(() => prod.cerrarOrden(orden.id, {}, {}));
t('no se cierra dos veces', !!err);

/* ================================================================== */
console.log('\n── el snapshot es inmutable');

// Se dispara la carne: cambia el costo de hoy, no el margen de lo ya producido
const antesDelAumento = pitem.costo_unitario_snapshot;
const { alertas: avisos } = await prod.registrarCompra({
  insumoId: carne.id, cantidad: 10, costoTotal: 400000,
});

emp = await leer('producto', empanada.id);
const pitemDespues = await leer('produccion_item', pitem.id);

t('el costo actual del producto sube', emp.costo_calculado > antesDelAumento * 2);
t('el snapshot de la producción NO cambia', pitemDespues.costo_unitario_snapshot === antesDelAumento);
t('avisa con el nombre del producto', avisos.some((a) => a.producto === 'Empanada de carne'));
t('la alerta trae el margen que quedó',
  avisos[0].margenPct < calc.MARGEN_MINIMO && avisos[0].margenPct > 0);

/* ================================================================== */
console.log('\n── ajustes de stock');

err = await tira(() => prod.ajustarStockInsumo(cebolla.id, 10, ''));
t('el ajuste de insumo exige motivo', !!err);
err = await tira(() => prod.ajustarStockProducto(empanada.id, 10, '   '));
t('el ajuste de producto exige motivo', !!err);

await prod.ajustarStockInsumo(cebolla.id, 10, 'Se contó mal el sábado');
ce = await leer('insumo', cebolla.id);
const ajustes = await db.from('movimiento_stock_insumo').select().eq('tipo', 'ajuste');
t('el ajuste deja el stock donde se dijo', ce.stock_actual === 10);
t('el ajuste queda registrado con su motivo',
  ajustes.length === 1 && ajustes[0].motivo === 'Se contó mal el sábado');
t('el movimiento guarda la diferencia, no el total', cerca(ajustes[0].cantidad, 10 - 5.6));

/* ================================================================== */
console.log('\n── no se cierra una orden sin insumo');

const grande = await prod.crearOrden({ items: [{ producto_id: empanada.id, cantidad: 2400 }] });
err = await tira(() => prod.cerrarOrden(grande.id, {}, {}));

t('sin motivo no cierra', !!err);
t('el error dice qué insumo falta', /[Cc]arne/.test(err.message));
t('el error trae la lista de faltantes', err.faltantes?.length > 0);
t('la orden sigue abierta', (await leer('orden_produccion', grande.id)).estado === 'planificada');

const stockCarneAntes = (await leer('insumo', carne.id)).stock_actual;
await prod.cerrarOrden(grande.id, {}, { motivoAjuste: 'Había carne de la donación sin cargar' });

t('con motivo explícito sí cierra',
  (await leer('orden_produccion', grande.id)).estado === 'cerrada');

const ajusteForzado = (await db.from('movimiento_stock_insumo').select().eq('tipo', 'ajuste'))
  .filter((m) => m.insumo_id === carne.id);
t('el ajuste forzado queda con su motivo',
  ajusteForzado.length === 1 && ajusteForzado[0].motivo === 'Había carne de la donación sin cargar');
t('el ajuste subió el stock hasta lo necesario', ajusteForzado[0].cantidad > 0 && stockCarneAntes < 55);

/* ================================================================== */
console.log('\n── tarifa vigente a la fecha');

const tarifas = [
  { tarifa_dia: 4000, vigente_desde: '2026-01-01' },
  { tarifa_dia: 5500, vigente_desde: '2026-03-01' },
];
t('una fecha vieja se liquida con la tarifa vieja', calc.tarifaVigente(tarifas, '2026-02-10', 9999) === 4000);
t('desde la vigencia rige la nueva', calc.tarifaVigente(tarifas, '2026-03-01', 0) === 5500);
t('sin historial cae a la tarifa de la ficha', calc.tarifaVigente([], '2026-03-01', 5000) === 5000);

/* ================================================================== */
console.log('\n── permisos del módulo');

t('el admin gestiona insumos', auth.puede('gestionarInsumos'));
auth.rol = 'trabajadora';
t('la trabajadora NO gestiona insumos ni compras', !auth.puede('gestionarInsumos'));
t('la trabajadora NO ve costos', !auth.puede('verCostos'));
t('la trabajadora NO ve al equipo completo', !auth.puede('verEquipoCompleto'));
t('la trabajadora sí entra a producción', auth.puedeVer('produccion'));

console.log(`\n${ok} pasaron · ${mal} fallaron\n`);
process.exit(mal ? 1 : 0);
