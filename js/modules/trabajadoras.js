/**
 * trabajadoras.js — Equipo · Registro semanal · Liquidación
 * Color del módulo: verde var(--equipo)
 *
 * FASE 3 — ver docs/PDR.md §4.3
 *
 * Reglas que sostienen este módulo:
 *  - Una jornada por trabajadora por fecha (PDR §3)
 *  - La tarifa se congela desde tarifa_historica según la FECHA de la jornada,
 *    no desde trabajadora.tarifa_dia. Si la tarifa subió en marzo, una jornada
 *    de febrero se liquida con la vieja
 *  - Solo las jornadas confirmadas entran a la liquidación y al costo laboral
 *  - El egreso en caja de la liquidación se genera solo (regla 6)
 *  - Privacidad (regla 8): una trabajadora ve solo lo suyo. Nunca la tarifa,
 *    los días ni la liquidación de otra
 */

import { db } from '../db.js';
import { state } from '../state.js';
import { auth } from '../auth.js';
import { ui } from '../ui.js';
import * as calc from '../calc.js';

const DIAS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const NOMBRE_DIA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

/** Semana que se está mirando. Se recuerda entre renders. */
let semana = null;

const esAdmin = () => auth.puede('verEquipoCompleto');

/** Las 7 fechas ISO de la semana que arranca en `lunes`. */
function fechasDeSemana(lunes) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(lunes);
    d.setDate(d.getDate() + i);
    return ui.hoyISO(d);
  });
}

/* ================================================================== */
/*  Transacciones                                                      */
/* ================================================================== */

/** Cuántos días para atrás puede autoreportar una trabajadora. */
const DIAS_AUTOREPORTE = 14;

/**
 * Marca o desmarca una jornada. Es un toggle: si ya existe, la borra.
 *
 * El origen NO es un parámetro: se deriva del rol de quien llama. Cuando era
 * un parámetro, pasarle cualquier valor que no fuera 'admin' ni 'autoreporte'
 * salteaba las dos validaciones, y desde la consola una trabajadora podía
 * borrar y crear jornadas a nombre de otra — y usar el 'creada'/'borrada' que
 * devuelve como oráculo para reconstruirle la semana entera.
 *
 * @returns {Promise<{accion:'creada'|'borrada', jornada?:Object}>}
 */
export async function marcarJornada(trabajadoraId, fecha) {
  const admin = esAdmin();
  if (admin) auth.exigir('liquidar');
  else if (auth.trabajadoraId !== trabajadoraId) {
    throw new Error('Solo podés marcar tus propias jornadas');
  }
  const origen = admin ? 'admin' : 'autoreporte';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) throw new Error('Fecha inválida');

  const hoy = ui.hoyISO();
  if (fecha > hoy) throw new Error('No se puede marcar un día que todavía no pasó');

  if (!admin) {
    const limite = ui.hoyISO(new Date(Date.now() - DIAS_AUTOREPORTE * 864e5));
    if (fecha < limite) {
      throw new Error(`Solo podés marcar los últimos ${DIAS_AUTOREPORTE} días. Avisale a la administración`);
    }
  }

  const existentes = await db.from('jornada').select()
    .eq('trabajadora_id', trabajadoraId).eq('fecha', fecha);

  if (existentes.length) {
    const j = existentes[0];
    if (j.estado_pago === 'pagada') throw new Error('Esa jornada ya está liquidada');
    // Las que nacen de una orden se desasignan desde la orden, no de acá
    if (j.orden_produccion_id) throw new Error('Esa jornada viene de una orden de producción');
    // Un tap sin querer no puede borrar lo que la administración ya revisó
    if (!admin && j.confirmada) throw new Error('Ese día ya lo confirmó la administración');
    await db.from('jornada').delete().eq('id', j.id);
    return { accion: 'borrada' };
  }

  const [trabajadora, tarifas] = await Promise.all([
    db.from('trabajadora').select().eq('id', trabajadoraId).single(),
    db.from('tarifa_historica').select().eq('trabajadora_id', trabajadoraId),
  ]);
  if (!trabajadora) throw new Error('Trabajadora inexistente');

  const jornada = await db.from('jornada').insert({
    trabajadora_id: trabajadoraId,
    fecha,
    orden_produccion_id: null,
    tarifa_aplicada: calc.tarifaVigente(tarifas, fecha, trabajadora.tarifa_dia || 0),
    origen_carga: origen,
    confirmada: origen === 'admin',   // el autoreporte espera confirmación
    estado_pago: 'pendiente',
  });

  return { accion: 'creada', jornada };
}

