/**
 * app.js — arranque, gate de login y ruteo entre vistas.
 */

import { db, seed } from './db.js';
import { state } from './state.js';
import { auth } from './auth.js';
import { ui } from './ui.js';
import { mostrarLogin } from './login.js';
import * as sesion from './sesion.js';
import * as sync from './sync.js';
import { vigilarActualizaciones } from './actualizacion.js';

import * as produccion   from './modules/produccion.js';
import * as pedidos      from './modules/pedidos.js';
import * as trabajadoras from './modules/trabajadoras.js';
import * as caja         from './modules/caja.js';

/** Cada tab sabe qué módulo lo renderiza. */
const TABS = {
  produccion:   { render: produccion.render },
  pedidos:      { render: pedidos.render },
  clientes:     { render: pedidos.renderClientes },
  trabajadoras: { render: trabajadoras.render },
  caja:         { render: caja.render },
};

/* ------------------------------------------------------------------ */
/*  Navegación                                                         */
/* ------------------------------------------------------------------ */

/** Oculta del nav las tabs que el rol no puede ver y reparte el ancho. */
function aplicarPermisosAlNav() {
  const nav = document.getElementById('nav');
  let visibles = 0;
  nav.querySelectorAll('button[data-tab]').forEach((b) => {
    const ok = auth.puedeVer(b.dataset.tab);
    b.classList.toggle('hidden', !ok);
    if (ok) visibles++;
  });
  nav.style.gridTemplateColumns = `repeat(${visibles}, 1fr)`;
}

async function irA(tab) {
  if (!auth.puedeVer(tab)) return ui.toast('No tenés acceso a esta sección', true);

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('#nav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));

  // La barra fija de venta rápida solo existe mientras esa vista está activa
  document.body.classList.remove('venta-activa');

  const vista = document.getElementById(`view-${tab}`);
  vista.classList.add('active');
  state.tabActual = tab;

  await TABS[tab].render(vista);
  window.scrollTo(0, 0);

  // Sin await: el número del header no puede hacer esperar a la pantalla.
  refrescarPendientes();
}

/* ------------------------------------------------------------------ */
/*  Sincronización                                                     */
/* ------------------------------------------------------------------ */

/** Una sola vuelta a la vez: dos push simultáneos se pisan la cola. */
let sincronizando = false;

/**
 * La vuelta que no molesta a nadie.
 *
 * Quedarse sin señal en la cocina del CIC es lo normal, no una falla. Si esto
 * avisara, avisaría todos los días y se aprendería a ignorarlo — y de paso
 * taparía el aviso del día que sí importa. Lo que no sube queda con su
 * `sync_status` puesto y se va en la próxima vuelta, que es exactamente para lo
 * que sync.js lo guarda.
 */
async function sincronizarCallado() {
  if (sincronizando) return;

  const est = await sesion.estado().catch(() => null);
  if (!est?.conectado) return;

  sincronizando = true;
  try {
    const r = await sync.sincronizar();
    // Se re-renderiza solo si algo BAJÓ. Refrescar la vista de abajo de las
    // manos de alguien que está cargando un pedido, para no mostrar nada nuevo,
    // es peor que esperar a la próxima.
    if (r.bajadas) await state.invalidar();
  } catch (e) {
    console.warn('Sync en segundo plano:', e.message);
  } finally {
    sincronizando = false;
    refrescarPendientes();
  }
}

/**
 * El indicador del header.
 *
 * Un dispositivo sin sesión no tiene a dónde subir: TODO le queda pendiente
 * para siempre, y un número que nunca baja no informa, molesta. En ese caso el
 * indicador se apaga y la explicación va al menú, que es donde se puede hacer
 * algo al respecto.
 */
async function refrescarPendientes() {
  const pin = document.getElementById('sync-pendiente');
  if (!pin) return;

  try {
    const est = await sesion.estado();
    const { filas, borrados } = est.conectado
      ? await sync.pendientes()
      : { filas: 0, borrados: 0 };

    const total = filas + borrados;
    pin.classList.toggle('hidden', total === 0);
    document.getElementById('sync-pendiente-n').textContent = total > 99 ? '99+' : String(total);
    pin.setAttribute('aria-label',
      `${total} ${total === 1 ? 'registro' : 'registros'} sin subir. Tocá para ver el detalle.`);
  } catch {
    // Contar lo pendiente nunca puede ser el motivo de que algo se rompa.
    pin.classList.add('hidden');
  }
}

/** Cuándo fue la última vuelta, sin precisión falsa. */
function cuando(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return 'nunca';

  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1)  return 'recién';
  if (min < 60) return `hace ${min} min`;

  const p = (n) => String(n).padStart(2, '0');
  const hora = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return ui.hoyISO(d) === ui.hoyISO() ? `hoy ${hora}` : `${ui.fecha(d)} a las ${hora}`;
}

function textoPendiente(filas, borrados) {
  if (!filas && !borrados) return 'Todo lo de este dispositivo ya está en la nube.';
  const partes = [];
  if (filas)    partes.push(`${filas} ${filas === 1 ? 'registro' : 'registros'}`);
  if (borrados) partes.push(`${borrados} ${borrados === 1 ? 'borrado' : 'borrados'}`);
  return `${partes.join(' y ')} esperando para subir.`;
}

