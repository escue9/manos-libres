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
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [a, m, dia] = d.split('-').map(Number);
      return fmtFecha.format(new Date(a, m - 1, dia));
    }
    return fmtFecha.format(d instanceof Date ? d : new Date(d));
  },

  /** Fecha de hoy en 'YYYY-MM-DD' según el reloj local, no el UTC. */
  hoyISO(fecha = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(fecha.getDate())}`;
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

  /** Lunes de la semana de una fecha. La semana operativa arranca lunes. */
  inicioSemana(fecha = new Date()) {
    const d = new Date(fecha);
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

  abrirModal(html, onMount) {
    const modal = document.getElementById('modal');
    document.getElementById('modal-content').innerHTML = html;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    modal.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => this.cerrarModal(), { once: true })
    );
    onMount?.(document.getElementById('modal-content'));
  },

  cerrarModal() {
    document.getElementById('modal').classList.remove('open');
    document.body.style.overflow = '';
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

  /** Confirmación. Devuelve una promesa que resuelve true/false. */
  confirmar(mensaje, textoOk = 'Confirmar') {
    return new Promise((resolve) => {
      this.abrirModal(`
        <h3>${this.esc(mensaje)}</h3>
        <div class="row" style="margin-top:var(--sp-4)">
          <button class="btn grow" data-close>Cancelar</button>
          <button class="btn btn--primary grow" id="ok">${this.esc(textoOk)}</button>
        </div>
      `, (root) => {
        root.querySelector('#ok').addEventListener('click', () => { this.cerrarModal(); resolve(true); });
        document.querySelector('.modal__backdrop').addEventListener('click', () => resolve(false), { once: true });
      });
    });
  },
};