/** El admin confirma un autoreporte. Recién ahí cuenta para la liquidación. */
export async function confirmarJornada(jornadaId, confirmada = true) {
  auth.exigir('liquidar');

  const j = await db.from('jornada').select().eq('id', jornadaId).single();
  if (!j) throw new Error('Jornada inexistente');

  // Desconfirmar algo ya pagado saca el jornal del costo laboral pero deja el
  // egreso en la caja: la rentabilidad y la caja dejarían de cerrar (regla 5)
  if (j.estado_pago === 'pagada') throw new Error('Esa jornada ya está liquidada');

  await db.from('jornada').update({ confirmada }).eq('id', jornadaId);
  return db.from('jornada').select().eq('id', jornadaId).single();
}

/**
 * Liquida la semana: marca las jornadas como pagadas y genera UN egreso en caja.
 *
 * Solo entran las confirmadas y pendientes de pago. Las sin confirmar quedan
 * afuera y siguen disponibles para la próxima liquidación.
 */
export async function liquidarSemana(desde, hasta, { medio = 'efectivo' } = {}) {
  auth.exigir('liquidar');

  const todas = await db.from('jornada').select().gte('fecha', desde).lte('fecha', hasta);
  const aPagar = todas.filter((j) => j.confirmada && j.estado_pago !== 'pagada');

  if (!aPagar.length) throw new Error('No hay jornadas confirmadas para liquidar');

  const total = aPagar.reduce((a, j) => a + (j.tarifa_aplicada || 0), 0);
  const hoy = ui.hoyISO();

  for (const j of aPagar) {
    await db.from('jornada').update({ estado_pago: 'pagada', fecha_pago: hoy }).eq('id', j.id);
  }

  // Automático por la regla 6: nunca se carga a mano
  await db.from('movimiento_caja').insert({
    unidad_negocio_id: state.unidadNegocio.id,
    fecha: hoy,
    tipo: 'egreso',
    origen: 'jornal',
    referencia_id: null,
    monto: total,
    descripcion: `Liquidación ${ui.fecha(desde)} – ${ui.fecha(hasta)} · ${aPagar.length} jornadas`,
    medio,
  });

  return { total, jornadas: aPagar.length, porTrabajadora: agruparPorTrabajadora(aPagar) };
}

function agruparPorTrabajadora(jornadas) {
  const m = new Map();
  for (const j of jornadas) {
    if (!m.has(j.trabajadora_id)) m.set(j.trabajadora_id, { dias: 0, total: 0 });
    const e = m.get(j.trabajadora_id);
    e.dias += 1;
    e.total += j.tarifa_aplicada || 0;
  }
  return [...m.entries()].map(([trabajadora_id, v]) => ({ trabajadora_id, ...v }));
}

/**
 * Alta o edición de trabajadora.
 *
 * Si cambia la tarifa deja fila en tarifa_historica desde hoy. Las jornadas ya
 * cargadas no se tocan: cada una guarda la tarifa con la que nació.
 */
