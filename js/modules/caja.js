/**
 * caja.js — Caja · Cierre semanal · Rentabilidad por producto · Reportes
 * Color del módulo: azul var(--caja)
 *
 * FASE 4 — ver docs/PDR.md §4.4
 *
 * Pendiente:
 *  [ ] Libro de movimientos con filtro por origen y medio
 *  [ ] Cierre semanal usando calc.cierreSemanal() — hero con semáforo
 *      y comparación contra la semana anterior
 *  [ ] Rentabilidad por producto + cuadrantes (calc.cuadrantes)
 *  [ ] Carga manual solo de gasto_operativo / aporte / retiro
 *  [ ] Exportables: rendición de cuentas PDF, impacto social PDF, CSV crudo
 *
 * Reglas:
 *  - Rentabilidad = devengado (pedidos entregados).
 *    Caja = percibido (cobros efectivos). Se muestran separadas, nunca sumadas
 *  - Los movimientos de cobro, compra y jornal se generan solos: no cargarlos
 *    a mano o se produce doble conteo
 *  - Módulo solo para admin y dirigente
 *
 * El reporte de impacto social (jornadas generadas, monto pagado en jornales,
 * trabajadoras activas) es el que piden los concursos de financiamiento.
 */

import { db } from '../db.js';
import { state } from '../state.js';
import { auth } from '../auth.js';
import { ui } from '../ui.js';
import * as calc from '../calc.js';

export async function render(vista) {
  vista.innerHTML = ui.vacio({
    modulo: 'caja',
    icono: '\u{1F4CA}',
    titulo: 'Caja y rentabilidad',
    texto: 'Cuánto entró, cuánto salió y cuánto quedó. Con el reporte de rendición '
         + 'de cuentas listo para presentar.',
    fase: 'Fase 4',
  });
}
