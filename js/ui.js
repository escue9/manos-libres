/**
 * ui.js — helpers de render, formato y modales.
 *
 * Sin framework: se arma HTML con template strings y se inyecta con innerHTML.
 * Regla: todo texto que venga del usuario pasa por esc() antes de interpolarse.
 */

const fmtMoneda = new Intl.NumberFormat('es-AR', {
  style: 'currency', currency: 'ARS', maximumFractionDigits: 0,
});

const fmtFecha = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit' });

/** Estado del modal único. Ver abrirModal() / bloquearModal(). */
let modalBloqueado = false;
let alCerrarModal = null;

/**
 * Convierte a Date tratando 'YYYY-MM-DD' como fecha LOCAL, no como UTC.
 *
 * `new Date('2026-07-28')` es medianoche UTC, que en Argentina todavía es el
 * 27 a las 21:00: sin esto las fechas guardadas se muestran un día antes y
 * inicioSemana() devuelve la semana anterior. Devuelve null si no hay fecha.
 */
function parseLocal(d) {
  if (d == null || d === '') return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) {
    const [a, m, dia] = d.slice(0, 10).split('-').map(Number);
    return new Date(a, m - 1, dia);
  }
  const f = new Date(d);
  return isNaN(f.getTime()) ? null : f;
}

