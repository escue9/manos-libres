/**
 * caja.js — Caja · Cierre semanal · Rentabilidad por producto
 * Color del módulo: azul var(--caja)
 *
 * FASE 4 — ver docs/PDR.md §4.4
 *
 * REGLA 5, que es la razón de ser de este módulo: caja y rentabilidad son
 * cosas distintas y nunca se suman.
 *
 *   Rentabilidad = devengado. Sale de los pedidos ENTREGADOS en la semana.
 *   Caja         = percibido. Sale de los cobros efectivos.
 *
 * Un pedido entregado e impago suma a la ganancia y no a la caja. Confundirlas
 * es lo que hace parecer rentable a un negocio que no cobra, así que las dos
 * cifras viven en bloques separados y con una línea que lo explica.
 *
 * REGLA 6: los movimientos de cobro, compra de insumo y jornal los generan sus
 * propios módulos. Acá solo se cargan a mano gasto_operativo, aporte y retiro.
 * Cargar un ingreso a mano además del automático produce doble conteo.
 */

import { db } from '../db.js';
import { state } from '../state.js';
import { auth } from '../auth.js';
import { ui } from '../ui.js';
import * as calc from '../calc.js';

/** Los que se cargan a mano. El resto los genera su módulo (regla 6). */
const ORIGENES_MANUALES = [
  { id: 'gasto_operativo', etiqueta: 'Gasto', tipo: 'egreso' },
  { id: 'aporte',          etiqueta: 'Aporte', tipo: 'ingreso' },
  { id: 'retiro',          etiqueta: 'Retiro', tipo: 'egreso' },
];

const ORIGENES = {
  cobro:           'Cobro',
  compra_insumo:   'Compra de insumo',
  jornal:          'Jornal',
  gasto_operativo: 'Gasto',
  aporte:          'Aporte',
  retiro:          'Retiro',
};

const CATEGORIAS_GASTO = ['Gas', 'Luz', 'Flete', 'Packaging', 'Mantenimiento', 'Otros'];

const MEDIOS = [
  { id: 'efectivo',      etiqueta: 'Efectivo' },
  { id: 'transferencia', etiqueta: 'Transferencia' },
  { id: 'mercadopago',   etiqueta: 'Mercado Pago' },
];

const CUADRANTES = {
  estrella:     { etiqueta: 'Estrella', nota: 'empujar',      clase: 'badge--ok' },
  oportunidad:  { etiqueta: 'Oportunidad', nota: 'promocionar', clase: 'badge--ok' },
  revisar:      { etiqueta: 'Revisar', nota: 'precio o costo', clase: 'badge--warn' },
  discontinuar: { etiqueta: 'Discontinuar', nota: 'candidato', clase: 'badge--danger' },
};

const SUBVISTAS = [
  { id: 'movimientos',  etiqueta: 'Movimientos' },
  { id: 'cierre',       etiqueta: 'Cierre' },
  { id: 'rentabilidad', etiqueta: 'Rentabilidad' },
];

const PERIODOS = [
  { id: 'semana', etiqueta: 'Semana' },
  { id: 'mes',    etiqueta: 'Mes' },
  { id: 'todo',   etiqueta: 'Todo' },
];

/* Se recuerdan entre renders. */
let subvista = null;
let semanaCierre = null;
let filtroMov = 'todos';
let periodoRent = 'mes';

const hoyISO = () => ui.hoyISO();
const puedeCargar = () => auth.puede('cargarCaja');

/* ------------------------------------------------------------------ */
/*  Datos                                                              */
/* ------------------------------------------------------------------ */

const enRango = (fecha, desde, hasta) => fecha >= desde && fecha <= hasta;

/** Los siete días de la semana que arranca el lunes dado. */
function fechasDeSemana(lunes) {
  const base = new Date(lunes);
  return [...Array(7)].map((_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return ui.hoyISO(d);
  });
}

/**
 * El cierre de un rango. Devuelve el devengado (rentabilidad) y el percibido
 * (caja) por separado — nunca sumados.
 */