export async function guardarTrabajadora({ id = null, nombre, telefono = '', tarifaDia, fechaIngreso = null, activa = true }) {
  auth.exigir('liquidar');

  nombre = String(nombre || '').trim();
  tarifaDia = Number(tarifaDia);
  if (!nombre) throw new Error('Falta el nombre');
  if (!(tarifaDia >= 0)) throw new Error('La tarifa no puede ser negativa');

  if (!id) {
    const t = await db.from('trabajadora').insert({
      unidad_negocio_id: state.unidadNegocio.id,
      nombre, telefono,
      tarifa_dia: tarifaDia,
      fecha_ingreso: fechaIngreso || ui.hoyISO(),
      activa,
    });
    await db.from('tarifa_historica').insert({
      trabajadora_id: t.id, tarifa_dia: tarifaDia, vigente_desde: t.fecha_ingreso,
    });
    return t;
  }

  const previa = await db.from('trabajadora').select().eq('id', id).single();
  await db.from('trabajadora').update({ nombre, telefono, tarifa_dia: tarifaDia, activa }).eq('id', id);

  if (previa && previa.tarifa_dia !== tarifaDia) {
    // Las trabajadoras que ya existían (seed, import) no tienen fila inicial.
    // Sin sembrarla, el historial arrancaría recién hoy y una jornada vieja
    // cargada más tarde se pagaría con la tarifa nueva.
    const historial = await db.from('tarifa_historica').select().eq('trabajadora_id', id);
    if (!historial.length) {
      await db.from('tarifa_historica').insert({
        trabajadora_id: id,
        tarifa_dia: previa.tarifa_dia || 0,
        vigente_desde: previa.fecha_ingreso || previa.created_at?.slice(0, 10) || ui.hoyISO(),
      });
    }

    await db.from('tarifa_historica').insert({
      trabajadora_id: id, tarifa_dia: tarifaDia, vigente_desde: ui.hoyISO(),
    });
  }
  return db.from('trabajadora').select().eq('id', id).single();
}

/** Resumen de la semana, ya filtrado por rol: una trabajadora ve solo lo suyo. */
export async function resumenSemana(desde, hasta) {
  const jornadas = auth.filtrarPropio(
    await db.from('jornada').select().gte('fecha', desde).lte('fecha', hasta),
  );

  // state.trabajadoras trae solo las activas. Si alguien trabajó el lunes y la
  // dieron de baja el miércoles, sus jornadas se liquidan igual —liquidarSemana
  // no filtra por activa— pero no aparecían en el resumen: el admin veía un
  // total y la caja registraba otro. Se suman las que tengan jornadas.
  const conJornada = [...new Set(jornadas.map((j) => j.trabajadora_id))]
    .filter((id) => !state.trabajadoras.some((t) => t.id === id));

  const inactivas = conJornada.length
    ? (await db.from('trabajadora').select()).filter((t) => conJornada.includes(t.id))
    : [];

  const todas = [...state.trabajadoras, ...inactivas];
  const visibles = esAdmin()
    ? todas
    : todas.filter((t) => t.id === auth.trabajadoraId);

  const filas = visibles.map((t) => {
    const suyas = jornadas.filter((j) => j.trabajadora_id === t.id);
    const confirmadas = suyas.filter((j) => j.confirmada);
    return {
      trabajadora: t,
      jornadas: suyas,
      dias: confirmadas.length,
      sinConfirmar: suyas.length - confirmadas.length,
      total: confirmadas.reduce((a, j) => a + (j.tarifa_aplicada || 0), 0),
      pendiente: confirmadas.filter((j) => j.estado_pago !== 'pagada')
                            .reduce((a, j) => a + (j.tarifa_aplicada || 0), 0),
    };
  });

  return {
    filas,
    total: filas.reduce((a, f) => a + f.total, 0),
    pendiente: filas.reduce((a, f) => a + f.pendiente, 0),
    sinConfirmar: filas.reduce((a, f) => a + f.sinConfirmar, 0),
  };
}

/* ================================================================== */
/*  Vista                                                              */
/* ================================================================== */

