/**
 * auth.js — roles, PIN y permisos.
 *
 * Login por PIN, sin email ni contraseñas: las trabajadoras entran desde el
 * celular, rápido y sin fricción.
 *
 * PRINCIPIO (PDR §2): una trabajadora ve solo lo propio. Nunca la tarifa, los
 * días ni la liquidación de otra. Nunca costos, márgenes ni ganancias.
 *
 * TODO Fase 5:
 *  - Reemplazar por Supabase Auth + RLS. Las políticas de RLS deben espejar
 *    exactamente la tabla PERMISOS de abajo.
 */

import { db } from './db.js';

const PERMISOS = {
  admin: {
    etiqueta: 'Administración',
    tabs: ['produccion', 'pedidos', 'clientes', 'trabajadoras', 'caja'],
    verCostos: true,
    verMargenes: true,
    verEquipoCompleto: true,
    editarPrecios: true,
    gestionarInsumos: true,
    cargarProduccion: true,
    gestionarClientes: true,
    cargarPedidos: true,
    anularPedidos: true,
    gestionarCanalWeb: true,
    cargarCaja: true,
    liquidar: true,
    exportar: true,
  },
  trabajadora: {
    etiqueta: 'Trabajadora',
    tabs: ['produccion', 'pedidos', 'trabajadoras'],
    verCostos: false,
    verMargenes: false,
    verEquipoCompleto: false,   // solo se ve a sí misma
    editarPrecios: false,
    gestionarInsumos: false,    // no compra ni edita insumos ni recetas
    cargarProduccion: true,     // sí carga órdenes, las cierra y cuenta stock
    gestionarClientes: true,    // toma el pedido y carga al cliente en el momento
    cargarPedidos: true,        // vende, entrega y cobra: es su trabajo
    anularPedidos: false,       // deshacer una venta mueve stock Y caja
    gestionarCanalWeb: false,   // publicar precios al público es de administración
    cargarCaja: false,          // no ve la caja siquiera (regla 8)
    liquidar: false,
    exportar: false,
  },
  dirigente: {                   // fase 2 — solo lectura
    etiqueta: 'Comisión',
    tabs: ['caja'],
    verCostos: true,
    verMargenes: true,
    verEquipoCompleto: false,
    editarPrecios: false,
    gestionarInsumos: false,
    cargarProduccion: false,    // la comisión mira, no opera
    gestionarClientes: false,
    cargarPedidos: false,
    anularPedidos: false,
    gestionarCanalWeb: false,
    cargarCaja: false,          // la comisión mira, no opera
    liquidar: false,
    exportar: true,
  },
};

const SESION_KEY = 'cocina_cic_sesion';
const LARGO_PIN = 4;

/* ------------------------------------------------------------------ */
/*  Hash                                                               */
/* ------------------------------------------------------------------ */

/**
 * El salt se genera una vez por instalación y vive en config.
 * Sin salt, cuatro dígitos se rompen con una tabla precalculada en segundos.
 */
async function salt() {
  let s = await db.getConfig('pin_salt');
  if (!s) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    s = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    await db.setConfig('pin_salt', s);
  }
  return s;
}

