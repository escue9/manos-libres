/**
 * app.js — arranque, gate de login y ruteo entre vistas.
 */

import { db, seed } from './db.js';
import { state } from './state.js';
import { auth } from './auth.js';
import { ui } from './ui.js';
import { mostrarLogin } from './login.js';

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
}

/* ------------------------------------------------------------------ */
/*  Menú del header                                                    */
/* ------------------------------------------------------------------ */

function abrirMenu() {
  const p = auth.permisos;
  ui.abrirModal(`
    <h3>${ui.esc(auth.nombre || p.etiqueta)}</h3>
    <p class="faint" style="margin-top:calc(var(--sp-1) * -1)">${p.etiqueta}</p>

    <div class="stack" style="margin-top:var(--sp-4)">
      ${p.exportar ? `
        <button class="btn btn--block" id="m-backup">Descargar copia de seguridad</button>
        <p class="faint" style="margin:0">
          Guarda todos los datos en un archivo. Hacelo cada semana:
          hasta que el sistema esté en la nube, es la única copia que existe.
        </p>` : ''}
      <button class="btn btn--block btn--danger" id="m-salir">Cerrar sesión</button>
    </div>
  `, (root) => {
    root.querySelector('#m-backup')?.addEventListener('click', descargarBackup);
    root.querySelector('#m-salir').addEventListener('click', async () => {
      ui.cerrarModal();
      auth.salir();
      await arrancarSesion();
    });
  });
}

async function descargarBackup() {
  try {
    const datos = await db.exportAll();
    const filas = Object.entries(datos)
      .filter(([k]) => !k.startsWith('_'))
      .reduce((a, [, v]) => a + (Array.isArray(v) ? v.length : 0), 0);

    const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const hoy = new Date().toISOString().slice(0, 10);

    const a = document.createElement('a');
    a.href = url;
    a.download = `cocina-cic-${hoy}.json`;
    a.click();
    URL.revokeObjectURL(url);

    ui.cerrarModal();
    ui.toast(`Copia descargada · ${filas} registros`);
  } catch (e) {
    console.error(e);
    ui.toast('No se pudo generar la copia', true);
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

  // Re-render del tab activo cuando cambian los datos
  state.on('cambio', () => irA(state.tabActual));

  await arrancarSesion();
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