async function cierreDe(desde, hasta) {
  const [pedidos, items, jornadas, movimientos] = await Promise.all([
    db.from('pedido').select(),
    db.from('pedido_item').select(),
    db.from('jornada').select(),
    db.from('movimiento_caja').select(),
  ]);

  // Devengado: lo entregado en el rango, sin importar si se cobró.
  const entregados = pedidos.filter(
    (p) => p.estado === 'entregado' && enRango(p.fecha_entrega || p.fecha_pedido, desde, hasta),
  );
  const idsEntregados = new Set(entregados.map((p) => p.id));

  const delRango = movimientos.filter((m) => enRango(m.fecha, desde, hasta));

  const devengado = calc.cierreSemanal({
    pedidos: entregados,
    items: items.filter((i) => idsEntregados.has(i.pedido_id)),
    jornadas: jornadas.filter((j) => enRango(j.fecha, desde, hasta)),
    gastos: delRango.filter((m) => m.origen === 'gasto_operativo'),
  });

  // Percibido: lo que efectivamente entró y salió de la caja en el rango.
  const ingresos = delRango.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
  const egresos = delRango.filter((m) => m.tipo === 'egreso').reduce((a, m) => a + m.monto, 0);

  return {
    devengado,
    caja: { ingresos, egresos, neto: ingresos - egresos },
    movimientos: delRango,
    pedidos: entregados,
    items,
  };
}

/* ------------------------------------------------------------------ */
/*  Render                                                             */
/* ------------------------------------------------------------------ */

export async function render(vista) {
  subvista ||= 'movimientos';

  vista.innerHTML = `
    <div class="between" style="margin-bottom:var(--sp-4)">
      <h1 style="margin:0">Caja</h1>
    </div>
    <div class="subnav" id="subnav">
      ${SUBVISTAS.map((s) => `
        <button data-sub="${s.id}" class="${s.id === subvista ? 'active' : ''}">${s.etiqueta}</button>
      `).join('')}
    </div>
    <div id="sub"></div>`;

  vista.querySelector('#subnav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sub]');
    if (!b || b.dataset.sub === subvista) return;
    subvista = b.dataset.sub;
    render(vista);
  });

  const cont = vista.querySelector('#sub');
  if (subvista === 'cierre') return pantallaCierre(cont, vista);
  if (subvista === 'rentabilidad') return pantallaRentabilidad(cont);
  return pantallaMovimientos(cont, vista);
}

const refrescar = () => state.invalidar();

function fab(cont, onClick, titulo) {
  const b = document.createElement('button');
  b.className = 'fab';
  b.dataset.accent = 'caja';
  b.setAttribute('aria-label', titulo);
  b.textContent = '+';
  b.addEventListener('click', onClick);
  cont.appendChild(b);
}

/* ------------------------------------------------------------------ */
/*  1 · Movimientos                                                    */
/* ------------------------------------------------------------------ */

const FILTROS_MOV = [
  { id: 'todos',    etiqueta: 'Todos' },
  { id: 'ingreso',  etiqueta: 'Entró' },
  { id: 'egreso',   etiqueta: 'Salió' },
];