export const ui = {

  /* --- formato --- */

  money(n) { return fmtMoneda.format(Number(n) || 0); },
  pct(n)   { return `${(Number(n) || 0).toFixed(1)}%`; },

  /**
   * Una fecha 'YYYY-MM-DD' se parsea como local, no como UTC.
   * `new Date('2026-07-28')` es medianoche UTC, que en Argentina todavía es el
   * 27 a las 21:00: sin esto, todas las fechas guardadas se muestran un día antes.
   */
  fecha(d) {
    const f = parseLocal(d);
    return f ? fmtFecha.format(f) : '—';
  },

  /** Fecha de hoy en 'YYYY-MM-DD' según el reloj local, no el UTC. */
  hoyISO(fecha = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(fecha.getDate())}`;
  },

  /**
   * Marca de tiempo local para los movimientos de stock.
   *
   * A propósito no es `toISOString()`: eso da UTC, y una venta del domingo a
   * las 21:30 quedaba con el movimiento fechado el lunes mientras el pedido
   * decía domingo. Como los filtros de rango comparan strings, un día entero
   * se caía del reporte. Con el prefijo local, la fecha del movimiento siempre
   * coincide con la del pedido que lo originó.
   */
  ahoraISO(fecha = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const hora = `${p(fecha.getHours())}:${p(fecha.getMinutes())}:${p(fecha.getSeconds())}`;
    return `${this.hoyISO(fecha)}T${hora}`;
  },

  /** 'unidad' es larguísima al lado de un número. En pantalla va como 'u'. */
  unidadCorta(u) { return u === 'unidad' ? 'u' : (u || ''); },

  /** Cantidad con su unidad. Hasta 2 decimales y sin ceros de relleno. */
  cantidad(n, unidad = '') {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    const txt = v.toLocaleString('es-AR', { maximumFractionDigits: 2 });
    return unidad ? `${txt} ${this.unidadCorta(unidad)}` : txt;
  },

  /** Escapa HTML. Usar en TODO lo que venga cargado por el usuario. */
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  },

  /* --- semana --- */

  /**
   * Lunes de la semana de una fecha. La semana operativa arranca lunes.
   * Acepta Date o 'YYYY-MM-DD': con el string, `new Date()` a secas devolvía
   * la semana ANTERIOR para todos los lunes, porque parseaba en UTC.
   */
  inicioSemana(fecha = new Date()) {
    const d = parseLocal(fecha) || new Date();
    const dia = (d.getDay() + 6) % 7;       // 0 = lunes
    d.setDate(d.getDate() - dia);
    d.setHours(0, 0, 0, 0);
    return d;
  },

  finSemana(fecha = new Date()) {
    const d = this.inicioSemana(fecha);
    d.setDate(d.getDate() + 6);
    d.setHours(23, 59, 59, 999);
    return d;
  },

  rangoSemana(fecha = new Date()) {
    return `Semana ${this.fecha(this.inicioSemana(fecha))} – ${this.fecha(this.finSemana(fecha))}`;
  },

  /* --- componentes --- */

  badgeStock(actual, minimo) {
    if (actual <= 0)         return '<span class="badge badge--danger">Sin stock</span>';
    if (actual <= minimo)    return '<span class="badge badge--danger">Crítico</span>';
    if (actual <= minimo * 2) return '<span class="badge badge--warn">Bajo</span>';
    return '<span class="badge badge--ok">OK</span>';
  },

  nivelStock(actual, minimo) {
    const objetivo = Math.max(minimo * 3, 1);
    const pct = Math.min(100, (actual / objetivo) * 100);
    const clase = actual <= minimo ? 'danger' : actual <= minimo * 2 ? 'warn' : '';
    return `<div class="level ${clase}"><i style="width:${pct}%"></i></div>`;
  },

  /**
   * Estado vacío con la identidad del módulo.
   * @param {Object} o
   * @param {string} o.modulo  produccion | pedidos | clientes | trabajadoras | caja
   * @param {string} o.icono   emoji o carácter
   * @param {string} o.titulo
   * @param {string} o.texto   qué va a poder hacer acá cuando esté construido
   * @param {string} o.fase    etiqueta al pie
   */
  vacio({ modulo = '', icono = '·', titulo, texto = '', fase = '' }) {
    return `
      <div class="empty" data-accent="${modulo}">
        <div class="empty__icono">${icono}</div>
        <h3>${this.esc(titulo)}</h3>
        <p>${this.esc(texto)}</p>
        ${fase ? `<span class="empty__fase">${this.esc(fase)}</span>` : ''}
      </div>`;
  },

  /* --- modal --- */

  /**
   * @param {Function} onMount   recibe el nodo de contenido ya montado
   * @param {Function} onCerrar  se llama SIEMPRE que el modal se cierra, por
   *                             donde sea: botón, fondo o cerrarModal() directo
   */
  abrirModal(html, onMount, onCerrar = null) {
    const modal = document.getElementById('modal');
    document.getElementById('modal-content').innerHTML = html;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    modalBloqueado = false;      // cada modal nuevo arranca desbloqueado
    alCerrarModal = onCerrar;

    modal.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => this.cerrarModal(), { once: true })
    );
    onMount?.(document.getElementById('modal-content'));
  },

  /**
   * Traba el cierre mientras una operación está guardando.
   *
   * Antes esto se hacía apagando `pointerEvents` de los `[data-close]`, y como
   * el fondo del modal es un nodo permanente de index.html, el estilo quedaba
   * pegado para el resto de la sesión: después de la primera venta, ningún
   * modal se podía volver a cerrar tocando afuera.
   */
  bloquearModal(v = true) { modalBloqueado = v; },

  cerrarModal() {
    if (modalBloqueado) return false;
    document.getElementById('modal').classList.remove('open');
    document.body.style.overflow = '';

    const cb = alCerrarModal;
    alCerrarModal = null;
    cb?.();
    return true;
  },

  /* --- toast --- */

  toast(msg, esError = false) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = `toast${esError ? ' toast--err' : ''}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  },

  /**
   * Confirmación. Devuelve una promesa que resuelve true/false.
   *
   * Resuelve por CUALQUIER vía de cierre. Antes solo el click en el fondo
   * resolvía `false`: tocar "Cancelar" cerraba el modal y dejaba la promesa
   * colgada para siempre, con el handler que la esperaba a medio ejecutar.
   */
  confirmar(mensaje, textoOk = 'Confirmar') {
    return new Promise((resolve) => {
      let valor = false;
      this.abrirModal(`
        <h3>${this.esc(mensaje)}</h3>
        <div class="row" style="margin-top:var(--sp-4)">
          <button class="btn grow" data-close>Cancelar</button>
          <button class="btn btn--primary grow" id="ok">${this.esc(textoOk)}</button>
        </div>
      `, (root) => {
        root.querySelector('#ok').addEventListener('click', () => { valor = true; this.cerrarModal(); });
      }, () => resolve(valor));
    });
  },
};
