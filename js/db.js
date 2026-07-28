/**
 * db.js — Capa de datos
 *
 * Expone una API deliberadamente idéntica a la de Supabase:
 *
 *   await db.from('pedido').select().eq('estado', 'pendiente').order('fecha_entrega')
 *   await db.from('pedido').insert({ cliente_id, total })
 *   await db.from('pedido').update({ estado: 'entregado' }).eq('id', id)
 *   await db.from('pedido').delete().eq('id', id)
 *
 * Hoy por debajo hay IndexedDB. En la fase 5 se reemplaza la implementación
 * interna por el cliente de Supabase y NINGÚN módulo se toca.
 *
 * REGLA: ningún módulo puede usar indexedDB directamente. Todo pasa por acá.
 */

const DB_NAME = 'cocina_cic';
const DB_VERSION = 2;

export const TABLES = [
  'config',
  'unidad_negocio',
  'insumo',
  'compra_insumo',
  'producto',
  'receta_item',
  'orden_produccion',
  'produccion_item',
  'movimiento_stock_insumo',
  'movimiento_stock_producto',
  'cliente',
  'pedido',
  'pedido_item',
  'cobro',
  'trabajadora',
  'tarifa_historica',
  'jornada',
  'movimiento_caja',
];

/** Índices por tabla — acelera los filtros más usados. */
const INDEXES = {
  config: ['clave'],
  insumo: ['unidad_negocio_id', 'categoria'],
  compra_insumo: ['insumo_id', 'fecha'],
  producto: ['unidad_negocio_id', 'categoria'],
  receta_item: ['producto_id', 'insumo_id'],
  orden_produccion: ['unidad_negocio_id', 'fecha', 'estado'],
  produccion_item: ['orden_produccion_id', 'producto_id'],
  movimiento_stock_insumo: ['insumo_id', 'fecha'],
  movimiento_stock_producto: ['producto_id', 'fecha'],
  cliente: ['telefono'],
  pedido: ['cliente_id', 'estado', 'fecha_entrega', 'fecha_pedido'],
  pedido_item: ['pedido_id', 'producto_id'],
  cobro: ['pedido_id', 'fecha'],
  trabajadora: ['unidad_negocio_id', 'activa'],
  tarifa_historica: ['trabajadora_id'],
  jornada: ['trabajadora_id', 'fecha', 'orden_produccion_id', 'estado_pago'],
  movimiento_caja: ['unidad_negocio_id', 'fecha', 'tipo', 'origen'],
};

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      for (const t of TABLES) {
        if (idb.objectStoreNames.contains(t)) continue;
        const store = idb.createObjectStore(t, { keyPath: 'id' });
        for (const idx of INDEXES[t] || []) store.createIndex(idx, idx);
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function nowISO() { return new Date().toISOString(); }

async function readAll(table) {
  const idb = await open();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(table, 'readonly').objectStore(table).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function writeMany(table, rows) {
  const idb = await open();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(table, 'readwrite');
    const store = tx.objectStore(table);
    for (const r of rows) store.put(r);
    tx.oncomplete = () => resolve(rows);
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteMany(table, ids) {
  const idb = await open();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(table, 'readwrite');
    const store = tx.objectStore(table);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve(ids.length);
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ */
/*  Query builder                                                      */
/* ------------------------------------------------------------------ */

const OPS = {
  eq:  (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt:  (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt:  (a, b) => a < b,
  lte: (a, b) => a <= b,
  in:  (a, b) => Array.isArray(b) && b.includes(a),
  like: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()),
};

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this._op = 'select';
    this._payload = null;
    this._order = null;
    this._limit = null;
    this._single = false;
  }

  /* Filtros — encadenables, se aplican con AND */
  eq(f, v)   { this.filters.push([f, 'eq', v]);   return this; }
  neq(f, v)  { this.filters.push([f, 'neq', v]);  return this; }
  gt(f, v)   { this.filters.push([f, 'gt', v]);   return this; }
  gte(f, v)  { this.filters.push([f, 'gte', v]);  return this; }
  lt(f, v)   { this.filters.push([f, 'lt', v]);   return this; }
  lte(f, v)  { this.filters.push([f, 'lte', v]);  return this; }
  in(f, v)   { this.filters.push([f, 'in', v]);   return this; }
  like(f, v) { this.filters.push([f, 'like', v]); return this; }

  order(field, { ascending = true } = {}) { this._order = [field, ascending]; return this; }
  limit(n) { this._limit = n; return this; }
  single() { this._single = true; return this; }

  select() { this._op = 'select'; return this; }
  insert(payload) { this._op = 'insert'; this._payload = payload; return this; }
  update(patch)   { this._op = 'update'; this._payload = patch;   return this; }
  delete()        { this._op = 'delete'; return this; }

  _match(row) {
    return this.filters.every(([f, op, v]) => OPS[op](row[f], v));
  }

  /* Thenable: la query se ejecuta al await-earla, igual que en Supabase */
  then(resolve, reject) {
    return this._run().then(resolve, reject);
  }

  async _run() {
    const t = this.table;

    if (this._op === 'insert') {
      const rows = (Array.isArray(this._payload) ? this._payload : [this._payload])
        .map((r) => ({
          id: r.id || uuid(),
          ...r,
          created_at: r.created_at || nowISO(),
          updated_at: nowISO(),
          sync_status: 'local',
        }));
      await writeMany(t, rows);
      return Array.isArray(this._payload) ? rows : rows[0];
    }

    const all = await readAll(t);

    if (this._op === 'update') {
      const targets = all.filter((r) => this._match(r));
      const updated = targets.map((r) => ({
        ...r, ...this._payload, updated_at: nowISO(), sync_status: 'local',
      }));
      await writeMany(t, updated);
      return this._single ? updated[0] ?? null : updated;
    }

    if (this._op === 'delete') {
      const ids = all.filter((r) => this._match(r)).map((r) => r.id);
      await deleteMany(t, ids);
      return ids.length;
    }

    /* select */
    let rows = all.filter((r) => this._match(r));
    if (this._order) {
      const [f, asc] = this._order;
      rows.sort((a, b) => {
        const x = a[f], y = b[f];
        if (x === y) return 0;
        return (x > y ? 1 : -1) * (asc ? 1 : -1);
      });
    }
    if (this._limit != null) rows = rows.slice(0, this._limit);
    return this._single ? rows[0] ?? null : rows;
  }
}

/* ------------------------------------------------------------------ */
/*  API pública                                                        */
/* ------------------------------------------------------------------ */

export const db = {
  from: (table) => {
    if (!TABLES.includes(table)) throw new Error(`Tabla desconocida: ${table}`);
    return new Query(table);
  },

  /** Exporta toda la base a JSON. Es el backup de las fases 0 a 4. */
  async exportAll() {
    const out = { _version: DB_VERSION, _exported_at: nowISO() };
    for (const t of TABLES) out[t] = await readAll(t);
    return out;
  },

  /** Restaura desde un export. Pisa lo existente. */
  async importAll(data) {
    for (const t of TABLES) {
      if (Array.isArray(data[t]) && data[t].length) await writeMany(t, data[t]);
    }
  },

  async reset() {
    const idb = await open();
    await Promise.all(TABLES.map((t) => new Promise((res, rej) => {
      const tx = idb.transaction(t, 'readwrite');
      tx.objectStore(t).clear();
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    })));
  },

  uuid,

  /* --- config: almacén clave/valor para ajustes de la instalación --- */

  async getConfig(clave, porDefecto = null) {
    const fila = await db.from('config').select().eq('clave', clave).single();
    return fila ? fila.valor : porDefecto;
  },

  async setConfig(clave, valor) {
    const fila = await db.from('config').select().eq('clave', clave).single();
    if (fila) return db.from('config').update({ valor }).eq('clave', clave);
    return db.from('config').insert({ clave, valor });
  },
};

/**
 * seed() — datos iniciales para desarrollo.
 * TODO Fase 1: completar insumos reales con costos de Tandil y las recetas.
 */
export async function seed() {
  const existentes = await db.from('unidad_negocio').select();
  if (existentes.length) return;

  const un = await db.from('unidad_negocio').insert({
    nombre: 'Cocina CIC', tipo: 'alimentos', activa: true,
  });

  await db.from('producto').insert([
    { unidad_negocio_id: un.id, nombre: 'Empanada de carne',      categoria: 'Empanadas', unidad_venta: 'unidad', precio_venta: 800,  costo_manual: 350,  stock_actual: 50, stock_minimo: 10, rinde_por_lote: 24, activo: true },
    { unidad_negocio_id: un.id, nombre: 'Empanada jamón y queso', categoria: 'Empanadas', unidad_venta: 'unidad', precio_venta: 800,  costo_manual: 320,  stock_actual: 30, stock_minimo: 10, rinde_por_lote: 24, activo: true },
    { unidad_negocio_id: un.id, nombre: 'Empanada de verdura',    categoria: 'Empanadas', unidad_venta: 'unidad', precio_venta: 750,  costo_manual: 280,  stock_actual: 20, stock_minimo: 10, rinde_por_lote: 24, activo: true },
    { unidad_negocio_id: un.id, nombre: 'Tarta de verdura',       categoria: 'Tartas',    unidad_venta: 'unidad', precio_venta: 3500, costo_manual: 1200, stock_actual: 8,  stock_minimo: 2,  rinde_por_lote: 4,  activo: true },
    { unidad_negocio_id: un.id, nombre: 'Tarta de carne',         categoria: 'Tartas',    unidad_venta: 'unidad', precio_venta: 4000, costo_manual: 1500, stock_actual: 4,  stock_minimo: 2,  rinde_por_lote: 4,  activo: true },
    { unidad_negocio_id: un.id, nombre: 'Combo bondiola 6 porciones', categoria: 'Combos', unidad_venta: 'combo', precio_venta: 0,    costo_manual: 0,    stock_actual: 0,  stock_minimo: 0,  rinde_por_lote: 1,  activo: true },
  ]);

  await db.from('trabajadora').insert([
    { unidad_negocio_id: un.id, nombre: 'Ana',   tarifa_dia: 5000, activa: true },
    { unidad_negocio_id: un.id, nombre: 'María', tarifa_dia: 5000, activa: true },
  ]);

  return un;
}
