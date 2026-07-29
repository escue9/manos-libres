/**
 * calc.js — costeo, márgenes y cierre semanal.
 *
 * Funciones puras: reciben datos, devuelven números. No tocan la base ni el DOM.
 * Esto las hace testeables y es donde vive la lógica que no puede estar mal.
 *
 * Referencia: docs/PDR.md §5
 */

/* ------------------------------------------------------------------ */
/*  Unidades                                                           */
/* ------------------------------------------------------------------ */

/**
 * Cuánto vale cada unidad en la unidad base de su familia.
 * La base de masa es el gramo y la de volumen el mililitro.
 */
const EN_BASE = { kg: 1000, g: 1, l: 1000, ml: 1, unidad: 1 };

const FAMILIA = { kg: 'masa', g: 'masa', l: 'volumen', ml: 'volumen', unidad: 'unidad' };

export const UNIDADES = Object.keys(FAMILIA);

/** Las unidades a las que se puede convertir una dada. Para armar los selects. */
export function unidadesCompatibles(unidad) {
  const fam = FAMILIA[unidad];
  return fam ? UNIDADES.filter((u) => FAMILIA[u] === fam) : [unidad];
}

export function sonCompatibles(a, b) {
  return a === b || (!!FAMILIA[a] && FAMILIA[a] === FAMILIA[b]);
}

/**
 * Convierte una cantidad entre unidades de la misma familia (g↔kg, ml↔l).
 *
 * Tira error si las unidades no son compatibles en vez de devolver un número.
 * Un costo mal convertido no se nota mirando la pantalla: se nota tres meses
 * después, cuando el margen histórico no cierra. Mejor que falle fuerte.
 */
export function convertir(cantidad, desde, hacia) {
  if (desde === hacia || desde == null || hacia == null) return cantidad;
  if (!sonCompatibles(desde, hacia)) {
    throw new Error(`No se puede convertir de ${desde} a ${hacia}`);
  }
  return (cantidad * EN_BASE[desde]) / EN_BASE[hacia];
}

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
 * Cuánto insumo consume un item de receta, expresado en la unidad del insumo.
 * La merma es desperdicio esperado: se compra de más para producir lo mismo.
 *
 * @param {Object} item   receta_item con { cantidad, unidad_medida, merma_pct }
 * @param {Object} insumo el insumo, para saber a qué unidad convertir
 * @param {number} lotes  cuántas vueltas de receta
 */
export function consumoItem(item, insumo, lotes = 1) {
  const cant = convertir(item.cantidad, item.unidad_medida ?? insumo.unidad_medida, insumo.unidad_medida);
  return cant * lotes * (1 + (item.merma_pct || 0) / 100);
}

/**
 * Costo unitario de un producto a partir de su receta.
 * PDR §5.2 — la mano de obra NO entra acá, se imputa en el cierre semanal.
 *
 * @param {Array} recetaItems  items con { cantidad, unidad_medida, merma_pct, insumo_id }
 * @param {Map}   insumosPorId Map de insumo_id → insumo
 * @param {number} rindePorLote
 */
export function costoProducto(recetaItems, insumosPorId, rindePorLote) {
  if (!recetaItems?.length || !rindePorLote) return null;

  const costoLote = recetaItems.reduce((acc, it) => {
    const insumo = insumosPorId.get(it.insumo_id);
    if (!insumo) return acc;
    return acc + consumoItem(it, insumo) * (insumo.costo_unitario || 0);
  }, 0);

  return costoLote / rindePorLote;
}

/**
 * Insumo total que hace falta para producir una lista de productos.
 * Lo usan la tabla de "requeridos vs disponibles" y el cierre de la orden:
 * el mismo cálculo en los dos lados, para que lo que se muestra sea
 * exactamente lo que después se descuenta.
 *
 * @param {Array} planificado  [{ producto, cantidad }]
 * @param {Map}   recetasPorProducto  producto_id → receta_item[]
 * @param {Map}   insumosPorId
 * @returns {Map} insumo_id → cantidad en la unidad del insumo
 */
export function consumoTotal(planificado, recetasPorProducto, insumosPorId) {
  const total = new Map();

  for (const { producto, cantidad } of planificado) {
    const receta = recetasPorProducto.get(producto.id) || [];
    const rinde = producto.rinde_por_lote || 1;
    const lotes = cantidad / rinde;

    for (const it of receta) {
      const insumo = insumosPorId.get(it.insumo_id);
      if (!insumo) continue;
      total.set(it.insumo_id, (total.get(it.insumo_id) || 0) + consumoItem(it, insumo, lotes));
    }
  }

  return total;
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
/*  Mano de obra                                                       */
/* ------------------------------------------------------------------ */

/**
 * Tarifa vigente de una trabajadora a una fecha dada.
 *
 * Se busca en tarifa_historica, NO en trabajadora.tarifa_dia: si la tarifa
 * subió en marzo, una jornada de febrero se sigue liquidando con la vieja.
 * El fallback existe para las trabajadoras cargadas antes de que hubiera
 * historial (PDR §3, tarifa_historica).
 *
 * @param {Array}  tarifas  tarifa_historica de UNA trabajadora
 * @param {string} fecha    ISO 'YYYY-MM-DD'
 * @param {number} fallback trabajadora.tarifa_dia
 */
export function tarifaVigente(tarifas = [], fecha, fallback = 0) {
  const vigentes = tarifas
    .filter((t) => t.vigente_desde <= fecha)
    .sort((a, b) => (a.vigente_desde < b.vigente_desde ? 1 : -1));
  return vigentes.length ? vigentes[0].tarifa_dia : fallback;
}

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