/**
 * "Failed to fetch" es lo que dice el navegador cuando no hay red, y no se le
 * puede pedir a nadie que lo traduzca parada en la cocina. El resto de los
 * errores sí se muestran tal cual: un 401 o un 42501 hay que poder leerlos
 * enteros para saber a quién llamar.
 */
function errorEnCriollo(e) {
  const msg = e?.message || '';
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'No se pudo llegar a la nube. Probá de nuevo cuando vuelva internet: mientras tanto no se pierde nada.';
  }
  return msg || 'No se pudo sincronizar.';
}

/** Qué pasó en la vuelta, para el toast del botón. */
function resumenSync(r) {
  const partes = [];
  if (r.subidas)  partes.push(`${r.subidas} ${r.subidas === 1 ? 'subido' : 'subidos'}`);
  if (r.borradas) partes.push(`${r.borradas} ${r.borradas === 1 ? 'borrado' : 'borrados'}`);
  if (r.bajadas)  partes.push(`${r.bajadas} ${r.bajadas === 1 ? 'bajado' : 'bajados'}`);
  return partes.length ? `Sincronizado · ${partes.join(' · ')}` : 'Ya estaba todo al día';
}

/**
 * El bloque de sincronización del menú.
 *
 * Se pinta DESPUÉS de abrir el modal: contar lo pendiente son diecisiete
 * lecturas a IndexedDB y el menú tiene que abrir en el acto.
 *
 * Lo que se muestra —cuánto falta subir y de cuándo es la última vuelta— no es
 * información de nadie en particular: no hay costos, ni márgenes, ni datos de
 * otra trabajadora. Sincronizar es de cualquier rol (regla 8 intacta).
 */
async function pintarSync(cont) {
  const est = await sesion.estado();

  if (!est.conectado) {
    cont.innerHTML = `
      <div class="bloque__titulo">Sincronización</div>
      <p class="faint" style="margin:0">
        ${est.configurado
          ? 'La sesión de este dispositivo se cerró o venció, así que nada está viajando a la nube. '
            + 'Volvé a entrar desde Pedidos → Catálogo online.'
          : 'Este dispositivo no está conectado a la nube. Todo se guarda acá y no viaja a ningún lado: '
            + 'hasta que se conecte, la copia de seguridad es la única que existe.'}
      </p>`;
    return;
  }

  const { filas, borrados } = await sync.pendientes();
  const ultima = await db.getConfig('sync_ultima_vuelta', '');

  cont.innerHTML = `
    <div class="bloque__titulo">Sincronización</div>
    <p style="margin:0 0 var(--sp-1);font-size:.9rem">${textoPendiente(filas, borrados)}</p>
    <p class="faint" style="margin:0 0 var(--sp-3)">Última vez: ${cuando(ultima)}</p>
    <p class="faint hidden" id="m-sync-error" style="margin:0 0 var(--sp-3);color:var(--danger)"></p>
    <button class="btn btn--block" id="m-sync-ya">Sincronizar ahora</button>`;

  cont.querySelector('#m-sync-ya')
    .addEventListener('click', (e) => sincronizarAhora(e.currentTarget, cont));
}

/**
 * La vuelta que sí habla. Es la contracara de sincronizarCallado(): acá alguien
 * la pidió a propósito, así que se cuenta cómo fue y, si falló, por qué —
 * escrito en el modal y no en un toast, porque un error de Supabase es largo y
 * no se alcanza a leer en dos segundos y medio.
 */
async function sincronizarAhora(btn, cont) {
  const error = cont.querySelector('#m-sync-error');
  const fallar = (msg) => {
    error.textContent = msg;
    error.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Sincronizar ahora';
  };

  error.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Sincronizando…';

  if (sincronizando) return fallar('Ya hay una sincronización en curso. Esperá unos segundos.');

  sincronizando = true;
  ui.bloquearModal(true);
  try {
    const r = await sync.sincronizar();
    ui.bloquearModal(false);
    ui.cerrarModal();
    ui.toast(resumenSync(r));
    if (r.bajadas) await state.invalidar();
  } catch (e) {
    console.error(e);
    ui.bloquearModal(false);
    fallar(errorEnCriollo(e));
  } finally {
    sincronizando = false;
    refrescarPendientes();
  }
}

/* ------------------------------------------------------------------ */
/*  Menú del header                                                    */
/* ------------------------------------------------------------------ */

