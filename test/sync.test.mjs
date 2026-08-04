/**
 * El replicador — Fase 5 §4.2.
 *
 * Nada de esto toca la red: `fetch` está interceptado y lo que se verifica es
 * QUÉ se le pidió a Supabase y cómo quedó IndexedDB después. Un Postgres de
 * mentira, con una tabla en memoria, alcanza para lo que hay que probar acá:
 * el orden, la idempotencia y quién gana cuando los dos lados tocaron la misma
 * fila. Las políticas de RLS se prueban contra el proyecto real, no desde acá.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { auth }     = await import('../js/auth.js');
const nube         = await import('../js/nube.js');
const sync         = await import('../js/sync.js');

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };
const tira = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* ------------------------------------------------------------------ */
/*  Postgres de mentira                                                */
/* ------------------------------------------------------------------ */

let llamadas = [];
/** tabla → Map(id → fila). El servidor. */
const remoto = new Map();

const tablaDe = (u) => (u.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];
const filasDe = (tabla) => remoto.get(tabla) || remoto.set(tabla, new Map()).get(tabla);

globalThis.fetch = async (url, opciones = {}) => {
  const u = String(url);
  const metodo = opciones.method || 'GET';
  const cuerpo = opciones.body ? JSON.parse(opciones.body) : null;
  llamadas.push({ url: u, metodo, cuerpo });

  if (u.includes('/auth/v1/token')) {
    return new Response(JSON.stringify({
      access_token: 'token', refresh_token: 'refresh', expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (u.includes('/rest/v1/rpc/quien_soy')) {
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const tabla = tablaDe(u);
  if (!tabla) return new Response('no esperado', { status: 500 });
  const filas = filasDe(tabla);

  if (metodo === 'POST') {
    for (const f of (Array.isArray(cuerpo) ? cuerpo : [cuerpo])) filas.set(f.id, f);
    return new Response(null, { status: 204 });
  }

  if (metodo === 'DELETE') {
    const ids = (u.match(/id=in\.\(([^)]*)\)/) || [])[1] || '';
    for (const id of ids.split(',')) filas.delete(id.replace(/"/g, ''));
    return new Response(null, { status: 204 });
  }

  /* GET con el corte por updated_at */
  const desde = decodeURIComponent((u.match(/updated_at=gt\.([^&]+)/) || [])[1] || '');
  const salida = [...filas.values()]
    .filter((f) => !desde || (f.updated_at || '') > desde)
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
  return new Response(JSON.stringify(salida), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const pedidosA = (tabla, metodo) =>
  llamadas.filter((l) => tablaDe(l.url) === tabla && l.metodo === metodo);
const limpiar = () => { llamadas = []; };

await seed();
auth.rol = 'admin';
await nube.conectar({
  url: 'https://prueba.supabase.co', anonKey: 'anon',
  email: 'cocina@test', password: 'x',
});

/* ================================================================== */
console.log('\n── la primera vuelta sube lo que ya había');

limpiar();
let r = await sync.sincronizar();

t('subió filas', r.subidas > 0);
t('el insumo llegó al servidor', filasDe('insumo').size > 0);
t('y el producto también', filasDe('producto').size > 0);
t('config NO viaja: ahí está el PIN de administración', !remoto.has('config'));
t('no manda sync_status, que es del dispositivo',
  pedidosA('insumo', 'POST').every((l) => l.cuerpo.every((f) => !('sync_status' in f))));

const ordenSubida = llamadas.filter((l) => l.metodo === 'POST' && tablaDe(l.url))
  .map((l) => tablaDe(l.url));
t('la trabajadora sube antes que el pedido que la referencia',
  ordenSubida.indexOf('trabajadora') < ordenSubida.indexOf('pedido')
  || !ordenSubida.includes('pedido'));

/* ================================================================== */
console.log('\n── lo que ya subió no vuelve a subir');

limpiar();
r = await sync.sincronizar();
t('la segunda vuelta no sube nada', r.subidas === 0);
t('y no hace ni un POST de más', pedidosA('insumo', 'POST').length === 0);

const insumo = await db.from('insumo').select().limit(1).single();
t('las filas quedaron marcadas como sincronizadas', insumo.sync_status === 'sincronizado');
t('y marcar no les movió el updated_at',
  insumo.updated_at === (filasDe('insumo').get(insumo.id) || {}).updated_at);

/* ================================================================== */
console.log('\n── un cambio local vuelve a salir');

await db.from('insumo').update({ stock_actual: 999 }).eq('id', insumo.id);
const pend = await sync.pendientes();
t('el cambio queda pendiente', pend.filas === 1);

limpiar();
r = await sync.sincronizar();
t('y sube en la vuelta siguiente', r.subidas === 1);
t('con el valor nuevo', filasDe('insumo').get(insumo.id).stock_actual === 999);

/* ================================================================== */
console.log('\n── lo que cambió en la nube baja');

const otroDispositivo = {
  ...filasDe('insumo').get(insumo.id),
  stock_actual: 42,
  updated_at: new Date(Date.now() + 60_000).toISOString(),
};
filasDe('insumo').set(insumo.id, otroDispositivo);

await sync.sincronizar();
const bajado = await db.from('insumo').select().eq('id', insumo.id).single();
t('el stock de la otra compu llegó acá', bajado.stock_actual === 42);
t('y no quedó marcado como pendiente', bajado.sync_status === 'sincronizado');

/* ================================================================== */
console.log('\n── quién gana cuando los dos tocaron la misma fila');

// El local es MÁS NUEVO que lo que hay en el servidor.
await db.from('insumo').update({ stock_actual: 7 }).eq('id', insumo.id);
filasDe('insumo').set(insumo.id, {
  ...filasDe('insumo').get(insumo.id),
  stock_actual: 1,
  updated_at: '2020-01-01T00:00:00.000Z',
});

await sync.sincronizar();
const ganador = await db.from('insumo').select().eq('id', insumo.id).single();
t('gana el updated_at más nuevo, que acá es el local', ganador.stock_actual === 7);

/* ================================================================== */
console.log('\n── borrar sin señal');

const cliente = await db.from('cliente').insert({ nombre: 'Se va a borrar' });
await sync.sincronizar();
t('el cliente subió', filasDe('cliente').has(cliente.id));

await db.from('cliente').delete().eq('id', cliente.id);
t('el borrado dejó lápida', (await sync.pendientes()).borrados === 1);

limpiar();
r = await sync.sincronizar();
t('el borrado viajó', !filasDe('cliente').has(cliente.id));
t('se pidió un DELETE de verdad', pedidosA('cliente', 'DELETE').length === 1);
t('y la lápida se levantó', (await sync.pendientes()).borrados === 0);

await sync.sincronizar();
t('no se reintenta un borrado ya hecho', (await sync.pendientes()).borrados === 0);

/* ================================================================== */
console.log('\n── el pull no revive lo que se borró');

const vivos = await db.from('cliente').select().eq('id', cliente.id);
t('el cliente borrado no volvió con el pull', vivos.length === 0);

/* ================================================================== */
console.log('\n── sin sesión no sincroniza');

await nube.desconectar();
const err = await tira(() => sync.sincronizar());
t('avisa en vez de romper', /no tiene sesión/.test(err?.message || ''));

/* ================================================================== */
console.log(`\n${ok} pasaron · ${mal} fallaron`);
process.exit(mal ? 1 : 0);
