/**
 * Migración v4 → v5: aparece `pago_produccion`.
 *
 * Aparte por el mismo motivo que migracion-v3: hay que armar la base en la
 * versión VIEJA antes de importar `db.js`, que la abre en la nueva.
 *
 * La migración no transforma nada, pero es la que agrega la tabla con la que
 * se paga al equipo: si al subir de versión se perdiera una jornada pagada o
 * un movimiento de caja, la liquidación del histórico dejaría de cerrar.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };

/* ------------------------------------------------------------------ */
/*  Una base v4, como la que tiene hoy la cocina                       */
/* ------------------------------------------------------------------ */

const TABLAS_V4 = [
  'config', 'unidad_negocio', 'insumo', 'compra_insumo', 'producto', 'receta_item',
  'orden_produccion', 'produccion_item', 'movimiento_stock_insumo',
  'movimiento_stock_producto', 'cliente', 'pedido', 'pedido_item', 'cobro',
  'trabajadora', 'tarifa_historica', 'jornada', 'movimiento_caja', 'borrado',
];

const JORNADAS = [
  { id: 'j1', trabajadora_id: 't1', fecha: '2026-05-04', tarifa_aplicada: 5000, confirmada: true, estado_pago: 'pagada', fecha_pago: '2026-05-10' },
  { id: 'j2', trabajadora_id: 't1', fecha: '2026-05-05', tarifa_aplicada: 5000, confirmada: true, estado_pago: 'pendiente' },
];
const CAJA = [
  { id: 'm1', fecha: '2026-05-10', tipo: 'egreso', origen: 'jornal', monto: 5000 },
];

await new Promise((resolve, reject) => {
  const req = indexedDB.open('cocina_cic', 4);
  req.onupgradeneeded = (e) => {
    const idb = e.target.result;
    for (const tabla of TABLAS_V4) idb.createObjectStore(tabla, { keyPath: 'id' });
  };
  req.onsuccess = () => {
    const idb = req.result;
    const tx = idb.transaction(['jornada', 'movimiento_caja', 'producto'], 'readwrite');
    for (const j of JORNADAS) tx.objectStore('jornada').put(j);
    for (const m of CAJA) tx.objectStore('movimiento_caja').put(m);
    tx.objectStore('producto').put({ id: 'p1', nombre: 'Empanada de carne', costo_manual: 350, precio_venta: 800 });
    tx.oncomplete = () => { idb.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
});

/* Recién ahora entra db.js, que abre en v5. */
const { db } = await import('../js/db.js');

/* ================================================================== */
console.log('\n── migración v4 → v5');

const jornadas = await db.from('jornada').select();
t('no se pierde ninguna jornada', jornadas.length === JORNADAS.length);
t('las tarifas del histórico no se tocan',
  JORNADAS.every((v) => jornadas.find((j) => j.id === v.id).tarifa_aplicada === v.tarifa_aplicada));
t('lo pagado sigue pagado', jornadas.find((j) => j.id === 'j1').estado_pago === 'pagada');
t('la caja queda igual', (await db.from('movimiento_caja').select()).length === 1);

const p = await db.from('producto').select().eq('id', 'p1').single();
t('un producto viejo no tiene pago definido: null, no cero', p.pago_produccion == null);

const fila = await db.from('pago_produccion').insert({
  trabajadora_id: 't1', orden_produccion_id: 'o1', produccion_item_id: 'i1', producto_id: 'p1',
  fecha: '2026-10-06', cantidad: 48, pago_unitario: 40, total: 1920,
  origen_carga: 'admin', confirmada: true, estado_pago: 'pendiente',
});
t('la tabla nueva existe y se puede escribir', !!fila.id);
t('y se filtra por sus índices',
  (await db.from('pago_produccion').select().eq('trabajadora_id', 't1').eq('estado_pago', 'pendiente')).length === 1);

console.log(`\n${ok} pasaron · ${mal} fallaron`);
process.exit(mal ? 1 : 0);
