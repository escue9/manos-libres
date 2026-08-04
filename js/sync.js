/**
 * sync.js — el espejo entre la cocina y la nube.
 *
 * QUÉ ES Y QUÉ NO ES. `CLAUDE.md` dice que en la fase 5 "se cambia la
 * implementación interna de db.js por el cliente de Supabase". Escrito así no
 * se puede: la regla 3 dice que la app abre y funciona sin internet SIEMPRE, y
 * un db.js que sea un cliente REST no abre en la cocina del CIC un día de
 * lluvia. Las dos reglas no pueden ser ciertas a la vez.
 *
 * Gana la 3, que es la que decide si la app se usa o no. IndexedDB sigue siendo
 * la fuente de verdad del dispositivo y Postgres es el espejo — que es, además,
 * lo que ya decía la cabecera de la migración del esquema. Entonces esto no es
 * un motor nuevo adentro de db.js: es un replicador al lado.
 *
 * La regla 1 se cumple igual, y mejor: los módulos siguen escribiendo
 * `db.from('pedido').insert(...)` sin enterarse de que existe un servidor. Solo
 * que no se enteran nunca, en vez de no enterarse porque adentro cambió el
 * motor.
 *
 * CÓMO. Cada fila que se escribe queda con `sync_status: 'local'` —eso db.js lo
 * viene haciendo desde la fase 0— y cada borrado deja una lápida. Empujar es
 * mandar eso; traer es pedir lo que cambió desde la última vez. Gana el
 * `updated_at` más nuevo.
 *
 * LO QUE ESTE DISEÑO NO RESUELVE, dicho de frente: un borrado hecho en OTRO
 * dispositivo no se entera acá. El pull pregunta "qué cambió", y una fila
 * borrada no cambió: no está. Para una cocina donde los borrados son raros
 * —anular un pedido, sacar un insumo mal cargado— y donde el dispositivo que
 * borra es el que tiene el dato adelante, alcanza. La salida completa es
 * borrado lógico en las 18 tablas, y eso ensucia cada consulta del sistema para
 * resolver un caso que pasa una vez por mes.
 */

import { db, TABLES } from './db.js';
import * as sesion from './sesion.js';

/**
 * En qué orden se empuja. Importa, y mucho: son claves foráneas.
 *
 * No es el orden de TABLES porque ahí `trabajadora` cae después de `pedido`, y
 * `pedido.created_by` la referencia. Subir un pedido antes que la persona que
 * lo cargó es un 409 y una cola que no avanza nunca.
 *
 * `config` NO ESTÁ, y no es un olvido: ahí viven el hash del PIN de
 * administración, el salt y el refresh token de este dispositivo. Sincronizar
 * config sería publicar las credenciales de la cocina en una tabla que
 * cualquiera del equipo puede leer.
 */
export const ORDEN = [
  'unidad_negocio',
  'trabajadora',
  'tarifa_historica',
  'insumo',
  'producto',
  'receta_item',
  'compra_insumo',
  'cliente',
  'orden_produccion',
  'produccion_item',
  'pedido',
  'pedido_item',
  'cobro',
  'jornada',
  'movimiento_stock_insumo',
  'movimiento_stock_producto',
  'movimiento_caja',
];

/** Para borrar hay que ir al revés: primero los hijos. */
const ORDEN_BORRADO = [...ORDEN].reverse();

/**
 * De dónde se LEE cada tabla. Escribir sigue yendo derecho a la tabla.
 *
 * Estas cinco tienen columnas de costo, y desde 20260806_costos_ocultos.sql el
 * `select *` sobre ellas devuelve 42501 para todo el mundo —administración
 * incluida—, justamente para que nadie lea de la tabla sin querer. La vista
 * devuelve la fila completa con el costo en null si quien pregunta no puede
 * verlo, así que el replicador no necesita saber qué rol tiene: baja lo que le
 * corresponda y listo.
 *
 * Ese null que baja es inofensivo gracias a las guardas del §4.3: cuando este
 * dispositivo devuelva la fila con el costo en null, el servidor conserva el
 * que ya tenía.
 */
const VISTA = {
  insumo: 'insumo_v',
  producto: 'producto_v',
  pedido_item: 'pedido_item_v',
  produccion_item: 'produccion_item_v',
  orden_produccion: 'orden_produccion_v',
};

/** Desde cuándo pedir cambios, por tabla. */
const CLAVE_ULTIMO = (tabla) => `sync_ultimo_${tabla}`;

/**
 * Lo que no viaja: es del dispositivo, no de la fila.
 * Si `sync_status` subiera, Postgres respondería 400 por columna inexistente.
 */
const LOCALES = ['sync_status'];

const paraServidor = (fila) => {
  const limpia = { ...fila };
  for (const k of LOCALES) delete limpia[k];
  return limpia;
};

/** De a tandas: veinte pedidos no son veinte requests desde una conexión mala. */
const TANDA = 200;

const enTandas = (filas) => {
  const tandas = [];
  for (let i = 0; i < filas.length; i += TANDA) tandas.push(filas.slice(i, i + TANDA));
  return tandas;
};

/* ------------------------------------------------------------------ */
/*  Empujar                                                            */
/* ------------------------------------------------------------------ */

/**
 * Sube lo pendiente de una tabla.
 *
 * `merge-duplicates` y no un insert a secas: la misma fila puede haberse subido
 * ya desde otro lado, o el push anterior puede haber llegado justo antes de que
 * se cortara la respuesta. Un upsert idempotente convierte "no sé si llegó" en
 * "mandalo de nuevo y listo", que es la única forma sana de sincronizar sobre
 * una conexión que se corta.
 */
