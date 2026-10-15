/**
 * El alta de un celular del equipo — «¿Quién usa este celular?».
 *
 * Un celular nuevo antes creaba un PIN de administración sin preguntar. Ahora
 * la persona del equipo entra una vez con mail y contraseña, el servidor dice
 * quién es (`quien_soy`) y el PIN que elige queda en config del aparato, no en
 * su fila: el servidor no la deja escribirla y el salt de la PC es otro.
 *
 * `fetch` está interceptado: lo que se prueba es qué queda guardado y quién
 * entra con qué PIN, no Supabase.
 */

import "fake-indexeddb/auto";
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { db, puestaEnMarcha } = await import('../js/db.js');
const { auth }  = await import('../js/auth.js');
const sesion    = await import('../js/sesion.js');

let ok = 0, mal = 0;
const t = (nombre, cond) => { cond ? (ok++, console.log('  ✓', nombre))
                                   : (mal++, console.log('  ✗', nombre)); };
const tira = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const ROCIO = '11111111-1111-4111-8111-111111111111';

/** Lo que contesta `quien_soy` y si la contraseña es buena. */
let yo = [];
let claveBuena = true;
let urlsPedidas = [];

const json = (cuerpo, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url) => {
  const u = String(url);
  urlsPedidas.push(u);
  if (u.includes('/auth/v1/token')) {
    return claveBuena
      ? json({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600 })
      : json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400);
  }
  if (u.includes('/rest/v1/rpc/quien_soy')) return json(yo);
  return json([]);
};

await puestaEnMarcha();

console.log('\n── primer arranque');
t('un celular nuevo no está listo', await auth.dispositivoListo() === false);

console.log('\n── vincular: lo que se rechaza');
claveBuena = false;
let e = await tira(() => auth.vincularDispositivo({ email: 'escue9+rocio@gmail.com', password: 'mal' }));
t('contraseña mala tira', /Invalid login credentials/.test(e?.message || ''));
t('y no deja sesión', (await sesion.estado()).conectado === false);

claveBuena = true;
yo = [];
e = await tira(() => auth.vincularDispositivo({ email: 'nadie@x.com', password: 'x' }));
t('cuenta sin persona del equipo tira', /no está asociada/.test(e?.message || ''));
t('y cierra la sesión que abrió', (await sesion.estado()).conectado === false);

yo = [{ trabajadora_id: ROCIO, nombre: 'Rocío', rol: 'inactiva' }];
e = await tira(() => auth.vincularDispositivo({ email: 'escue9+rocio@gmail.com', password: 'x' }));
t('cuenta dada de baja tira', /dada de baja/.test(e?.message || ''));

console.log('\n── vincular: Rocío');
yo = [{ trabajadora_id: ROCIO, nombre: 'Rocío', rol: 'trabajadora' }];
urlsPedidas = [];
const v = await auth.vincularDispositivo({ email: '  Escue9+Rocio@Gmail.com ', password: 'buena' });
t('devuelve quién es', v.rol === 'trabajadora' && v.trabajadoraId === ROCIO && v.nombre === 'Rocío');
t('usa el proyecto precargado', urlsPedidas.every((u) => u.startsWith(sesion.PROYECTO.url)));
const est = await sesion.estado();
t('queda conectado', est.conectado);
t('el mail se guarda en minúscula y sin espacios', est.email === 'escue9+rocio@gmail.com');
t('la contraseña no se guarda', !JSON.stringify(await db.from('config').select()).includes('buena'));

console.log('\n── el PIN del dispositivo');
await auth.crearPinDispositivo('2580', v);
t('ahora el celular está listo', await auth.dispositivoListo() === true);
t('no crea PIN de administración', await auth.hayAdmin() === false);
t('el PIN no va a la fila de nadie', (await db.from('trabajadora').select()).every((f) => !f.pin_acceso));

t('PIN incorrecto rechaza', await auth.ingresar('1111') === null);
const s = await auth.ingresar('2580');
t('PIN correcto entra como trabajadora', s?.rol === 'trabajadora' && auth.rol === 'trabajadora');
t('con su id', auth.trabajadoraId === ROCIO);
t('y su nombre, aunque su fila no haya bajado', auth.nombre === 'Rocío');
t('no ve la caja', !auth.puedeVer('caja') && !auth.puede('verCostos'));
auth.salir();

await db.from('trabajadora').insert({ id: ROCIO, nombre: 'Rocío Pérez', activa: true });
await auth.ingresar('2580');
t('si la fila bajó, el nombre sale de la fila', auth.nombre === 'Rocío Pérez');
auth.salir();

console.log('\n── si administración la da de baja');
yo = [{ trabajadora_id: ROCIO, nombre: 'Rocío', rol: 'inactiva' }];
await sesion.recordarQuienEs();
e = await tira(() => auth.ingresar('2580'));
t('el PIN bueno ya no entra', /dada de baja/.test(e?.message || ''));
t('y no queda sesión', auth.rol === null);

console.log('\n── un celular nuevo de administración');
t('rol admin usa el PIN de administración', await (async () => {
  await auth.crearPinDispositivo('7410', { rol: 'admin', trabajadoraId: 'x', nombre: 'Juan Martín' });
  return (await auth.hayAdmin()) && (await db.getConfig('admin_nombre')) === 'Juan Martín';
})());

e = await tira(() => auth.crearPinDispositivo('12', v));
t('un PIN de dos dígitos tira', /4 dígitos/.test(e?.message || ''));
e = await tira(() => auth.crearPinDispositivo('1234', { ...v, rol: 'jefa' }));
t('un rol inventado tira', /Rol desconocido/.test(e?.message || ''));

console.log(`\n${ok} ok · ${mal} mal\n`);
process.exit(mal ? 1 : 0);
