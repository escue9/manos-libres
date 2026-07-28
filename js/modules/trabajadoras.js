/**
 * trabajadoras.js — Equipo · Registro semanal · Liquidación
 * Color del módulo: verde var(--equipo)
 *
 * FASE 3 — ver docs/PDR.md §4.3
 *
 * Pendiente:
 *  [ ] Grilla trabajadoras × días (clase .days del CSS): tap crea o borra jornada
 *      con la tarifa vigente congelada desde tarifa_historica
 *  [ ] Liquidación semanal: días × tarifa → confirmar pago → jornadas a 'pagada'
 *      → egreso en caja
 *  [ ] Comprobante simple por trabajadora
 *  [ ] Vista de trabajadora: SOLO sus días y su total. Autoreporte entra con
 *      confirmada=false y no cuenta hasta que el admin lo confirma
 *
 * Reglas:
 *  - Una jornada por trabajadora por día (única por trabajadora_id + fecha)
 *  - Solo jornadas confirmadas entran a liquidación y al costo laboral
 *  - Usar auth.filtrarPropio() SIEMPRE antes de renderizar
 */

import { db } from '../db.js';
import { state } from '../state.js';
import { auth } from '../auth.js';
import { ui } from '../ui.js';

export async function render(vista) {
  vista.innerHTML = ui.vacio({
    modulo: 'trabajadoras',
    icono: '\u{1F4C5}',
    titulo: 'Equipo',
    texto: 'Los días trabajados de cada una y la liquidación semanal, sin cuentas '
         + 'a mano ni discusiones sobre cuántos días fueron.',
    fase: 'Fase 3',
  });
}