async function pantallaMovimientos(cont, vista) {
  const movimientos = (await db.from('movimiento_caja').select())
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')
      || (b.created_at || '').localeCompare(a.created_at || ''));

  const saldo = calc.saldoCaja(movimientos);

  if (!movimientos.length) {
    cont.innerHTML = ui.vacio({
      modulo: 'caja', icono: '\u{1F4B0}', titulo: 'La caja está en cero',
      texto: 'Los cobros, las compras de insumo y los jornales entran solos. '
           + 'Acá se cargan a mano los gastos, los aportes y los retiros.',
    });
    if (puedeCargar()) fab(cont, () => modalMovimiento(cont, vista), 'Nuevo movimiento');
    return;
  }

  const visibles = filtroMov === 'todos'
    ? movimientos
    : movimientos.filter((m) => m.tipo === filtroMov);

  cont.innerHTML = `
    <div class="hero ${saldo >= 0 ? 'ok' : 'danger'}" data-accent="caja">
      <div class="faint">Saldo de caja</div>
      <div class="value">${ui.money(saldo)}</div>
      <div class="faint">lo que efectivamente entró menos lo que salió</div>
    </div>

    <div class="chips" style="margin:var(--sp-4) 0 var(--sp-3)">
      ${FILTROS_MOV.map((f) => `
        <button class="chip ${f.id === filtroMov ? 'sel' : ''}" data-filtro="${f.id}">${f.etiqueta}</button>
      `).join('')}
      ${auth.puede('exportar')
        ? '<button class="chip" id="exportar">Exportar CSV</button>' : ''}
    </div>

    ${visibles.length
      ? `<div class="lista">${visibles.map(filaMovimiento).join('')}</div>`
      : '<p class="faint">No hay movimientos con ese filtro.</p>'}`;

  cont.querySelector('.chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filtro]');
    if (b) {
      filtroMov = b.dataset.filtro;
      return pantallaMovimientos(cont, vista);
    }
    if (e.target.closest('#exportar')) exportarCSV(movimientos);
  });

  if (puedeCargar()) fab(cont, () => modalMovimiento(cont, vista), 'Nuevo movimiento');
}

function filaMovimiento(m) {
  const entra = m.tipo === 'ingreso';
  const manual = ORIGENES_MANUALES.some((o) => o.id === m.origen);

  return `
    <div class="fila">
      <div class="fila__main">
        <div class="fila__titulo">${ui.esc(m.descripcion || ORIGENES[m.origen] || 'Movimiento')}</div>
        <div class="fila__meta">
          <span>${ui.fecha(m.fecha)}</span>
          <span class="dim">·</span>
          <span>${ui.esc(ORIGENES[m.origen] || m.origen)}</span>
          ${m.categoria_gasto ? `<span class="dim">·</span><span>${ui.esc(m.categoria_gasto)}</span>` : ''}
          ${m.medio ? `<span class="dim">·</span><span>${ui.esc(medioEtiqueta(m.medio))}</span>` : ''}
          ${manual ? '' : '<span class="dim">·</span><span class="faint">automático</span>'}
        </div>
      </div>
      <div class="fila__lado">
        <span class="num" style="color:var(--${entra ? 'ok' : 'danger'})">
          ${entra ? '+' : '−'}${ui.money(m.monto).replace('-', '')}
        </span>
      </div>
    </div>`;
}

const medioEtiqueta = (id) => MEDIOS.find((m) => m.id === id)?.etiqueta || id || '';

/**
 * Alta manual. Solo gasto, aporte y retiro: el resto lo genera su módulo y
 * cargarlo de nuevo acá contaría la misma plata dos veces (regla 6).
 */
