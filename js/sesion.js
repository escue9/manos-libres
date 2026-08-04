/**
 * sesion.js — la sesión de Supabase del dispositivo.
 *
 * Esto era la primera mitad de `nube.js`, cuando lo único que había en la nube
 * era el canal web y alcanzaba con una cuenta compartida que configuraba
 * administración. Con la Fase 5 §4.1 dejó de alcanzar: cada persona tiene su
 * usuario, el RLS filtra por `auth.uid()` y el rol viaja en el JWT. La sesión
 * pasó a ser de la PERSONA que usa el aparato, no del canal web, así que la
 * comparten el catálogo y el motor de datos del SO.
 *
 * Se guarda el refresh_token, nunca la contraseña. El access token vive solo en
 * memoria: si queda en disco, cualquiera que agarre el celular desbloqueado lo
 * lee, y dura una hora sin poder revocarse.
 *
 * PREMISA (§4.1): un dispositivo, una persona. En el CIC cada trabajadora usa
 * su propio celular. Por eso la sesión puede quedar guardada en el aparato y el
 * PIN pasa a desbloquearla en vez de ser la credencial. Si mañana hubiera un
 * celular compartido, esto hay que repensarlo entero.
 */

import { db } from './db.js';

/**
 * Las claves siguen diciendo `nube_` aunque el módulo ahora se llame sesión:
 * renombrarlas dejaría desconectada a la instalación que ya está andando, y una
 * cocina que abre la app y no encuentra el canal web no lee el changelog.
 */
const CLAVES = {
  url:     'nube_url',
  anon:    'nube_anon_key',
  email:   'nube_email',
  refresh: 'nube_refresh_token',
  /* Quién es la persona de esta sesión. Cacheado para poder validarla sin señal. */
  quien:   'nube_trabajadora_id',
  rol:     'nube_rol',
};

/** Se renueva un minuto antes de que venza, para no cortar una operación. */
const MARGEN_MS = 60_000;

/** Config leída de db, cacheada en memoria. */
let cfg = null;

/** { token, vence } — solo en memoria: un access token no se persiste. */
let sesion = null;

async function config() {
  if (cfg) return cfg;
  cfg = {
    url:     (await db.getConfig(CLAVES.url) || '').replace(/\/+$/, ''),
    anon:     await db.getConfig(CLAVES.anon) || '',
    email:    await db.getConfig(CLAVES.email) || '',
    refresh:  await db.getConfig(CLAVES.refresh) || '',
    quien:    await db.getConfig(CLAVES.quien) || '',
    rol:      await db.getConfig(CLAVES.rol) || '',
  };
  return cfg;
}

/** Que la próxima llamada relea de db. */
export const olvidar = () => { cfg = null; };

/* ------------------------------------------------------------------ */
/*  Tokens                                                             */
/* ------------------------------------------------------------------ */

async function guardarSesion(datos) {
  if (!datos?.access_token) throw new Error('Supabase no devolvió el token de acceso.');

  // Ojo con `|| 3600`: un expires_in de 0 es falsy y daría por bueno un token
  // ya vencido durante una hora.
  const seg = Number(datos.expires_in);
  sesion = {
    token: datos.access_token,
    vence: Date.now() + (Number.isFinite(seg) ? seg : 3600) * 1000,
  };
  if (datos.refresh_token) {
    await db.setConfig(CLAVES.refresh, datos.refresh_token);
    olvidar();
  }
}

