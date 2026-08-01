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
console.log('\n── QR del catálogo');

const qr = await import('../js/qr.js');

// Vector del estándar ISO/IEC 18004: los codewords de datos de "01234567" en
// versión 1-M y su corrección. Si la aritmética en GF(256) o el polinomio
// generador estuvieran mal, esto no da.
t('la corrección Reed-Solomon reproduce el ejemplo de la norma',
  JSON.stringify(qr.correccion(
    [0x10,0x20,0x0C,0x56,0x61,0x80,0xEC,0x11,0xEC,0x11,0xEC,0x11,0xEC,0x11,0xEC,0x11], 10,
  )) === JSON.stringify([0xA5,0x24,0xD4,0xC1,0xED,0x36,0xC7,0x87,0x2C,0x55]));

// Las cadenas de formato publicadas para nivel M, máscaras 0 a 7.
const FORMATOS_M = [
  '101010000010010', '101000100100101', '101111001111100', '101101101001011',
  '100010111111001', '100000011001110', '100111110010111', '100101010100000',
];
t('las 15 cadenas de información de formato son las de la tabla',
  FORMATOS_M.every((esperado, mascara) =>
    qr._paraTests.formato(mascara).toString(2).padStart(15, '0') === esperado));

t('la información de versión de la v7 es la de la tabla',
  qr._paraTests.infoVersion(7) === 0b000111110010010100);

t('elige la versión más chica donde entra',
  qr._paraTests.versionPara(new Array(14).fill(65)) === 1
  && qr._paraTests.versionPara(new Array(15).fill(65)) === 2);

let err2 = null;
try { qr.matriz('x'.repeat(300)); } catch (e) { err2 = e; }
t('un texto que no entra avisa en vez de generar un QR roto', !!err2);

const enlace = 'https://manos-libres.vercel.app/catalogo/';
const mqr = qr.matriz(enlace);
const n = mqr.length;

t('el lado corresponde a la versión', (n - 17) % 4 === 0 && n === 29);
t('los tres patrones de búsqueda están',
  mqr[0].slice(0, 7).every(Boolean)
  && mqr[0].slice(n - 7).every(Boolean)
  && mqr[n - 1].slice(0, 7).every(Boolean));
t('el patrón de sincronismo alterna',
  mqr[6].slice(8, n - 8).every((v, i) => v === (i % 2 === 0)));

// Este se me pasó la primera vez: la información de formato pisaba el módulo
// oscuro porque la segunda copia se parte 7 + 8, no 8 + 7.
t('el módulo oscuro queda encendido', mqr[n - 8][8] === true);

const bit = (f, c) => (mqr[f][c] ? '1' : '0');
const copia1 = [...Array(6).keys()].map((i) => bit(8, i))
  .concat([bit(8, 7), bit(8, 8), bit(7, 8)])
  .concat([...Array(6).keys()].map((i) => bit(5 - i, 8))).join('');
const copia2 = [...Array(7).keys()].map((i) => bit(n - 1 - i, 8))
  .concat([...Array(8).keys()].map((i) => bit(8, n - 8 + i))).join('');
t('las dos copias del formato dicen lo mismo', copia1 === copia2);

const densidad = mqr.flat().filter(Boolean).length * 100 / (n * n);
t('la densidad de módulos oscuros es sana', densidad > 40 && densidad < 60);

const svg = qr.svg(enlace);
t('el SVG sale bien formado', svg.startsWith('<svg') && svg.endsWith('</svg>'));
t('incluye la zona quieta de 4 módulos', svg.includes(`viewBox="0 0 ${n + 8} ${n + 8}"`));
t('dibuja todo en un solo path', (svg.match(/<path/g) || []).length === 1);

/* ================================================================== */
console.log(`\n${ok} pasaron · ${mal} fallaron`);
process.exit(mal ? 1 : 0);