function modalMovimiento(cont, vista) {
  let origen = 'gasto_operativo';

  ui.abrirModal(`
    <h3>Nuevo movimiento</h3>
    <p class="faint">Los cobros, las compras de insumo y los jornales se generan
      solos desde su pantalla. Cargarlos acá contaría la plata dos veces.</p>

    <div class="stack" style="margin-top:var(--sp-4)">
      <div>
        <label class="dim" style="font-size:.78rem">Qué es</label>
        <div class="chips" id="m-origen" style="margin-top:var(--sp-2)">
          ${ORIGENES_MANUALES.map((o) => `
            <button class="chip ${o.id === origen ? 'sel' : ''}" data-origen="${o.id}">${o.etiqueta}</button>
          `).join('')}
        </div>
      </div>

      <div class="field">
        <label for="m-monto">Monto</label>
        <input class="input" id="m-monto" type="number" inputmode="decimal" min="0" step="any">
      </div>

      <div class="field" id="m-campo-cat">
        <label for="m-categoria">Rubro</label>
        <select class="input" id="m-categoria">
          ${CATEGORIAS_GASTO.map((c) => `<option value="${c}">${c}</option>`).join('')}
        </select>
      </div>

      <div class="row">
        <div class="field grow">
          <label for="m-fecha">Fecha</label>
          <input class="input" id="m-fecha" type="date" value="${hoyISO()}">
        </div>
        <div class="field grow">
          <label for="m-medio">Medio</label>
          <select class="input" id="m-medio">
            ${MEDIOS.map((m) => `<option value="${m.id}">${m.etiqueta}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="field">
        <label for="m-desc">Descripción</label>
        <input class="input" id="m-desc" placeholder="Garrafa, flete a Uncas, aporte de socio…">
      </div>

      <p class="faint" id="m-error" style="color:var(--danger)"></p>
      <button class="btn btn--primary btn--block" id="m-ok">Guardar</button>
    </div>
  `, (root) => {
    const catCampo = root.querySelector('#m-campo-cat');

    root.querySelector('#m-origen').addEventListener('click', (e) => {
      const b = e.target.closest('[data-origen]');
      if (!b) return;
      origen = b.dataset.origen;
      root.querySelectorAll('#m-origen .chip').forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      // El rubro solo tiene sentido para un gasto operativo.
      catCampo.classList.toggle('hidden', origen !== 'gasto_operativo');
    });

    alGuardar(root.querySelector('#m-ok'), async () => {
      const error = root.querySelector('#m-error');
      error.textContent = '';
      try {
        await registrarMovimiento({
          origen,
          monto: root.querySelector('#m-monto').value,
          fecha: root.querySelector('#m-fecha').value,
          medio: root.querySelector('#m-medio').value,
          descripcion: root.querySelector('#m-desc').value,
          categoriaGasto: origen === 'gasto_operativo'
            ? root.querySelector('#m-categoria').value : null,
        });
        ui.cerrarModal();
        await refrescar();
        ui.toast('Movimiento cargado');
        pantallaMovimientos(cont, vista);
      } catch (err) {
        error.textContent = err.message;
      }
    });
  });
}

function alGuardar(btn, fn, textoOcupado = 'Guardando…') {
  if (!btn) return;
  const original = btn.textContent;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = textoOcupado;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = original; }
  });
}

/**
 * Carga un movimiento a mano.
 *
 * Rechaza los orígenes automáticos aunque se lo llame desde la consola: es la
 * regla 6 y el doble conteo no se ve hasta que el cierre no cuadra.
 */
export async function registrarMovimiento({
  origen, monto, fecha = hoyISO(), medio = 'efectivo',
  descripcion = '', categoriaGasto = null,
} = {}) {
  auth.exigir('cargarCaja');

  const def = ORIGENES_MANUALES.find((o) => o.id === origen);
  if (!def) {
    throw new Error('Los cobros, las compras y los jornales se generan solos: no se cargan a mano');
  }

  const importe = Number(monto);
  if (!(importe > 0)) throw new Error('El monto tiene que ser mayor que cero');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('Fecha inválida');
  if (fecha > hoyISO()) throw new Error('No se carga un movimiento con fecha futura');

  return db.from('movimiento_caja').insert({
    unidad_negocio_id: state.unidadNegocio?.id,
    fecha,
    tipo: def.tipo,
    origen,
    referencia_id: null,
    monto: importe,
    descripcion: String(descripcion || '').trim() || def.etiqueta,
    categoria_gasto: origen === 'gasto_operativo' ? categoriaGasto : null,
    medio,
  });
}

/* ------------------------------------------------------------------ */
/*  2 · Cierre semanal                                                 */
/* ------------------------------------------------------------------ */

async function pantallaCierre(cont, vista) {
  semanaCierre ||= ui.inicioSemana();
  const fechas = fechasDeSemana(semanaCierre);

  const anterior = new Date(semanaCierre);
  anterior.setDate(anterior.getDate() - 7);
  const fechasPrevias = fechasDeSemana(anterior);

  const [actual, previa] = await Promise.all([
    cierreDe(fechas[0], fechas[6]),
    cierreDe(fechasPrevias[0], fechasPrevias[6]),
  ]);

  const c = actual.devengado;
  const p = previa.devengado;

  // Sin semana anterior no se inventa un porcentaje contra cero.
  const hayPrevia = p.ventas > 0;

  // Una semana sin actividad no es una semana buena: el semáforo en verde
  // sobre un cero se lee como "todo bien" y no dice nada. Queda neutro.
  const sinVentas = c.ventas === 0;

  cont.innerHTML = `
    <div class="semana-nav">
      <button data-semana="-1" aria-label="Semana anterior">‹</button>
      <span>${ui.fecha(fechas[0])} – ${ui.fecha(fechas[6])}</span>
      <button data-semana="1" aria-label="Semana siguiente">›</button>
    </div>

    <div class="hero ${sinVentas ? '' : c.semaforo}" data-accent="caja">
      <div class="faint">Ganancia neta de la semana</div>
      <div class="value">${ui.money(c.gananciaNeta)}</div>
      <div class="faint">${sinVentas
        ? 'no hubo entregas en esta semana'
        : `${ui.pct(c.gananciaNetaPct)} sobre ventas${
            hayPrevia ? ` · ${comparar(c.gananciaNeta, p.gananciaNeta)} vs la semana anterior`
                      : ' · primera semana con datos'}`}</div>
    </div>

    <div class="card" style="margin-top:var(--sp-4)">
      ${linea('Ventas', c.ventas, hayPrevia && !sinVentas ? comparar(c.ventas, p.ventas) : '')}
      ${linea('− Costo de mercadería', c.costoMercaderia)}
      ${linea('= Margen bruto', c.margenBruto, ui.pct(c.margenBrutoPct), true)}
      ${linea('− Costo laboral', c.costoLaboral)}
      ${linea('− Gastos operativos', c.gastosOperativos)}
      ${linea('= Ganancia neta', c.gananciaNeta, ui.pct(c.gananciaNetaPct), true)}
    </div>

    <div class="card" style="margin-top:var(--sp-4)" data-accent="caja">
      <h3 style="font-size:.95rem">Caja de la semana</h3>
      <p class="faint">Esto es otra cosa: lo que <strong>efectivamente</strong> entró
        y salió. Un pedido entregado e impago suma a la ganancia de arriba y no
        acá.</p>
      ${linea('Entró', actual.caja.ingresos)}
      ${linea('− Salió', actual.caja.egresos)}
      ${linea('= Neto', actual.caja.neto, '', true)}
    </div>

    ${auth.puede('exportar') ? `
      <div class="row" style="margin-top:var(--sp-4)">
        <button class="btn grow" id="rendicion">Rendición de cuentas</button>
        <button class="btn grow" id="impacto">Impacto social</button>
      </div>` : ''}`;

  cont.querySelector('.semana-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-semana]');
    if (!b) return;
    const d = new Date(semanaCierre);
    d.setDate(d.getDate() + 7 * Number(b.dataset.semana));
    semanaCierre = d;
    pantallaCierre(cont, vista);
  });

  cont.querySelector('#rendicion')?.addEventListener('click', () =>
    imprimirRendicion(fechas[0], fechas[6], actual));
  cont.querySelector('#impacto')?.addEventListener('click', () =>
    imprimirImpacto(fechas[0], fechas[6]));
}

function linea(etiqueta, monto, extra = '', fuerte = false) {
  return `
    <div class="between" style="margin-top:var(--sp-2)${fuerte ? ';padding-top:var(--sp-2);border-top:1px solid var(--border)' : ''}">
      <span class="${fuerte ? '' : 'faint'}">${etiqueta}</span>
      <span>
        ${extra ? `<span class="faint" style="margin-right:var(--sp-2)">${extra}</span>` : ''}
        <span class="num"${fuerte ? ' style="font-weight:800"' : ''}>${ui.money(monto)}</span>
      </span>
    </div>`;
}

/** Variación contra la semana anterior. Quien llama decide si hay con qué. */
function comparar(actual, previo) {
  if (!previo) return '';
  const dif = ((actual - previo) / Math.abs(previo)) * 100;
  return `${dif >= 0 ? '+' : ''}${dif.toFixed(0)}%`;
}

/* ------------------------------------------------------------------ */
/*  3 · Rentabilidad por producto                                      */
/* ------------------------------------------------------------------ */

async function pantallaRentabilidad(cont) {
  const hasta = hoyISO();
  let desde = '0000-01-01';
  if (periodoRent === 'semana') {
    desde = fechasDeSemana(ui.inicioSemana())[0];
  } else if (periodoRent === 'mes') {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    desde = ui.hoyISO(d);
  }

  const datos = await cierreDe(desde, hasta);
  const filas = calc.cuadrantes(calc.rentabilidadProductos({
    pedidos: datos.pedidos,
    items: datos.items,
    productos: state.productos,
  }));

  cont.innerHTML = `
    <div class="chips" style="margin-bottom:var(--sp-3)">
      ${PERIODOS.map((p) => `
        <button class="chip ${p.id === periodoRent ? 'sel' : ''}" data-periodo="${p.id}">${p.etiqueta}</button>
      `).join('')}
    </div>

    ${filas.length ? `
      <div class="lista">
        ${filas.map((f) => {
          const q = CUADRANTES[f.cuadrante];
          return `
            <div class="card">
              <div class="between">
                <div style="min-width:0">
                  <div>${ui.esc(f.nombre)}</div>
                  <div class="faint">${f.unidades} vendidas · ${ui.pct(f.aportePct)} de la facturación</div>
                </div>
                <span class="badge ${q.clase}">${q.etiqueta}</span>
              </div>
              <div class="between" style="margin-top:var(--sp-2)">
                <span class="faint">Facturó</span>
                <span class="num">${ui.money(f.facturacion)}</span>
              </div>
              <div class="between">
                <span class="faint">Margen</span>
                <span class="num">${ui.money(f.margen)} · ${ui.pct(f.margenPct)}</span>
              </div>
            </div>`;
        }).join('')}
      </div>

      <p class="faint" style="margin-top:var(--sp-4)">
        Los cuadrantes salen de comparar cada producto contra la mediana del
        resto, en volumen y en margen. Son relativos al período elegido: no
        dicen que un producto sea malo, dicen cuál conviene mirar primero.
      </p>`
      : '<p class="faint">No hubo entregas en este período.</p>'}`;

  cont.querySelector('.chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-periodo]');
    if (!b) return;
    periodoRent = b.dataset.periodo;
    pantallaRentabilidad(cont);
  });
}

/* ------------------------------------------------------------------ */
/*  Exportables                                                        */
/* ------------------------------------------------------------------ */

/**
 * CSV para abrir en una planilla.
 *
 * Separador `;` y BOM al principio: Excel en español interpreta la coma como
 * decimal y sin el BOM se come los acentos.
 */
function exportarCSV(movimientos) {
  auth.exigir('exportar');

  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const filas = [
    ['fecha', 'tipo', 'origen', 'rubro', 'medio', 'descripcion', 'monto'],
    ...movimientos.map((m) => [
      m.fecha, m.tipo, ORIGENES[m.origen] || m.origen, m.categoria_gasto || '',
      medioEtiqueta(m.medio), m.descripcion || '', m.monto,
    ]),
  ];

  const csv = '﻿' + filas.map((f) => f.map(escapar).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `caja-${hoyISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  ui.toast('CSV descargado');
}

/**
 * Los reportes salen por la ventana de impresión del navegador, que en el
 * celular ofrece "Guardar como PDF". Generar un PDF a mano necesitaría una
 * librería y la regla 2 no las admite.
 */
function ventanaImpresion(titulo, cuerpo) {
  const w = window.open('', '_blank');
  if (!w) return ui.toast('El navegador bloqueó la ventana de impresión', true);

  w.document.write(`
    <!doctype html><html lang="es"><head><meta charset="utf-8">
    <title>${titulo}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 24px; color: #111; }
      h1 { font-size: 22px; margin: 0 0 2px; }
      .sub { color: #666; margin: 0 0 24px; font-size: 14px; }
      h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      td { padding: 5px 0; }
      td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      tr.total td { border-top: 1px solid #333; font-weight: 700; padding-top: 8px; }
      .pie { margin-top: 32px; color: #888; font-size: 12px; }
    </style></head><body>${cuerpo}
    <p class="pie">Manos Libres · Cocina comunitaria del CIC Barrio Movediza ·
      Mirmidones Asociación Civil · emitido el ${ui.fecha(hoyISO())}</p>
    </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

function imprimirRendicion(desde, hasta, datos) {
  auth.exigir('exportar');

  const porRubro = new Map();
  for (const m of datos.movimientos) {
    const clave = m.origen === 'gasto_operativo'
      ? `Gasto · ${m.categoria_gasto || 'Otros'}`
      : (ORIGENES[m.origen] || m.origen);
    const actual = porRubro.get(clave) || { ingreso: 0, egreso: 0 };
    actual[m.tipo] += m.monto;
    porRubro.set(clave, actual);
  }

  const fila = (n, v) => `<tr><td>${n}</td><td class="n">${ui.money(v)}</td></tr>`;

  ventanaImpresion('Rendición de cuentas', `
    <h1>Rendición de cuentas</h1>
    <p class="sub">${ui.fecha(desde)} al ${ui.fecha(hasta)}</p>

    <h2>Movimientos de caja por rubro</h2>
    <table>
      ${[...porRubro.entries()].map(([n, v]) => `
        <tr><td>${n}</td><td class="n">${v.ingreso ? ui.money(v.ingreso) : `− ${ui.money(v.egreso)}`}</td></tr>
      `).join('')}
      <tr class="total"><td>Neto de caja</td><td class="n">${ui.money(datos.caja.neto)}</td></tr>
    </table>

    <h2>Resultado del período</h2>
    <p class="sub" style="margin:0 0 8px">Calculado por lo entregado, no por lo
      cobrado: un pedido entregado e impago suma acá y no a la caja.</p>
    <table>
      ${fila('Ventas', datos.devengado.ventas)}
      ${fila('Costo de mercadería', -datos.devengado.costoMercaderia)}
      ${fila('Costo laboral', -datos.devengado.costoLaboral)}
      ${fila('Gastos operativos', -datos.devengado.gastosOperativos)}
      <tr class="total"><td>Ganancia neta</td><td class="n">${ui.money(datos.devengado.gananciaNeta)}</td></tr>
    </table>`);
}

/**
 * El reporte que piden los concursos de financiamiento: cuánto trabajo generó
 * la cocina, no cuánto vendió.
 */
async function imprimirImpacto(desde, hasta) {
  auth.exigir('exportar');

  const [jornadas, trabajadoras] = await Promise.all([
    db.from('jornada').select(),
    db.from('trabajadora').select(),
  ]);

  const delPeriodo = jornadas.filter((j) => enRango(j.fecha, desde, hasta) && j.confirmada);
  const montoJornales = delPeriodo.reduce((a, j) => a + (j.tarifa_aplicada || 0), 0);
  const involucradas = new Set(delPeriodo.map((j) => j.trabajadora_id));
  const activas = trabajadoras.filter((t) => t.activa).length;

  const fila = (n, v) => `<tr><td>${n}</td><td class="n">${v}</td></tr>`;

  ventanaImpresion('Impacto social', `
    <h1>Impacto social</h1>
    <p class="sub">${ui.fecha(desde)} al ${ui.fecha(hasta)}</p>

    <table>
      ${fila('Jornadas de trabajo generadas', delPeriodo.length)}
      ${fila('Mujeres que trabajaron en el período', involucradas.size)}
      ${fila('Trabajadoras activas en la cocina', activas)}
      <tr class="total"><td>Pagado en jornales</td><td class="n">${ui.money(montoJornales)}</td></tr>
    </table>

    <p class="sub" style="margin-top:24px">Manos Libres es la cocina comunitaria
      de Mirmidones Asociación Civil en el CIC Barrio Movediza de Tandil. Emplea
      con trabajo registrado a mujeres en situación de vulnerabilidad.</p>`);
}