async function empujarTabla(tabla) {
  const pendientes = await db._sync.pendientes(tabla);
  if (!pendientes.length) return 0;

  for (const tanda of enTandas(pendientes)) {
    await sesion.pedir(`${tabla}?on_conflict=id`, {
      metodo: 'POST',
      cuerpo: tanda.map(paraServidor),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    await db._sync.marcarSincronizadas(tabla, tanda.map((f) => f.id));
  }

  return pendientes.length;
}

/**
 * Manda los borrados.
 *
 * Un 404 o una fila que ya no está no son un error: el objetivo era que no
 * exista y no existe. La lápida se levanta igual, porque si no queda
 * reintentándose para siempre.
 */
async function empujarBorrados() {
  const lapidas = await db._sync.lapidas();
  if (!lapidas.length) return 0;

  const listas = [];
  for (const tabla of ORDEN_BORRADO) {
    const suyas = lapidas.filter((l) => l.tabla === tabla);
    if (!suyas.length) continue;

    for (const tanda of enTandas(suyas)) {
      const ids = tanda.map((l) => `"${l.fila_id}"`).join(',');
      try {
        await sesion.pedir(`${tabla}?id=in.(${ids})`, {
          metodo: 'DELETE',
          prefer: 'return=minimal',
        });
        listas.push(...tanda.map((l) => l.id));
      } catch (e) {
        // Un borrado que el servidor rechaza —una FK que todavía cuelga— se
        // reintenta la próxima vuelta, cuando el hijo ya se haya ido.
        if (!/409|violates foreign key/i.test(e.message)) throw e;
      }
    }
  }

  await db._sync.olvidarLapidas(listas);
  return listas.length;
}

/* ------------------------------------------------------------------ */
/*  Traer                                                             */
/* ------------------------------------------------------------------ */

/**
 * Baja lo que cambió desde la última vez.
 *
 * El corte es `updated_at > ultimo`, con el `updated_at` que pone POSTGRES y no
 * el del dispositivo: los relojes de los celulares no están en hora, y un
 * teléfono adelantado media hora se saltearía todo lo que entre mientras tanto.
 * Por eso el marcador se guarda con el valor que vino en las filas, no con
 * Date.now().
 */
async function traerTabla(tabla) {
  const desde = await db.getConfig(CLAVE_ULTIMO(tabla), '');
  const filtro = desde ? `&updated_at=gt.${encodeURIComponent(desde)}` : '';

  const filas = await sesion.pedir(
    `${VISTA[tabla] || tabla}?select=*${filtro}&order=updated_at.asc&limit=${TANDA}`,
  ) || [];

  if (!filas.length) return { bajadas: 0, hayMas: false };

  await db._sync.fusionar(tabla, filas);

  const ultimo = filas[filas.length - 1].updated_at;
  if (ultimo) await db.setConfig(CLAVE_ULTIMO(tabla), ultimo);

  return { bajadas: filas.length, hayMas: filas.length === TANDA };
}

/* ------------------------------------------------------------------ */
/*  La vuelta completa                                                 */
/* ------------------------------------------------------------------ */

/**
 * Empuja primero y trae después.
 *
 * El orden no es caprichoso: al revés, lo que baja pisaría por `updated_at` lo
 * que todavía no subió, y la venta que se cargó sin señal desaparecería sin que
 * nadie se entere. Primero se cuenta lo propio, después se escucha.
 *
 * Devuelve el resumen para poder mostrarlo. Si algo falla, tira: quien llama
 * decide si molestar a la cocina con un error o esperar a la próxima vuelta.
 */
export async function sincronizar({ traer = true } = {}) {
  const est = await sesion.estado();
  if (!est.conectado) throw new Error('Este dispositivo no tiene sesión.');

  const resumen = { subidas: 0, borradas: 0, bajadas: 0, tablas: {} };

  for (const tabla of ORDEN) {
    const n = await empujarTabla(tabla);
    if (n) { resumen.subidas += n; resumen.tablas[tabla] = { subidas: n }; }
  }

  resumen.borradas = await empujarBorrados();

  if (traer) {
    for (const tabla of ORDEN) {
      // Se da vuelta hasta agotar: una tabla con mil cambios no entra en una
      // tanda, y dejarla por la mitad haría que el marcador avance sin que los
      // datos estén.
      let vueltas = 0;
      let r;
      do {
        r = await traerTabla(tabla);
        resumen.bajadas += r.bajadas;
        if (r.bajadas) {
          resumen.tablas[tabla] = { ...resumen.tablas[tabla], bajadas: (resumen.tablas[tabla]?.bajadas || 0) + r.bajadas };
        }
      } while (r.hayMas && ++vueltas < 50);
    }
  }

  await db.setConfig('sync_ultima_vuelta', new Date().toISOString());
  return resumen;
}

/** Cuánto hay esperando para subir. Barato: para el indicador de la barra. */
export async function pendientes() {
  let filas = 0;
  for (const tabla of ORDEN) filas += (await db._sync.pendientes(tabla)).length;
  return { filas, borrados: (await db._sync.lapidas()).length };
}

/**
 * Vuelve a bajar todo desde cero.
 *
 * Es la salida para el caso que el pull incremental no cubre —un borrado hecho
 * en otro dispositivo— y para cuando algo quedó torcido y no vale la pena
 * averiguar qué. No borra nada local: fusiona, así que lo que esté pendiente de
 * subir sobrevive.
 */
export async function traerTodo() {
  for (const tabla of ORDEN) await db.setConfig(CLAVE_ULTIMO(tabla), '');
  return sincronizar();
}

export const _paraTests = { ORDEN, paraServidor, CLAVE_ULTIMO };
