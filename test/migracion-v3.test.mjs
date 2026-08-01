/**
 * Migración v2 → v3: separar `canal` de `modo_entrega`.
 *
 * Esta suite es aparte porque tiene que armar una base en la versión VIEJA
 * antes de que `db.js` se importe: en cuanto ese módulo entra, abre la base en
 * la versión nueva y la migración ya corrió.
 *
 * Una migración que corrompe datos es de los errores más caros que hay: la
 * cocina no tiene copia de lo cargado el mes pasado.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };

/* ------------------------------------------------------------------ */
/*  Una base v2, como la que tiene hoy la cocina                       */
/* ------------------------------------------------------------------ */

const TABLAS_V2 = [
  'config', 'unidad_negocio', 'insumo', 'compra_insumo', 'producto', 'receta_item',
  'orden_produccion', 'produccion_item', 'movimiento_stock_insumo',
  'movimiento_stock_producto', 'cliente', 'pedido', 'pedido_item', 'cobro',
  'trabajadora', 'tarifa_historica', 'jornada', 'movimiento_caja',
];

const VIEJOS = [
  { id: 'p1', canal: 'cic_presencial', es_mostrador: true,  total: 4800, estado: 'entregado' },
  { id: 'p2', canal: 'club_uncas',     es_mostrador: true,  total: 12000, estado: 'entregado' },
  { id: 'p3', canal: 'whatsapp',       es_mostrador: false, total: 16600, estado: 'confirmado' },
  { id: 'p4', canal: 'instagram',      total: 3500, estado: 'listo' },
  { id: 'p5', total: 900, estado: 'pendiente' },   // sin canal, de las primeras pruebas
];

await new Promise((resolve, reject) => {
  const req = indexedDB.open('cocina_cic', 2);
  req.onupgradeneeded = (e) => {
    const idb = e.target.result;
    for (const tabla of TABLAS_V2) idb.createObjectStore(tabla, { keyPath: 'id' });
  };
  req.onsuccess = () => {
    const idb = req.result;
    const tx = idb.transaction('pedido', 'readwrite');
    for (const p of VIEJOS) tx.objectStore('pedido').put(p);
    tx.oncomplete = () => { idb.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
});

/* Recién ahora entra db.js, que abre en v3 y dispara la migración. */
const { db } = await import('../js/db.js');

const pedidos = await db.from('pedido').select();
const porId = new Map(pedidos.map((p) => [p.id, p]));

/* ================================================================== */
console.log('\n── migración v2 → v3');

t('no se pierde ni se duplica ningún pedido', pedidos.length === VIEJOS.length);

t('cic_presencial pasa a mostrador_cic', porId.get('p1').canal === 'mostrador_cic');
t('club_uncas pasa a mostrador_uncas',   porId.get('p2').canal === 'mostrador_uncas');
t('los canales que no cambiaron quedan igual',
  porId.get('p3').canal === 'whatsapp' && porId.get('p4').canal === 'instagram');
t('un pedido sin canal queda como otro', porId.get('p5').canal === 'otro');

t('lo del mostrador se entregó en el acto',
  porId.get('p1').modo_entrega === 'en_el_acto'
  && porId.get('p2').modo_entrega === 'en_el_acto');
t('del resto no hay dato histórico: quedan como retiro en el CIC',
  porId.get('p3').modo_entrega === 'retira_cic'
  && porId.get('p4').modo_entrega === 'retira_cic'
  && porId.get('p5').modo_entrega === 'retira_cic');

t('todos quedan con los campos nuevos',
  pedidos.every((p) => p.costo_envio === 0
    && p.direccion_entrega === null
    && p.origen_web_id === null));

// Lo que más importa de una migración: que no toque la plata.
t('los totales no se tocaron',
  VIEJOS.every((v) => porId.get(v.id).total === v.total));
t('los estados no se tocaron',
  VIEJOS.every((v) => porId.get(v.id).estado === v.estado));
t('la marca de mostrador sobrevive',
  porId.get('p1').es_mostrador === true && porId.get('p3').es_mostrador === false);

/* ================================================================== */
console.log('\n── los índices nuevos se crean sobre una tabla que ya existía');

// Sin esto, agregar un índice obligaría a borrar la base de una cocina con
// meses de datos cargados.
const porModo = await db.from('pedido').select().eq('modo_entrega', 'en_el_acto');
t('se puede filtrar por modo_entrega', porModo.length === 2);

/* ================================================================== */
console.log(`\n${ok} pasaron · ${mal} fallaron`);
process.exit(mal ? 1 : 0);