async function pedirTokens(cuerpo, tipo) {
  const c = await config();
  const r = await fetch(`${c.url}/auth/v1/token?grant_type=${tipo}`, {
    method: 'POST',
    headers: { apikey: c.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(datos.error_description || datos.msg || `Supabase rechazó el login (${r.status}).`);
  }
  await guardarSesion(datos);
  return datos;
}

/** Un access token válido, renovándolo si hace falta. */
export async function token() {
  if (sesion && sesion.vence - MARGEN_MS > Date.now()) return sesion.token;

  const c = await config();
  if (!c.refresh) throw new Error('El canal web no está conectado.');

  await pedirTokens({ refresh_token: c.refresh }, 'refresh_token');
  return sesion.token;
}

/* ------------------------------------------------------------------ */
/*  Entrar y salir                                                     */
/* ------------------------------------------------------------------ */

/** A qué proyecto de Supabase apunta este dispositivo. */
export async function configurar({ url, anonKey }) {
  if (!url || !anonKey) throw new Error('Falta la URL o la anon key del proyecto.');
  await db.setConfig(CLAVES.url, String(url).replace(/\/+$/, ''));
  await db.setConfig(CLAVES.anon, anonKey);
  olvidar();
}

/**
 * Deja la sesión abierta en este dispositivo. La contraseña se usa acá y se
 * descarta: lo único que queda guardado es el refresh_token.
 *
 * No pide permiso de nada: esto ES el login. Quién puede hacer qué se decide
 * después, con el rol que viene en el token.
 */
export async function entrar({ email, password }) {
  if (!email || !password) throw new Error('Falta el usuario o la contraseña.');

  const c = await config();
  if (!c.url || !c.anon) throw new Error('Falta configurar el proyecto de Supabase.');

  await db.setConfig(CLAVES.email, email);
  await db.setConfig(CLAVES.refresh, '');
  olvidar();

  sesion = null;
  await pedirTokens({ email, password }, 'password');

  // Saber quién sos es deseable, no es la sesión. Si el proyecto todavía no
  // tiene la función —una instalación que solo usa el canal web, por ejemplo—
  // el login es válido igual y la identidad queda sin averiguar: el PIN manda
  // solo, como en las fases 0 a 4. Tumbar el login acá dejaría a la cocina sin
  // catálogo por una función que no le hace falta.
  try { await recordarQuienEs(); } catch { /* se reintenta la próxima vez */ }

  return true;
}

export async function salir() {
  await db.setConfig(CLAVES.refresh, '');
  await db.setConfig(CLAVES.quien, '');
  await db.setConfig(CLAVES.rol, '');
  olvidar();
  sesion = null;
}

export async function estado() {
  const c = await config();
  return {
    configurado: Boolean(c.url && c.anon),
    conectado: Boolean(c.url && c.anon && c.refresh),
    email: c.email,
    url: c.url,
    trabajadoraId: c.quien || null,
    rol: c.rol || null,
  };
}

/* ------------------------------------------------------------------ */
/*  REST                                                               */
/* ------------------------------------------------------------------ */

export async function pedir(ruta, { metodo = 'GET', cuerpo = null, prefer = null } = {}) {
  const c = await config();
  if (!c.url || !c.anon) throw new Error('El canal web no está configurado.');

  const cabeceras = {
    apikey: c.anon,
    Authorization: `Bearer ${await token()}`,
  };
  if (cuerpo) cabeceras['Content-Type'] = 'application/json';
  if (prefer) cabeceras.Prefer = prefer;

  const r = await fetch(`${c.url}/rest/v1/${ruta}`, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });

  if (!r.ok) {
    const texto = await r.text().catch(() => '');
    throw new Error(`Supabase respondió ${r.status}${texto ? `: ${texto}` : ''}`);
  }

  // Un DELETE o un update con return=minimal no traen cuerpo.
  if (r.status === 204) return null;
  return r.json().catch(() => null);
}

/* ------------------------------------------------------------------ */
/*  Quién es                                                           */
/* ------------------------------------------------------------------ */

/**
 * Le pregunta al servidor a qué persona corresponde esta sesión y lo cachea.
 *
 * El cache no es una optimización: es lo que hace que el control funcione sin
 * señal. La cocina del CIC se queda sin internet y el PIN tiene que seguir
 * abriendo la app (regla 3), así que la comparación de identidad se hace contra
 * lo último que dijo el servidor, no contra el servidor.
 */
export async function recordarQuienEs() {
  const filas = await pedir('rpc/quien_soy', { metodo: 'POST', cuerpo: {} });
  const yo = Array.isArray(filas) ? filas[0] : filas;

  await db.setConfig(CLAVES.quien, yo?.trabajadora_id || '');
  await db.setConfig(CLAVES.rol, yo?.rol || '');
  olvidar();
  return yo || null;
}

/**
 * Quién dijo el servidor que es esta sesión, según lo último que contestó.
 * Devuelve null si el dispositivo nunca se conectó: ahí el PIN manda solo,
 * como en las fases 0 a 4.
 */
export async function identidad() {
  const c = await config();
  if (!c.refresh) return null;
  return { trabajadoraId: c.quien || null, rol: c.rol || null, email: c.email };
}

export const _paraTests = { CLAVES, olvidar };
