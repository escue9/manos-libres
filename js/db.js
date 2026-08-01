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

/**
 * Subir esto cada vez que cambie la forma de los datos, y escribir la
 * migración en `migrar()`.
 *
 *  2 → 3  `canal` mezclaba por dónde entró el pedido con cómo llega al
 *         cliente. Se separa en `canal` + `modo_entrega`.
 */
const DB_VERSION = 3;

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
  pedido: ['cliente_id', 'estado', 'fecha_entrega', 'fecha_pedido', 'modo_entrega', 'origen_web_id'],
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
      const tx = e.target.transaction;

      for (const t of TABLES) {
        const store = idb.objectStoreNames.contains(t)
          ? tx.objectStore(t)
          : idb.createObjectStore(t, { keyPath: 'id' });

        // Los índices se revisan también sobre stores que ya existían: agregar
        // un índice nuevo no puede obligar a borrar la base de una cocina que
        // ya tiene meses de datos cargados.
        for (const idx of INDEXES[t] || []) {
          if (!store.indexNames.contains(idx)) store.createIndex(idx, idx);
        }
      }

      // oldVersion 0 es una base recién creada: no hay nada que migrar.
      if (e.oldVersion > 0 && e.oldVersion < 3) migrarAEntrega(tx);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

/**
 * v2 → v3 — separa `canal` de `modo_entrega`.
 *
 * `canal` mezclaba dos preguntas distintas: por dónde ENTRÓ el pedido y cómo
 * LLEGA al cliente. Con el canal web hay pedidos que entran por la página y se
 * entregan a domicilio, así que la mezcla ya no cierra.
 *
 * Lo que se cargó en el mostrador se entregó en el acto; del resto no hay dato
 * histórico, así que quedan como retiro en el CIC, que es lo que se venía
 * haciendo. `costo_envio` queda preparado en cero: hoy el envío no se cobra,
 * pero cuando se cobre tiene que sumar al total sin ensuciar el margen del
 * producto (regla 4).
 */
function migrarAEntrega(tx) {
  const RENOMBRE = { cic_presencial: 'mostrador_cic', club_uncas: 'mostrador_uncas' };
  const store = tx.objectStore('pedido');

  store.openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;

    const p = cursor.value;
    const enElActo = p.es_mostrador === true || Object.hasOwn(RENOMBRE, p.canal ?? '');

    cursor.update({
      ...p,
      canal: RENOMBRE[p.canal] || p.canal || 'otro',
      modo_entrega: p.modo_entrega || (enElActo ? 'en_el_acto' : 'retira_cic'),
      direccion_entrega: p.direccion_entrega ?? null,
      costo_envio: p.costo_envio ?? 0,
      origen_web_id: p.origen_web_id ?? null,
    });
    cursor.continue();
  };
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

/**
 * Aplica un patch a las filas que matcheen, TODO dentro de una sola
 * transacción de lectura-escritura.
 *
 * Antes esto eran dos transacciones (leer todo → mapear → escribir todo) y
 * además reescribía la fila entera, no las claves del patch. Dos escrituras
 * concurrentes sobre la misma fila —dos pestañas, o el stock y el costo del
 * mismo insumo— se pisaban: la segunda revertía a la primera sin ningún error.
 * En una tabla donde el stock es sagrado (regla 7) eso es pérdida silenciosa.
 */