async function hashPin(pin) {
  const data = new TextEncoder().encode(`${await salt()}:${pin}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

export const auth = {
  rol: null,
  trabajadoraId: null,
  nombre: null,

  LARGO_PIN,

  /* --- estado --- */

  get autenticado() { return this.rol !== null; },
  get permisos() { return PERMISOS[this.rol] || PERMISOS.trabajadora; },

  puede(accion) { return !!this.permisos[accion]; },
  puedeVer(tab)  { return this.permisos.tabs.includes(tab); },

  /**
   * Valida un permiso y corta si no lo tiene.
   *
   * Va al principio de toda función que escriba datos sensibles. Ocultar el
   * botón en la interfaz no alcanza: desde la consola la función sigue siendo
   * invocable, y sobre todo el permiso queda escrito en un solo lugar (la UI)
   * en vez de en el contrato de la función.
   *
   * En la fase 5 cada exigir() de acá tiene que tener su política de RLS
   * equivalente en Supabase. Si el cliente no valida, la primera señal de que
   * falta una política va a ser un error en producción.
   */
  exigir(accion) {
    if (!this.puede(accion)) {
      throw new Error(`Sin permiso para ${accion} (rol: ${this.rol || 'sin sesión'})`);
    }
  },

  /** Primera tab visible para el rol actual. Evita aterrizar en una prohibida. */
  get tabInicial() { return this.permisos.tabs[0]; },

  /* --- alta de PIN --- */

  /** ¿Ya hay un PIN de administrador configurado? Si no, es el primer arranque. */
  async hayAdmin() {
    return !!(await db.getConfig('admin_pin'));
  },

  /**
   * ¿Ese hash ya lo usa otra persona?
   *
   * ingresar() prueba el PIN primero contra el admin y después contra cada
   * trabajadora, así que un PIN repetido no da error: te loguea como la otra
   * persona. Con 1234 —el PIN más elegido del mundo— una trabajadora entraba
   * como administración y veía la caja, los costos y la tarifa de sus
   * compañeras. Rompe la regla 8 de punta a punta.
   */
  async _pinEnUso(hash, exceptoTrabajadoraId = null) {
    if (hash === await db.getConfig('admin_pin')) return true;
    const trabajadoras = await db.from('trabajadora').select();
    return trabajadoras.some((t) => t.pin_acceso === hash && t.id !== exceptoTrabajadoraId);
  },

  async crearPinAdmin(pin, nombre = 'Administración') {
    if (!/^\d{4}$/.test(pin)) throw new Error('El PIN tiene que ser de 4 dígitos');
    const h = await hashPin(pin);
    if (await this._pinEnUso(h)) throw new Error('Ese PIN ya está en uso, elegí otro');
    await db.setConfig('admin_pin', h);
    await db.setConfig('admin_nombre', nombre);
  },

  async cambiarPinTrabajadora(trabajadoraId, pin) {
    if (!/^\d{4}$/.test(pin)) throw new Error('El PIN tiene que ser de 4 dígitos');
    const h = await hashPin(pin);
    if (await this._pinEnUso(h, trabajadoraId)) throw new Error('Ese PIN ya está en uso, elegí otro');
    await db.from('trabajadora').update({ pin_acceso: h }).eq('id', trabajadoraId);
  },

  /* --- login --- */

  /**
   * Prueba el PIN contra el admin y contra cada trabajadora.
   * Devuelve la sesión si coincide, null si no.
   */
  async ingresar(pin) {
    const h = await hashPin(pin);

    if (h === await db.getConfig('admin_pin')) {
      this._setSesion({
        rol: 'admin',
        trabajadoraId: null,
        nombre: await db.getConfig('admin_nombre', 'Administración'),
      });
      return { rol: 'admin' };
    }

    const trabajadoras = await db.from('trabajadora').select().eq('activa', true);
    const t = trabajadoras.find((x) => x.pin_acceso && x.pin_acceso === h);
    if (t) {
      this._setSesion({ rol: 'trabajadora', trabajadoraId: t.id, nombre: t.nombre });
      return { rol: 'trabajadora', trabajadora: t };
    }

    return null;
  },

  _setSesion({ rol, trabajadoraId, nombre }) {
    this.rol = rol;
    this.trabajadoraId = trabajadoraId;
    this.nombre = nombre;
    try {
      sessionStorage.setItem(SESION_KEY, JSON.stringify({ rol, trabajadoraId, nombre }));
    } catch { /* modo privado: la sesión dura lo que dura la pestaña */ }
  },

  /** Restaura la sesión al recargar. Devuelve true si había una activa. */
  restaurarSesion() {
    try {
      const raw = sessionStorage.getItem(SESION_KEY);
      if (!raw) return false;
      const s = JSON.parse(raw);
      if (!PERMISOS[s.rol]) return false;
      this.rol = s.rol;
      this.trabajadoraId = s.trabajadoraId;
      this.nombre = s.nombre;
      return true;
    } catch { return false; }
  },

  salir() {
    this.rol = null;
    this.trabajadoraId = null;
    this.nombre = null;
    try { sessionStorage.removeItem(SESION_KEY); } catch { /* noop */ }
  },

  /* --- helpers de privacidad --- */

  /**
   * Filtra un listado para que una trabajadora solo vea lo propio.
   * Usalo SIEMPRE antes de renderizar jornadas o liquidaciones.
   */
  filtrarPropio(filas, campo = 'trabajadora_id') {
    if (this.permisos.verEquipoCompleto) return filas;
    return filas.filter((f) => f[campo] === this.trabajadoraId);
  },

  /** Devuelve '—' en lugar del número si el rol no puede ver plata sensible. */
  ocultarSiNoPuede(valor, accion = 'verCostos') {
    return this.puede(accion) ? valor : '—';
  },
};
