/**
 * nube.js — el canal web contra Supabase: catálogo público y buzón de pedidos.
 *
 * OJO con la regla 1 de CLAUDE.md: `db.js` es la capa de datos del SO y en la
 * fase 5 se le cambia el motor por Supabase sin tocar los módulos. Esto es otra
 * cosa y por eso vive aparte: el canal web son dos tablas que están en la nube
 * *desde antes* porque un cliente que abre el catálogo desde su celular no
 * puede escribir en el IndexedDB de la cocina.
 *
 * La sesión ya no vive acá. Se mudó a `sesion.js` cuando dejó de ser "la cuenta
 * con la que el SO publica el catálogo" para ser la de la persona que usa el
 * dispositivo (Fase 5 §4.1): ahora la comparten el canal web y el motor de
 * datos, y no tendría sentido que el catálogo fuera dueño del login de todos.
 */

import { auth } from './auth.js';
import * as sesion from './sesion.js';

const { pedir } = sesion;

/**
 * Deja al SO conectado al canal web.
 *
 * Sigue pidiendo permiso de administración aunque por debajo sea el login de la
 * sesión: elegir a qué proyecto de Supabase apunta la cocina no es algo que se
 * haga desde el celular de alguien que vino a vender empanadas.
 */
export async function conectar({ url, anonKey, email, password }) {
  auth.exigir('gestionarCanalWeb');

  await sesion.configurar({ url, anonKey });
  await sesion.entrar({ email, password });
  return true;
}

export async function desconectar() {
  auth.exigir('gestionarCanalWeb');
  await sesion.salir();
}

export const estado = sesion.estado;

/** El link que se comparte a los clientes. */
export function enlacePublico(base = location?.origin || '') {
  return `${String(base).replace(/\/+$/, '')}/catalogo/`;
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

/* ------------------------------------------------------------------ */
/*  Buzón de pedidos                                                   */
/* ------------------------------------------------------------------ */

const CAMPOS_PEDIDO = 'id,creado_at,nombre,telefono,modo_entrega,direccion,'
  + 'fecha_deseada,notas,items,total,estado,pedido_id,procesado_at';

/** Lo que está esperando que alguien lo mire. Más viejo primero. */
export async function bandeja() {
  auth.exigir('gestionarCanalWeb');
  return (await pedir(`pedido_web?select=${CAMPOS_PEDIDO}&estado=eq.nuevo&order=creado_at.asc`)) || [];
}

/** Cuántos hay sin revisar, para el badge. Barato: no baja los pedidos. */
export async function cuantosNuevos() {
  if (!auth.puede('gestionarCanalWeb')) return 0;
  const est = await estado();
  if (!est.conectado) return 0;

  try {
    return (await pedir('pedido_web?select=id&estado=eq.nuevo') || []).length;
  } catch {
    // Sin señal el badge no aparece, pero la pantalla de pedidos abre igual.
    return 0;
  }
}

/**
 * Marca el pedido del buzón como importado.
 *
 * El filtro incluye `estado=eq.nuevo` a propósito: si otra persona lo importó
 * mientras esta lo revisaba, el update no toca ninguna fila y devolvemos false
 * en vez de pisar el pedido que ya se creó. El buzón es compartido y la cocina
 * tiene más de un dispositivo.
 */
export async function marcarImportado(pedidoWebId, pedidoId) {
  auth.exigir('gestionarCanalWeb');
  if (!pedidoId) throw new Error('Falta el pedido del SO al que se importó');

  const filas = await pedir(
    `pedido_web?id=eq.${encodeURIComponent(pedidoWebId)}&estado=eq.nuevo`,
    {
      metodo: 'PATCH',
      cuerpo: { estado: 'importado', pedido_id: pedidoId, procesado_at: new Date().toISOString() },
      prefer: 'return=representation',
    },
  );
  return Array.isArray(filas) && filas.length > 0;
}

/** Descartar no borra: si mañana el cliente reclama, el pedido tiene que estar. */
export async function marcarDescartado(pedidoWebId, motivo = '') {
  auth.exigir('gestionarCanalWeb');

  const filas = await pedir(
    `pedido_web?id=eq.${encodeURIComponent(pedidoWebId)}&estado=eq.nuevo`,
    {
      metodo: 'PATCH',
      cuerpo: {
        estado: 'descartado',
        procesado_at: new Date().toISOString(),
        motivo_descarte: String(motivo || '').trim() || null,
      },
      prefer: 'return=representation',
    },
  );
  return Array.isArray(filas) && filas.length > 0;
}

export const _paraTests = sesion._paraTests;