async function patchWhere(table, matchFn, patch) {
  const idb = await open();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(table, 'readwrite');
    const store = tx.objectStore(table);
    const tocadas = [];

    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (matchFn(cursor.value)) {
        const fila = { ...cursor.value, ...patch, updated_at: nowISO(), sync_status: 'local' };
        cursor.update(fila);
        tocadas.push(fila);
      }
      cursor.continue();
    };

    tx.oncomplete = () => resolve(tocadas);
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

    // Un .eq() olvidado en un módulo vaciaría o pisaría la tabla entera, y
    // hasta la fase 5 el backup es la única copia que existe. Para tocar todo
    // a propósito está db.reset().
    if ((this._op === 'update' || this._op === 'delete') && !this.filters.length) {
      throw new Error(`${this._op} sobre '${t}' sin filtros: falta un .eq()`);
    }

    if (this._op === 'update') {
      const updated = await patchWhere(t, (r) => this._match(r), this._payload);
      return this._single ? updated[0] ?? null : updated;
    }

    const all = await readAll(t);

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
        if (x == null) return 1;      // nulls al final, como el default de Postgres
        if (y == null) return -1;
        // Los nombres se ordenan en castellano: con `>` puro, "Ñoquis" y
        // "Ácido cítrico" caen después de la Z y parecen no estar cargados
        const cmp = (typeof x === 'string' && typeof y === 'string')
          ? x.localeCompare(y, 'es-AR', { sensitivity: 'base' })
          : (x > y ? 1 : -1);
        return cmp * (asc ? 1 : -1);
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

  /**
   * Exporta toda la base a JSON. Es el backup de las fases 0 a 4.
   *
   * Los PIN quedan afuera a propósito: el archivo se manda por WhatsApp o se
   * guarda en Drive, y con el hash y el salt en el mismo JSON cuatro dígitos
   * se rompen probando diez mil combinaciones. Al restaurar se vuelven a
   * crear, que es un minuto de trabajo y no un riesgo permanente.
   */
  async exportAll() {
    const out = { _version: DB_VERSION, _exported_at: nowISO() };
    for (const t of TABLES) out[t] = await readAll(t);

    out.config = out.config.filter((c) => !['admin_pin', 'pin_salt'].includes(c.clave));
    out.trabajadora = out.trabajadora.map(({ pin_acceso, ...t }) => t);

    return out;
  },

  /**
   * Restaura desde un export. REEMPLAZA todo lo que haya.
   *
   * Antes solo escribía encima fila por fila: lo borrado después del backup
   * revivía y lo cargado después sobrevivía, así que "restaurar el backup del
   * lunes" dejaba una mezcla de dos momentos distintos sin avisar a nadie.
   * El PIN de administración se conserva, porque el export ya no lo trae.
   */
  async importAll(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.unidad_negocio)) {
      throw new Error('El archivo no es una copia de seguridad de la cocina');
    }
    if (data._version > DB_VERSION) {
      throw new Error(`La copia es de una versión más nueva de la app (v${data._version})`);
    }

    const pins = (await readAll('config')).filter((c) => ['admin_pin', 'pin_salt', 'admin_nombre'].includes(c.clave));

    for (const t of TABLES) {
      await new Promise((res, rej) => {
        open().then((idb) => {
          const tx = idb.transaction(t, 'readwrite');
          const store = tx.objectStore(t);
          store.clear();
          for (const fila of (Array.isArray(data[t]) ? data[t] : [])) store.put(fila);
          if (t === 'config') for (const p of pins) store.put(p);
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        }, rej);
      });
    }

    return TABLES.reduce((a, t) => a + (Array.isArray(data[t]) ? data[t].length : 0), 0);
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
 *
 * Los costos de los insumos son el punto cero: se corrigen solos con la primera
 * compra real, que recalcula el promedio ponderado. Las recetas NO se siembran
 * a propósito — se arman desde la pantalla de Recetas con los insumos reales de
 * la cocina, que es el trabajo de la puesta en marcha.
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

  await db.from('insumo').insert([
    { unidad_negocio_id: un.id, nombre: 'Harina 000',        categoria: 'Almacén',     unidad_medida: 'kg',     costo_unitario: 1200, stock_actual: 25,  stock_minimo: 10, activo: true },
    { unidad_negocio_id: un.id, nombre: 'Carne picada',      categoria: 'Carnicería',  unidad_medida: 'kg',     costo_unitario: 9500, stock_actual: 8,   stock_minimo: 5,  activo: true },
    { unidad_negocio_id: un.id, nombre: 'Jamón cocido',      categoria: 'Carnicería',  unidad_medida: 'kg',     costo_unitario: 8200, stock_actual: 3,   stock_minimo: 2,  activo: true },
    { unidad_negocio_id: un.id, nombre: 'Queso muzzarella',  categoria: 'Lácteos',     unidad_medida: 'kg',     costo_unitario: 9000, stock_actual: 4,   stock_minimo: 2,  activo: true },
    { unidad_negocio_id: un.id, nombre: 'Cebolla',           categoria: 'Verdulería',  unidad_medida: 'kg',     costo_unitario: 1400, stock_actual: 6,   stock_minimo: 3,  activo: true },
    { unidad_negocio_id: un.id, nombre: 'Acelga',            categoria: 'Verdulería',  unidad_medida: 'kg',     costo_unitario: 1800, stock_actual: 4,   stock_minimo: 2,  activo: true },
    { unidad_negocio_id: un.id, nombre: 'Huevo',             categoria: 'Almacén',     unidad_medida: 'unidad', costo_unitario: 250,  stock_actual: 60,  stock_minimo: 24, activo: true },
    { unidad_negocio_id: un.id, nombre: 'Aceite',            categoria: 'Almacén',     unidad_medida: 'l',      costo_unitario: 2800, stock_actual: 5,   stock_minimo: 2,  activo: true },
    { unidad_negocio_id: un.id, nombre: 'Sal fina',          categoria: 'Almacén',     unidad_medida: 'kg',     costo_unitario: 900,  stock_actual: 3,   stock_minimo: 1,  activo: true },
    { unidad_negocio_id: un.id, nombre: 'Bandeja de cartón', categoria: 'Packaging',   unidad_medida: 'unidad', costo_unitario: 180,  stock_actual: 100, stock_minimo: 30, activo: true },
  ]);

  await db.from('trabajadora').insert([
    { unidad_negocio_id: un.id, nombre: 'Ana',   tarifa_dia: 5000, activa: true },
    { unidad_negocio_id: un.id, nombre: 'María', tarifa_dia: 5000, activa: true },
  ]);

  return un;
}
