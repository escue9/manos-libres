/**
 * state.js — estado en memoria + eventos.
 *
 * Cachea las tablas que se leen todo el tiempo (productos, insumos, clientes)
 * para no ir a IndexedDB en cada render. Las tablas transaccionales (pedidos,
 * movimientos) se consultan directo con db.from() cuando se necesitan.
 *
 * Después de cualquier escritura: llamar a state.invalidar() para refrescar.
 */

import { db } from './db.js';
import { auth } from './auth.js';

const listeners = new Map();

/**
 * Lo que de una trabajadora puede vivir en memoria según quién esté logueada.
 *
 * El hash del PIN no lo necesita nadie: sacarlo siempre. La tarifa ajena la
 * prohíbe la regla 8, y ocultarla solo al renderizar no alcanza — el dato
 * seguía estando a un `state.trabajadoras` de distancia en la consola.
 * El nombre sí queda: la orden de producción abierta muestra con quién se
 * está cocinando ese día (decisión de la fase 3, docs/FASE-3.md).
 */
function recortarTrabajadora(t) {
  const { pin_acceso, ...resto } = t;
  if (auth.puede('verEquipoCompleto') || t.id === auth.trabajadoraId) return resto;

  const { tarifa_dia, telefono, ...publico } = resto;
  return publico;
}

export const state = {
  unidadNegocio: null,
  productos: [],
  insumos: [],
  trabajadoras: [],
  clientes: [],
  tabActual: 'produccion',

  async cargar() {
    this.unidadNegocio = await db.from('unidad_negocio').select().single();
    const un = this.unidadNegocio?.id;

    const [productos, insumos, trabajadoras, clientes] = await Promise.all([
      db.from('producto').select().eq('unidad_negocio_id', un).order('nombre'),
      db.from('insumo').select().eq('unidad_negocio_id', un).order('nombre'),
      db.from('trabajadora').select().eq('unidad_negocio_id', un).eq('activa', true).order('nombre'),
      db.from('cliente').select().order('nombre'),
    ]);

    this.productos = productos;
    this.insumos = insumos;
    this.clientes = clientes;
    this.trabajadoras = trabajadoras.map(recortarTrabajadora);
  },

  /** Recarga los datos y avisa a las vistas para que se re-rendericen. */
  async invalidar() {
    await this.cargar();
    this.emit('cambio');
  },

  productoPorId(id)    { return this.productos.find((p) => p.id === id); },
  insumoPorId(id)      { return this.insumos.find((i) => i.id === id); },
  trabajadoraPorId(id) { return this.trabajadoras.find((t) => t.id === id); },

  /** Map insumo_id → insumo, para calc.costoProducto() */
  get insumosMap() { return new Map(this.insumos.map((i) => [i.id, i])); },

  /* --- eventos --- */
  on(evento, fn) {
    if (!listeners.has(evento)) listeners.set(evento, new Set());
    listeners.get(evento).add(fn);
    return () => listeners.get(evento).delete(fn);
  },

  emit(evento, payload) {
    (listeners.get(evento) || []).forEach((fn) => fn(payload));
  },
};