export async function render(vista) {
  semana ||= ui.inicioSemana();
  const fechas = fechasDeSemana(semana);

  if (!state.trabajadoras.length) {
    vista.innerHTML = ui.vacio({
      modulo: 'trabajadoras', icono: '\u{1F465}', titulo: 'Sin equipo',
      texto: esAdmin()
        ? 'Cargá a las trabajadoras para empezar a registrar jornadas.'
        : 'Todavía no estás cargada en el equipo.',
    });
    if (esAdmin()) fab(vista, () => modalTrabajadora(null, vista));
    return;
  }

  const resumen = await resumenSemana(fechas[0], fechas[6]);

  // Todo cuelga de un nodo propio, no de `vista`.
  // `vista` es el <section> permanente del shell: los listeners colgados ahí
  // sobreviven al innerHTML y se acumulan en cada render. Con un tap por día,
  // eso llegaba a crear 26 jornadas donde iban 4 — y a liquidar 6 veces de más.
  vista.innerHTML = `
    <div id="equipo-root">
      <div class="between" style="margin-bottom:var(--sp-3)">
        <h1 style="margin:0">${esAdmin() ? 'Equipo' : 'Mis jornadas'}</h1>
      </div>

      <div class="semana-nav">
        <button data-semana="-1" aria-label="Semana anterior">‹</button>
        <span>${ui.fecha(fechas[0])} – ${ui.fecha(fechas[6])}</span>
        <button data-semana="1" aria-label="Semana siguiente">›</button>
      </div>

      ${resumen.filas.map((f) => tarjeta(f, fechas)).join('')}
      ${esAdmin() ? bloqueLiquidacion(resumen) : bloquePropio(resumen)}
    </div>
  `;

  const root = vista.querySelector('#equipo-root');

  root.querySelector('.semana-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-semana]');
    if (!b) return;
    const d = new Date(semana);
    d.setDate(d.getDate() + 7 * Number(b.dataset.semana));
    semana = d;
    render(vista);
  });

  root.addEventListener('click', async (e) => {
    const dia = e.target.closest('[data-dia]');
    if (dia) return toggleDia(dia, vista);

    const conf = e.target.closest('[data-confirmar]');
    if (conf) {
      try {
        await confirmarJornada(conf.dataset.confirmar);
        ui.toast('Jornada confirmada');
        return render(vista);
      } catch (err) { return ui.toast(err.message, true); }
    }

    const edit = e.target.closest('[data-editar]');
    if (edit) return modalTrabajadora(state.trabajadoraPorId(edit.dataset.editar), vista);

    if (e.target.closest('#liquidar')) return abrirLiquidacion(fechas, resumen, vista);
  });

  if (esAdmin()) fab(vista, () => modalTrabajadora(null, vista));
}

function tarjeta(f, fechas) {
  const porFecha = new Map(f.jornadas.map((j) => [j.fecha, j]));
  const propia = f.trabajadora.id === auth.trabajadoraId;

  return `
    <div class="card" data-accent="trabajadoras" style="margin-bottom:var(--sp-3)">
      <div class="between">
        <div>
          <b>${ui.esc(f.trabajadora.nombre)}</b>
          ${f.trabajadora.activa === false ? '<span class="badge">Ya no trabaja</span>' : ''}
          ${esAdmin() ? `<div class="faint">${ui.money(f.trabajadora.tarifa_dia)} por día</div>` : ''}
        </div>
        <div class="right">
          <div class="num" style="font-size:1.1rem">${f.dias} ${f.dias === 1 ? 'día' : 'días'}</div>
          ${esAdmin() || propia ? `<div class="num dim">${ui.money(f.total)}</div>` : ''}
        </div>
      </div>

      <div class="days" style="margin-top:var(--sp-3)">
        ${fechas.map((fecha, i) => {
          const j = porFecha.get(fecha);
          // Una jornada es un hecho: nadie trabajó todavía un día que no pasó.
          // Se deshabilita en vez de dejar tocar y fallar con un toast.
          const futuro = fecha > ui.hoyISO();
          const clases = ['', j ? 'on' : '',
                          j && !j.confirmada ? 'pendiente' : '',
                          j?.estado_pago === 'pagada' ? 'pagada' : ''].join(' ').trim();
          return `<button class="${clases}" data-dia="${fecha}" data-trab="${f.trabajadora.id}"
                    ${futuro ? 'disabled' : ''}
                    title="${NOMBRE_DIA[i]} ${ui.fecha(fecha)}${futuro ? ' · todavía no pasó' : ''}">${DIAS[i]}</button>`;
        }).join('')}
      </div>

      ${f.sinConfirmar && esAdmin() ? `
        <div class="alerta alerta--warn" style="margin-top:var(--sp-3)">
          ${f.sinConfirmar === 1 ? 'Cargó un día' : `Cargó ${f.sinConfirmar} días`} que
          todavía no ${f.sinConfirmar === 1 ? 'está confirmado' : 'están confirmados'}.
          No ${f.sinConfirmar === 1 ? 'cuenta' : 'cuentan'} para la liquidación.
          <div class="stack" style="margin-top:var(--sp-2)">
            ${f.jornadas.filter((j) => !j.confirmada).map((j) => `
              <button class="btn btn--ghost" data-confirmar="${j.id}">Confirmar ${ui.fecha(j.fecha)}</button>
            `).join('')}
          </div>
        </div>` : ''}

      ${esAdmin() ? `
        <button class="btn btn--ghost btn--block" data-editar="${f.trabajadora.id}"
          style="margin-top:var(--sp-3)">Editar</button>` : ''}
    </div>`;
}

