/**
 * nube.js — el único punto por donde el SO habla con Supabase.
 *
 * OJO con la regla 1 de CLAUDE.md: `db.js` es la capa de datos del SO y en la
 * fase 5 se le cambia el motor por Supabase sin tocar los módulos. Esto es otra
 * cosa y por eso vive aparte: el canal web son dos tablas que están en la nube
 * *desde ahora* porque un cliente que abre el catálogo desde su celular no
 * puede escribir en el IndexedDB de la cocina. Producción, stock, jornadas y
 * caja siguen locales y no pasan por acá.
 *
 * Lo que se guarda de la sesión es el refresh_token, nunca la contraseña. La
 * contraseña la escribe la administración una vez y se usa para pedir el primer
 * par de tokens; de ahí en más se renueva sola.
 */

import { db } from './db.js';
import { auth } from './auth.js';

const CLAVES = {
  url:     'nube_url',
  anon:    'nube_anon_key',
  email:   'nube_email',
  refresh: 'nube_refresh_token',
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
  };
  return cfg;
}

/** Que la próxima llamada relea de db. */
const olvidar = () => { cfg = null; };

/* ------------------------------------------------------------------ */
/*  Sesión                                                             */
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

/**
 * Deja al SO conectado al canal web. La contraseña se usa acá y se descarta:
 * lo único que queda guardado es el refresh_token.
 */
export async function conectar({ url, anonKey, email, password }) {
  auth.exigir('gestionarCanalWeb');

  if (!url || !anonKey) throw new Error('Falta la URL o la anon key del proyecto.');
  if (!email || !password) throw new Error('Falta el usuario o la contraseña.');

  await db.setConfig(CLAVES.url, String(url).replace(/\/+$/, ''));
  await db.setConfig(CLAVES.anon, anonKey);
  await db.setConfig(CLAVES.email, email);
  await db.setConfig(CLAVES.refresh, '');
  olvidar();

  sesion = null;
  await pedirTokens({ email, password }, 'password');
  return true;
}

export async function desconectar() {
  auth.exigir('gestionarCanalWeb');
  await db.setConfig(CLAVES.refresh, '');
  olvidar();
  sesion = null;
}

/** Un access token válido, renovándolo si hace falta. */
async function token() {
  if (sesion && sesion.vence - MARGEN_MS > Date.now()) return sesion.token;

  const c = await config();
  if (!c.refresh) throw new Error('El canal web no está conectado.');

  await pedirTokens({ refresh_token: c.refresh }, 'refresh_token');
  return sesion.token;
}

export async function estado() {
  const c = await config();
  return {
    configurado: Boolean(c.url && c.anon),
    conectado: Boolean(c.url && c.anon && c.refresh),
    email: c.email,
    url: c.url,
  };
}

/** El link que se comparte a los clientes. */
export function enlacePublico(base = location?.origin || '') {
  return `${String(base).replace(/\/+$/, '')}/catalogo/`;
}

/* ------------------------------------------------------------------ */
/*  REST                                                               */
/* ------------------------------------------------------------------ */

async function pedir(ruta, { metodo = 'GET', cuerpo = null, prefer = null } = {}) {
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
/*  Catálogo                                                           */
/* ------------------------------------------------------------------ */

const CAMPOS = 'id,producto_id,nombre,descripcion,categoria,precio,unidad_venta,foto_url,orden,activo,updated_at';

/** Todo lo publicado, activo o no: la pantalla del SO muestra las dos cosas. */
export async function listarCatalogo() {
  auth.exigir('gestionarCanalWeb');
  return (await pedir(`catalogo_item?select=${CAMPOS}&order=categoria.asc,orden.asc`)) || [];
}

/**
 * Lo que se copia del producto del SO al catálogo. `producto_id` es la llave
 * para poder mapear el ítem al importar el pedido sin adivinar por nombre.
 *
 * El costo NO se copia: el catálogo es público y el costo es información
 * interna (regla 8).
 */
const desdeProducto = (producto, extra = {}) => ({
  producto_id: producto.id,
  nombre: producto.nombre,
  categoria: producto.categoria || null,
  precio: Number(producto.precio_venta) || 0,
  unidad_venta: producto.unidad_venta || 'unidad',
  ...extra,
});

/** Publica un producto del SO. Si ya estaba publicado, lo reactiva y actualiza. */
export async function publicar(producto, { descripcion = null, fotoUrl = null, orden = 0 } = {}) {
  auth.exigir('gestionarCanalWeb');
  if (!producto?.id) throw new Error('Falta el producto.');

  const fila = desdeProducto(producto, {
    descripcion, foto_url: fotoUrl, orden, activo: true,
  });

  // El índice único sobre producto_id hace que esto sea un alta o una
  // actualización según corresponda: tocar "publicar" dos veces no duplica.
  const [guardado] = await pedir('catalogo_item?on_conflict=producto_id', {
    metodo: 'POST',
    cuerpo: fila,
    prefer: 'resolution=merge-duplicates,return=representation',
  }) || [];

  return guardado;
}

/**
 * Saca un producto del catálogo público.
 *
 * Se desactiva, no se borra: un `pedido_web` viejo guarda el `catalogo_item_id`
 * de lo que se pidió, y borrarlo dejaría pedidos del buzón sin poder explicar
 * qué era lo que el cliente había elegido.
 */
export async function despublicar(catalogoItemId) {
  auth.exigir('gestionarCanalWeb');
  await pedir(`catalogo_item?id=eq.${encodeURIComponent(catalogoItemId)}`, {
    metodo: 'PATCH',
    cuerpo: { activo: false },
    prefer: 'return=minimal',
  });
}

export async function republicar(catalogoItemId) {
  auth.exigir('gestionarCanalWeb');
  await pedir(`catalogo_item?id=eq.${encodeURIComponent(catalogoItemId)}`, {
    metodo: 'PATCH',
    cuerpo: { activo: true },
    prefer: 'return=minimal',
  });
}

/**
 * Empuja los precios del SO al catálogo. Devuelve qué cambió, para poder
 * mostrarlo antes de que alguien se entere por un cliente.
 *
 * Va en un solo POST con merge-duplicates: veinte productos no son veinte
 * requests desde una conexión que se corta.
 */
export async function sincronizarPrecios(productos = []) {
  auth.exigir('gestionarCanalWeb');

  const publicados = await listarCatalogo();
  const porProducto = new Map(
    publicados.filter((i) => i.producto_id).map((i) => [i.producto_id, i]),
  );

  const cambios = [];
  for (const p of productos) {
    const item = porProducto.get(p.id);
    if (!item) continue;

    const precioNuevo = Number(p.precio_venta) || 0;
    if (Number(item.precio) === precioNuevo && item.nombre === p.nombre) continue;

    cambios.push({
      item,
      producto: p,
      precioAnterior: Number(item.precio),
      precioNuevo,
    });
  }

  if (cambios.length) {
    await pedir('catalogo_item?on_conflict=producto_id', {
      metodo: 'POST',
      cuerpo: cambios.map((c) => ({
        ...desdeProducto(c.producto),
        // Lo que edita la administración en el catálogo no se pisa con cada
        // sincronización: esto empuja precio y nombre, no la foto ni el texto.
        descripcion: c.item.descripcion,
        foto_url: c.item.foto_url,
        orden: c.item.orden,
        activo: c.item.activo,
      })),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  return cambios;
}

export const _paraTests = { CLAVES, olvidar };
