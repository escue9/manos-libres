/**
 * produccion.js — Insumos · Recetas · Órdenes de producción · Stock terminado
 * Color del módulo: rosa var(--produccion)
 *
 * FASE 1 — ver docs/PDR.md §4.1
 *
 * Pendiente:
 *  [ ] Listado de insumos con nivel de stock y alerta de mínimo
 *  [ ] registrarCompra(): suma stock → recalcula costo ponderado (calc.costoPonderado)
 *      → genera movimiento_caja de egreso → recalcula costo de productos afectados
 *      → avisa si algún producto quedó bajo MARGEN_MINIMO
 *  [ ] Editor de recetas (receta_item) con merma
 *  [ ] Orden de producción: insumos requeridos vs disponibles ANTES de empezar
 *  [ ] cerrarOrden(): descuenta insumos según receta, suma terminados,
 *      congela costo_unitario_snapshot, imputa jornadas vinculadas
 *
 * Reglas que no se negocian:
 *  - No cerrar orden con insumo insuficiente sin ajuste explícito y con motivo
 *  - Todo cambio de stock deja movimiento_stock_*
 *  - Ocultar costos si !auth.puede('verCostos')
 */

import { db } from '../db.js';
import { state } from '../state.js';
import { auth } from '../auth.js';
import { ui } from '../ui.js';
import * as calc from '../calc.js';

export async function render(vista) {
  vista.innerHTML = ui.vacio({
    modulo: 'produccion',
    icono: '\u{1F958}',
    titulo: 'Producción y stock',
    texto: 'Acá vas a cargar los insumos con su costo real, armar las recetas y '
         + 'cerrar cada jornada de cocina. El sistema calcula solo cuánto cuesta '
         + 'cada empanada.',
    fase: 'Fase 1',
  });
}
