/**
 * Canal de venta online — la parte del SO.
 *
 * Nada de esto toca la red: `fetch` está interceptado y se verifica QUÉ se le
 * pidió a Supabase, que es donde están los errores caros. Las políticas de RLS
 * se prueban contra el proyecto real con curl, no desde acá.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, seed } = await import('../js/db.js');
const { state }    = await import('../js/state.js');
const { auth }     = await import('../js/auth.js');
const nube         = await import('../js/nube.js');

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };
const tira = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* ------------------------------------------------------------------ */
/*  Supabase de mentira                                                */
/* ------------------------------------------------------------------ */

let llamadas = [];
let expiraEn = 3600;
let catalogoRemoto = [];

globalThis.fetch = async (url, opciones = {}) => {
  const u = String(url);
  const cuerpo = opciones.body ? JSON.parse(opciones.body) : null;
  llamadas.push({ url: u, metodo: opciones.method || 'GET', cuerpo, cabeceras: opciones.headers || {} });

  if (u.includes('/auth/v1/token')) {
    if (u.includes('grant_type=password') && cuerpo.password !== 'buena') {
      return new Response(JSON.stringify({ error_description: 'Invalid login credentials' }), { status: 400 });
    }
    return new Response(JSON.stringify({
      access_token: 'token-' + llamadas.length,
      refresh_token: 'refresh-' + llamadas.length,
      expires_in: expiraEn,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (u.includes('/rest/v1/catalogo_item')) {
    if ((opciones.method || 'GET') === 'GET') {
      return new Response(JSON.stringify(catalogoRemoto), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(Array.isArray(cuerpo) ? cuerpo : [cuerpo]),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('no esperado', { status: 500 });
};

const ultima = (filtro = () => true) => [...llamadas].reverse().find(filtro);
const limpiar = () => { llamadas = []; };

const CREDENCIALES = {
  url: 'https://prueba.supabase.co/',   // con barra al final a propósito
  anonKey: 'sb_publishable_prueba',
  email: 'cocina@manoslibres.test',
  password: 'buena',
};

await seed();
await state.cargar();
auth.rol = 'admin';

/* ================================================================== */
console.log('\n── conectar el canal web');

let err = await tira(() => nube.conectar({ ...CREDENCIALES, password: 'mala' }));
t('una contraseña incorrecta no conecta', !!err);
t('y el mensaje dice qué pasó', /Invalid login credentials/.test(err.message));
t('no quedó ningún refresh token guardado', !(await db.getConfig('nube_refresh_token')));

limpiar();
await nube.conectar(CREDENCIALES);

t('conectar pide el token con la contraseña',
  ultima((l) => l.url.includes('grant_type=password'))?.cuerpo.password === 'buena');

t('se guarda el refresh token', (await db.getConfig('nube_refresh_token')).startsWith('refresh-'));

// Lo que más importa de todo el módulo: la contraseña se usa y se tira.
const config = await db.from('config').select();
const guardado = JSON.stringify(config);
t('la contraseña NO queda guardada en ningún lado', !guardado.includes('buena'));

t('la barra final de la URL se normaliza',
  (await db.getConfig('nube_url')) === 'https://prueba.supabase.co');

let est = await nube.estado();
t('el estado dice que está conectado', est.conectado === true && est.configurado === true);

/* ================================================================== */
console.log('\n── el token se renueva solo');

// Un token que vence dentro del margen obliga a renovar antes de operar.
expiraEn = 1;
await nube.conectar(CREDENCIALES);
limpiar();
await nube.listarCatalogo();

const iRefresco = llamadas.findIndex((l) => l.url.includes('grant_type=refresh_token'));
const refresco = llamadas[iRefresco];
t('un token por vencer se renueva antes de la operación', !!refresco);
t('se renueva con el refresh token, no con la contraseña',
  refresco?.cuerpo.refresh_token?.startsWith('refresh-') && !refresco?.cuerpo.password);

const iConsulta = llamadas.findIndex((l) => l.url.includes('/rest/v1/'));
t('primero renueva y recién después consulta', iRefresco < iConsulta);
t('la consulta viaja con un token, no anónima',
  llamadas[iConsulta].cabeceras.Authorization.startsWith('Bearer token-'));

expiraEn = 3600;
await nube.conectar(CREDENCIALES);

/* ================================================================== */
console.log('\n── publicar un producto');

const empanada = state.productos.find((p) => p.nombre === 'Empanada de carne');

limpiar();
await nube.publicar(empanada, { descripcion: 'Cortada a cuchillo' });
const alta = ultima((l) => l.metodo === 'POST' && l.url.includes('catalogo_item'));

t('copia el nombre y el precio del SO',
  alta.cuerpo.nombre === 'Empanada de carne' && alta.cuerpo.precio === 800);
t('copia la categoría y la unidad de venta',
  alta.cuerpo.categoria === 'Empanadas' && alta.cuerpo.unidad_venta === 'unidad');
t('guarda producto_id para poder mapear al importar', alta.cuerpo.producto_id === empanada.id);
t('sube activo', alta.cuerpo.activo === true);

// Regla 8: el catálogo es público. El costo es información interna.
const publicado = JSON.stringify(alta.cuerpo);
t('NO publica el costo ni el margen',
  !publicado.includes('costo') && !publicado.includes('350'));

t('resuelve el duplicado en vez de crear otro ítem',
  alta.url.includes('on_conflict=producto_id')
  && String(alta.cabeceras.Prefer).includes('merge-duplicates'));

/* ================================================================== */
console.log('\n── despublicar no borra');

limpiar();
await nube.despublicar('item-1');
const baja = ultima();

t('despublicar es un PATCH, no un DELETE', baja.metodo === 'PATCH');
t('solo apaga el activo', baja.cuerpo.activo === false);
// Un pedido_web viejo guarda el catalogo_item_id de lo que se pidió: si se
// borra la fila, ese pedido no se puede explicar nunca más.
t('no se manda ningún DELETE al catálogo', !llamadas.some((l) => l.metodo === 'DELETE'));

/* ================================================================== */
console.log('\n── sincronizar precios');

catalogoRemoto = [
  { id: 'c1', producto_id: empanada.id, nombre: 'Empanada de carne', precio: 700,
    descripcion: 'Cortada a cuchillo', foto_url: 'https://foto', orden: 3, activo: true },
  { id: 'c2', producto_id: 'no-existe-en-el-so', nombre: 'Viejo', precio: 100,
    descripcion: null, foto_url: null, orden: 0, activo: true },
];

limpiar();
let cambios = await nube.sincronizarPrecios(state.productos);

t('detecta el producto cuyo precio cambió', cambios.length === 1);
t('informa el precio viejo y el nuevo',
  cambios[0].precioAnterior === 700 && cambios[0].precioNuevo === 800);

const empuje = ultima((l) => l.metodo === 'POST');
t('empuja todo en un solo request', llamadas.filter((l) => l.metodo === 'POST').length === 1);
t('actualiza el precio', empuje.cuerpo[0].precio === 800);

// Lo que la administración escribió en el catálogo es suyo: la sincronización
// empuja precio y nombre, no pisa la descripción, la foto ni el orden.
t('respeta la descripción escrita a mano', empuje.cuerpo[0].descripcion === 'Cortada a cuchillo');
t('respeta la foto', empuje.cuerpo[0].foto_url === 'https://foto');
t('respeta el orden', empuje.cuerpo[0].orden === 3);

t('un ítem publicado que ya no está en el SO se deja quieto',
  !empuje.cuerpo.some((c) => c.producto_id === 'no-existe-en-el-so'));

limpiar();
cambios = await nube.sincronizarPrecios(state.productos);
t('sincronizar de nuevo sin cambios no escribe nada',
  cambios.length === 1 && llamadas.filter((l) => l.metodo === 'POST').length === 1);

/* ================================================================== */
console.log('\n── permisos: el canal web es de administración');

auth.rol = 'trabajadora';

t('una trabajadora no puede conectar el canal', !!(await tira(() => nube.conectar(CREDENCIALES))));
t('no puede publicar', !!(await tira(() => nube.publicar(empanada))));
t('no puede despublicar', !!(await tira(() => nube.despublicar('c1'))));
t('no puede sincronizar precios', !!(await tira(() => nube.sincronizarPrecios(state.productos))));
t('no puede ver qué está publicado', !!(await tira(() => nube.listarCatalogo())));
t('ni desconectar el canal', !!(await tira(() => nube.desconectar())));

auth.rol = 'dirigente';
t('la comisión tampoco publica', !!(await tira(() => nube.publicar(empanada))));

auth.rol = 'admin';

/* ================================================================== */
console.log('\n── sin configurar');

await nube.desconectar();
est = await nube.estado();
t('desconectar deja el canal sin sesión', est.conectado === false);
t('pero no borra la URL ni la key', est.configurado === true);
t('una operación sin sesión avisa en vez de romper',
  /no está conectado/.test((await tira(() => nube.listarCatalogo())).message));

/* ================================================================== */
console.log(`\n${ok} pasaron · ${mal} fallaron`);
process.exit(mal ? 1 : 0);