function bloqueLiquidacion(resumen) {
  return `
    <div class="card" data-accent="trabajadoras" style="margin-top:var(--sp-4)">
      <div class="between">
        <span class="dim">Total de la semana</span>
        <b class="num" style="font-size:1.3rem">${ui.money(resumen.total)}</b>
      </div>
      ${resumen.pendiente !== resumen.total ? `
        <div class="between" style="margin-top:var(--sp-2)">
          <span class="dim">Pendiente de pago</span>
          <b class="num">${ui.money(resumen.pendiente)}</b>
        </div>` : ''}
      ${resumen.sinConfirmar ? `
        <p class="faint" style="margin:var(--sp-2) 0 0">
          Hay ${resumen.sinConfirmar} sin confirmar que no están incluidas.
        </p>` : ''}
      <button class="btn btn--primary btn--block" data-accent="trabajadoras" id="liquidar"
        style="margin-top:var(--sp-3)" ${resumen.pendiente <= 0 ? 'disabled' : ''}>
        ${resumen.pendiente > 0 ? 'Liquidar semana' : 'Semana liquidada'}
      </button>
    </div>`;
}

/** Lo que ve una trabajadora: lo suyo y nada más. */
function bloquePropio(resumen) {
  const f = resumen.filas[0];
  if (!f) return '';
  return `
    <div class="card" data-accent="trabajadoras" style="margin-top:var(--sp-4)">
      <div class="between">
        <span class="dim">Tu total de la semana</span>
        <b class="num" style="font-size:1.3rem">${ui.money(f.total)}</b>
      </div>
      <p class="faint" style="margin:var(--sp-3) 0 0">
        ${f.sinConfirmar
          ? `Marcaste ${f.sinConfirmar} ${f.sinConfirmar === 1 ? 'día' : 'días'} que todavía
             no ${f.sinConfirmar === 1 ? 'está confirmado' : 'están confirmados'}. Se suman a tu
             total cuando los confirme la administración.`
          : 'Tocá los días que trabajaste. Quedan pendientes hasta que los confirme la administración.'}
      </p>
    </div>`;
}

async function toggleDia(btn, vista) {
  const fecha = btn.dataset.dia;
  const trabajadoraId = btn.dataset.trab;

  if (!esAdmin() && trabajadoraId !== auth.trabajadoraId) {
    return ui.toast('Solo podés marcar tus propias jornadas', true);
  }

  try {
    const { accion } = await marcarJornada(trabajadoraId, fecha);
    navigator.vibrate?.(12);
    if (accion === 'creada' && !esAdmin()) ui.toast('Queda pendiente de confirmar');
    await render(vista);
  } catch (err) {
    ui.toast(err.message, true);
  }
}

/* ------------------------------------------------------------------ */

