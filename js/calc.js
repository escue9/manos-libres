/**
 * calc.js — costeo, márgenes y cierre semanal.
 *
 * Funciones puras: reciben datos, devuelven números. No tocan la base ni el DOM.
 * Esto las hace testeables y es donde vive la lógica que no puede estar mal.
 *
 * Referencia: docs/PDR.md §5
 */

/* ------------------------------------------------------------------ */
/*  Costeo                                                             */
/* ------------------------------------------------------------------ */

/**
 * Costo de insumo por promedio ponderado.
 * Evita que una compra puntual cara o barata distorsione todo el costeo.
 * PDR §5.1
 */
export function costoPonderado(stockPrevio, costoPrevio, cantComprada, costoCompraUnit) {
  const total = stockPrevio + cantComprada;
  if (total <= 0) return costoCompraUnit;
  return (stockPrevio * costoPrevio + cantComprada * costoCompraUnit) / total;
}

/**
 * Costo unitario de un producto a partir de su receta.
 * PDR §5.2 — la mano de obra NO entra acá, se imputa en el cierre semanal.
 *
 * @param {Array} recetaItems  items con { cantidad, merma_pct, insumo_id }
 * @param {Map}   insumosPorId Map de insumo_id → insumo
 * @param {number} rindePorLote
 */
export function costoProducto(recetaItems, insumosPorId, rindePorLote) {
  if (!recetaItems?.length || !rindePorLote) return null;

  const costoLote = recetaItems.reduce((acc, it) => {
    const insumo = insumosPorId.get(it.insumo_id);
    if (!insumo) return acc;
    // TODO Fase 1: conversión de unidades (g↔kg, ml↔l) antes de multiplicar
    return acc + it.cantidad * insumo.costo_unitario * (1 + (it.merma_pct || 0) / 100);
  }, 0);

  return costoLote / rindePorLote;
}

/** Costo efectivo: el de receta si existe, si no el manual. */
export function costoEfectivo(producto) {
  return producto.costo_calculado ?? producto.costo_manual ?? 0;
}

/* ------------------------------------------------------------------ */
/*  Márgenes                                                           */
/* ------------------------------------------------------------------ */

export function margen(precioVenta, costoUnitario) {
  const pesos = precioVenta - costoUnitario;
  return {
    pesos,
    pct: precioVenta > 0 ? (pesos / precioVenta) * 100 : 0,
  };
}

/** Umbral de alerta del PDR §5.4: margen bruto bajo 25%. */
export const MARGEN_MINIMO = 25;

/* ------------------------------------------------------------------ */
/*  Cierre semanal                                                     */
/* ------------------------------------------------------------------ */

/**
 * Cierre por DEVENGADO: se calcula sobre pedidos entregados, no sobre lo cobrado.
 * Ver PDR §5.3 — no confundir con la caja (percibido).
 *
 * @param {Object} datos
 * @param {Array}  datos.pedidos    pedidos con estado 'entregado' del período
 * @param {Array}  datos.items      pedido_item de esos pedidos (con snapshots)
 * @param {Array}  datos.jornadas   jornadas confirmadas del período
 * @param {Array}  datos.gastos     movimiento_caja con origen 'gasto_operativo'
 */
export function cierreSemanal({ pedidos = [], items = [], jornadas = [], gastos = [] }) {
  const idsEntregados = new Set(pedidos.filter((p) => p.estado === 'entregado').map((p) => p.id));
  const itemsVendidos = items.filter((i) => idsEntregados.has(i.pedido_id));

  const bruto = itemsVendidos.reduce((a, i) => a + i.cantidad * i.precio_unitario, 0);
  const descuentos = pedidos
    .filter((p) => idsEntregados.has(p.id))
    .reduce((a, p) => a + (p.descuento || 0), 0);

  const ventas = bruto - descuentos;
  const costoMercaderia = itemsVendidos.reduce((a, i) => a + i.cantidad * i.costo_unitario, 0);

  // Solo las jornadas confirmadas entran al costo laboral (PDR §3, tabla jornada)
  const costoLaboral = jornadas
    .filter((j) => j.confirmada)
    .reduce((a, j) => a + j.tarifa_aplicada, 0);

  const gastosOperativos = gastos.reduce((a, g) => a + g.monto, 0);

  const margenBruto = ventas - costoMercaderia;
  const gananciaNeta = margenBruto - costoLaboral - gastosOperativos;

  return {
    ventas,
    costoMercaderia,
    margenBruto,
    margenBrutoPct: ventas > 0 ? (margenBruto / ventas) * 100 : 0,
    costoLaboral,
    gastosOperativos,
    gananciaNeta,
    gananciaNetaPct: ventas > 0 ? (gananciaNeta / ventas) * 100 : 0,
    semaforo: gananciaNeta < 0 ? 'danger'
            : (ventas > 0 && (gananciaNeta / ventas) * 100 < 15) ? 'warn'
            : 'ok',
  };
}

/**
 * Saldo de caja por PERCIBIDO: solo movimientos efectivos.
 * Nunca mezclar con cierreSemanal() — son dos números distintos y ambos correctos.
 */
export function saldoCaja(movimientos = []) {
  return movimientos.reduce((a, m) => a + (m.tipo === 'ingreso' ? m.monto : -m.monto), 0);
}

/* ------------------------------------------------------------------ */
/*  Rentabilidad por producto                                          */
/* ------------------------------------------------------------------ */

/**
 * Clasifica productos en los cuatro cuadrantes del PDR §4.4.
 * Los umbrales son la mediana del conjunto: siempre relativos al propio negocio.
 */
export function cuadrantes(filas) {
  if (!filas.length) return [];

  const mediana = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const medVol = mediana(filas.map((f) => f.unidades));
  const medMargen = mediana(filas.map((f) => f.margenPct));

  return filas.map((f) => {
    const altoVol = f.unidades >= medVol;
    const altoMargen = f.margenPct >= medMargen;
    return {
      ...f,
      cuadrante: altoMargen && altoVol ? 'estrella'
               : altoMargen && !altoVol ? 'oportunidad'
               : !altoMargen && altoVol ? 'revisar'
               : 'discontinuar',
    };
  });
}