function abrirMenu() {
  const p = auth.permisos;
  ui.abrirModal(`
    <h3>${ui.esc(auth.nombre || p.etiqueta)}</h3>
    <p class="faint" style="margin-top:calc(var(--sp-1) * -1)">${p.etiqueta}</p>

    <div class="bloque" id="m-sync">
      <div class="bloque__titulo">Sincronización</div>
      <p class="faint" style="margin:0">Viendo cómo viene…</p>
    </div>

    <div class="stack" style="margin-top:var(--sp-4)">
      ${p.exportar ? `
        <button class="btn btn--block" id="m-backup">Descargar copia de seguridad</button>
        <p class="faint" style="margin:0">
          Guarda todos los datos en un archivo. Seguí haciéndolo cada semana:
          la nube es un espejo, no un respaldo. Lo que se borra acá se borra allá.
        </p>
        <label class="btn btn--block" for="m-archivo">Restaurar desde una copia</label>
        <input type="file" id="m-archivo" accept="application/json,.json" class="hidden">
        <p class="faint" style="margin:0">
          Reemplaza todos los datos actuales por los del archivo. El PIN no se toca.
        </p>` : ''}
      <button class="btn btn--block btn--danger" id="m-salir">Cerrar sesión</button>
    </div>
  `, (root) => {
    pintarSync(root.querySelector('#m-sync'));
    root.querySelector('#m-backup')?.addEventListener('click', descargarBackup);
    root.querySelector('#m-archivo')?.addEventListener('change', (e) => restaurarBackup(e.target.files[0]));
    root.querySelector('#m-salir').addEventListener('click', async () => {
      ui.cerrarModal();
      auth.salir();
      await arrancarSesion();
    });
  });
}

async function descargarBackup() {
  try {
    auth.exigir('exportar');
    const datos = await db.exportAll();
    const filas = Object.entries(datos)
      .filter(([k]) => !k.startsWith('_'))
      .reduce((a, [, v]) => a + (Array.isArray(v) ? v.length : 0), 0);

    const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    // El <a> tiene que estar en el documento y el blob seguir vivo cuando
    // arranca la descarga: fuera del DOM, Firefox no baja nada, y revocar la
    // URL en la misma vuelta del event loop cancela lo que ya arrancó.
    const a = document.createElement('a');
    a.href = url;
    a.download = `cocina-cic-${ui.hoyISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    ui.cerrarModal();
    ui.toast(`Copia descargada · ${filas} registros`);
  } catch (e) {
    console.error(e);
    ui.toast(e.message || 'No se pudo generar la copia', true);
  }
}

/** Restaurar reemplaza TODO. Se pregunta una vez, en criollo, y se recarga. */
async function restaurarBackup(archivo) {
  if (!archivo) return;
  try {
    auth.exigir('exportar');
    const datos = JSON.parse(await archivo.text());
    const fecha = datos._exported_at ? ui.fecha(datos._exported_at.slice(0, 10)) : 'sin fecha';

    ui.cerrarModal();
    const ok = await ui.confirmar(
      `Esto reemplaza TODOS los datos de ahora por los de la copia del ${fecha}. `
      + 'Lo que se cargó después se pierde.', 'Restaurar');
    if (!ok) return;

    const filas = await db.importAll(datos);
    ui.toast(`Copia restaurada · ${filas} registros`);
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    console.error(e);
    ui.toast(e.message || 'No se pudo leer el archivo', true);
  }
}

/* ------------------------------------------------------------------ */
/*  Arranque                                                           */
/* ------------------------------------------------------------------ */

async function arrancarSesion() {
  if (!auth.restaurarSesion()) await mostrarLogin();

  // Recién ahora se sabe quién entró: el estado se recarga con lo que ese rol
  // puede tener en memoria (state.js → recortarTrabajadora)
  await state.cargar();

  aplicarPermisosAlNav();
  document.getElementById('semana-label').textContent = auth.permisos.etiqueta;
  await irA(auth.tabInicial);
}

async function init() {
  await seed();
  await state.cargar();

  document.getElementById('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) irA(btn.dataset.tab);
  });

  document.getElementById('btn-menu').addEventListener('click', abrirMenu);
  document.getElementById('sync-pendiente').addEventListener('click', abrirMenu);

  // Re-render del tab activo cuando cambian los datos
  state.on('cambio', () => irA(state.tabActual));

  // Cuando vuelve la señal se aprovecha sola: nadie va a acordarse de entrar al
  // menú a sincronizar justo en el minuto en que el CIC recupera internet.
  window.addEventListener('online', sincronizarCallado);

  // Antes del login: si hay una versión nueva esperando, que el aviso esté
  // desde el arranque y no después de que tipeen el PIN.
  vigilarActualizaciones();

  await arrancarSesion();

  // Recién acá hay sesión, y va sin await a propósito: la app ya está en
  // pantalla y una vuelta del replicador no puede demorar el primer render
  // (regla 3). Si no hay internet, no pasa nada y nadie se entera.
  sincronizarCallado();
}

init().catch((e) => {
  console.error(e);
  ui.toast('Error al iniciar la app', true);
});

/* Consola de desarrollo — solo en localhost.
 *
 * En el celular de la cocina esto anulaba todos los auth.exigir(): con la
 * sesión de una trabajadora abierta, `auth.rol = 'admin'` alcanzaba para ver
 * la caja, y `db.from('trabajadora').select()` devolvía nombres, tarifas y
 * hashes de PIN de todo el equipo. Los permisos del código no valen nada si
 * el objeto que los aplica está colgado de window. */
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.db = db;
  window.auth = auth;
}