function abrirLiquidacion(fechas, resumen, vista) {
  const conPendiente = resumen.filas.filter((f) => f.pendiente > 0);

  ui.abrirModal(`
    <h3>Liquidar la semana</h3>
    <p class="faint" style="margin-top:calc(var(--sp-2) * -1)">
      ${ui.fecha(fechas[0])} – ${ui.fecha(fechas[6])}
    </p>

    <table class="table" style="margin-top:var(--sp-3)">
      <tbody>
        ${conPendiente.map((f) => `
          <tr>
            <td>${ui.esc(f.trabajadora.nombre)}</td>
            <td class="num right dim">${f.dias} × ${ui.money(f.trabajadora.tarifa_dia)}</td>
            <td class="num right"><b>${ui.money(f.pendiente)}</b></td>
          </tr>`).join('')}
      </tbody>
    </table>

    <div class="between" style="margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--border)">
      <span>Total a pagar</span>
      <b class="num" style="font-size:1.4rem">${ui.money(resumen.pendiente)}</b>
    </div>

    ${resumen.sinConfirmar ? `
      <div class="alerta alerta--warn" style="margin-top:var(--sp-3)">
        Quedan ${resumen.sinConfirmar} jornadas sin confirmar afuera de esta liquidación.
      </div>` : ''}

    <p class="faint">El egreso en caja se registra automáticamente.</p>

    <button class="btn--confirmar" id="ok" style="margin-top:var(--sp-3)">Confirmar pago</button>
    <button class="btn btn--ghost btn--block" data-close style="margin-top:var(--sp-2);border:none">Cancelar</button>
  `, (root) => {
    root.querySelector('#ok').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Guardando…';
      try {
        const r = await liquidarSemana(fechas[0], fechas[6]);
        ui.cerrarModal();
        ui.toast(`Liquidado ${ui.money(r.total)} · ${r.jornadas} jornadas`);
        await render(vista);
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = 'Confirmar pago';
        ui.toast(err.message, true);
      }
    });
  });
}

function modalTrabajadora(t = null, vista = null) {
  const nueva = !t;
  ui.abrirModal(`
    <h3>${nueva ? 'Nueva trabajadora' : ui.esc(t.nombre)}</h3>
    <div class="stack" style="margin-top:var(--sp-3)">
      <div class="field">
        <label for="t-nombre">Nombre</label>
        <input class="input" id="t-nombre" value="${nueva ? '' : ui.esc(t.nombre)}" autocomplete="off">
      </div>
      <div class="field">
        <label for="t-tel">Teléfono</label>
        <input class="input" id="t-tel" type="tel" value="${nueva ? '' : ui.esc(t.telefono || '')}">
      </div>
      <div class="field">
        <label for="t-tarifa">Tarifa por día</label>
        <input class="input" id="t-tarifa" type="number" inputmode="numeric"
               value="${nueva ? '' : t.tarifa_dia}">
        ${nueva ? '' : '<span class="faint">Si la cambiás, las jornadas ya cargadas mantienen la tarifa vieja.</span>'}
      </div>
      <div class="field">
        <label for="t-pin">PIN de acceso</label>
        <input class="input" id="t-pin" type="number" inputmode="numeric"
               placeholder="${nueva ? '4 dígitos, opcional' : 'Vacío = no cambiarlo'}">
        <span class="faint">Con esto entra a la app y ve solo sus propias jornadas.</span>
      </div>
      ${nueva ? '' : `
        <label class="row" style="gap:var(--sp-2)">
          <input type="checkbox" id="t-activa" ${t.activa ? 'checked' : ''}>
          <span>Activa</span>
        </label>`}
    </div>

    <button class="btn btn--primary btn--block" data-accent="trabajadoras" id="ok"
      style="margin-top:var(--sp-4)">Guardar</button>
    <button class="btn btn--ghost btn--block" data-close style="margin-top:var(--sp-2);border:none">Cancelar</button>
  `, (root) => {
    root.querySelector('#ok').addEventListener('click', async () => {
      try {
        const pin = root.querySelector('#t-pin').value.trim();
        if (pin && !/^\d{4}$/.test(pin)) throw new Error('El PIN tiene que ser de 4 dígitos');

        const guardada = await guardarTrabajadora({
          id: t?.id || null,
          nombre: root.querySelector('#t-nombre').value,
          telefono: root.querySelector('#t-tel').value,
          tarifaDia: root.querySelector('#t-tarifa').value,
          activa: nueva ? true : root.querySelector('#t-activa').checked,
        });

        if (pin) await auth.cambiarPinTrabajadora(guardada.id, pin);

        ui.cerrarModal();
        await state.cargar();
        ui.toast(nueva ? 'Trabajadora agregada' : 'Cambios guardados');
        if (vista) await render(vista);
      } catch (err) {
        ui.toast(err.message, true);
      }
    });
  });
}

function fab(cont, onClick) {
  const b = document.createElement('button');
  b.className = 'fab';
  b.dataset.accent = 'trabajadoras';
  b.setAttribute('aria-label', 'Nueva trabajadora');
  b.textContent = '+';
  b.addEventListener('click', onClick);
  cont.appendChild(b);
}
