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
  // Un stock negativo es un error de conteo, no mercadería que se deba. Si se
  // lo deja entrar en la fórmula, el promedio se dispara: con −5 kg a $600 y
  // una compra de 10 kg a $2.000, daba $3.400 el kilo — más caro que la bolsa
  // más cara que se compró en la vida.
  const previo = Math.max(0, stockPrevio);
  const total = previo + cantComprada;
  if (total <= 0) return costoCompraUnit;
  return (previo * costoPrevio + cantComprada * costoCompraUnit) / total;
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

  // Un insumo sin costo NO vale cero: vale "todavía no sabemos".
  // Sumarlo como 0 daba una empanada a $50 con 93% de margen y ni una alerta,
  // porque las alertas miran el margen bajo. Se firma el precio tranquilo y el
  // número está mal. Mejor cortar acá, igual que con las unidades.
  const sinCosto = recetaItems.filter((it) => {
    const insumo = insumosPorId.get(it.insumo_id);
    return !insumo || !(insumo.costo_unitario > 0);
  });

  if (sinCosto.length) {
    const nombres = sinCosto
      .map((it) => insumosPorId.get(it.insumo_id)?.nombre || 'un insumo borrado')
      .join(', ');
    throw new Error(`Sin costo cargado: ${nombres}. Registrá la compra primero`);
  }

  const costoLote = recetaItems.reduce(
    (acc, it) => acc + consumoItem(it, insumosPorId.get(it.insumo_id)) * insumosPorId.get(it.insumo_id).costo_unitario,
    0,
  );

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

/**
 * Costo efectivo: el de receta si existe, si no el manual.
 * `||` y no `??` a propósito: un costo calculado en 0 es una receta rota, no
 * un producto gratis, y con `??` le ganaba al costo_manual cargado a mano.
 */
export function costoEfectivo(producto) {
  return producto.costo_calculado || producto.costo_manual || 0;
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
 *
 * Si la fecha es anterior a TODO el historial, se usa la fila más vieja, que
 * es la tarifa más parecida a la que regía entonces. Antes caía al fallback
 * —la tarifa de hoy— y cargar una jornada olvidada del mes pasado la pagaba
 * al valor nuevo, que es exactamente lo que tarifa_historica viene a evitar.
 * El fallback queda solo para quien no tiene ninguna fila histórica.
 *
 * @param {Array}  tarifas  tarifa_historica de UNA trabajadora
 * @param {string} fecha    ISO 'YYYY-MM-DD'
 * @param {number} fallback trabajadora.tarifa_dia
 */
export function tarifaVigente(tarifas = [], fecha, fallback = 0) {
  if (!tarifas.length) return fallback;

  const ordenadas = [...tarifas].sort((a, b) => (a.vigente_desde < b.vigente_desde ? 1 : -1));
  const vigente = ordenadas.find((t) => t.vigente_desde <= fecha);

  return vigente ? vigente.tarifa_dia : ordenadas[ordenadas.length - 1].tarifa_dia;
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
/*  Pedidos y clientes                                                 */
/* ------------------------------------------------------------------ */

/**
 * Tolerancia de centavo. Un pedido de $16.600 cobrado en dos veces puede dar
 * 16.599,999999 por el redondeo binario: sin esto queda "con seña" para
 * siempre y aparece en las alertas de cobro pendiente todas las semanas.
 */
const EPS = 1e-6;

/**
 * Estado de pago derivado de los cobros. NUNCA se carga a mano: es el reflejo
 * de la suma de la tabla `cobro` contra el total del pedido (PDR §3).
 */
export function estadoPago(total, cobrado = 0) {
  const t = Number(total) || 0;
  const c = Number(cobrado) || 0;
  if (c + EPS >= t) return 'pagado';
  if (c <= 0) return 'impago';
  return 'sena';
}

/** Segmento por cantidad de pedidos. PDR §3 — campos derivados de `cliente`. */
export function segmentoCliente(cantidadPedidos = 0) {
  if (cantidadPedidos >= 5) return 'fiel';
  if (cantidadPedidos >= 2) return 'frecuente';
  return 'nuevo';
}

/**
 * Resumen derivado de un cliente a partir de SUS pedidos.
 *
 * Los anulados no cuentan para nada: ni al segmento, ni al total, ni al ticket
 * promedio. Un pedido que se cargó mal y se dio de baja no convierte a nadie en
 * cliente frecuente.
 *
 * `impago` mira solo los entregados: lo que está en camino todavía no se debe.
 */
export function resumenCliente(pedidos = []) {
  const validos = pedidos.filter((p) => p.estado !== 'cancelado');
  const total = validos.reduce((a, p) => a + (p.total || 0), 0);

  const ultimo = validos.reduce(
    (a, p) => (p.fecha_pedido && (!a || p.fecha_pedido > a) ? p.fecha_pedido : a), null,
  );

  const impago = validos
    .filter((p) => p.estado === 'entregado')
    .reduce((a, p) => a + Math.max(0, (p.total || 0) - (p.monto_cobrado || 0)), 0);

  return {
    cantidad: validos.length,
    total,
    ticket: validos.length ? total / validos.length : 0,
    ultimo,
    impago,
    segmento: segmentoCliente(validos.length),
  };
}

/* ------------------------------------------------------------------ */
/*  Rentabilidad por producto                                          */
/* ------------------------------------------------------------------ */

/**
 * Clasifica productos en los cuatro cuadrantes del PDR §4.4.
 * Los umbrales son la mediana del conjunto: siempre relativos al propio negocio.
 */
/**
 * Rentabilidad por producto sobre lo entregado en el período.
 *
 * Usa los snapshots de `pedido_item`, nunca los precios ni los costos de hoy
 * (regla 4): si en el medio subió la harina, la semana pasada no cambia.
 *
 * El descuento se prorratea entre las líneas del pedido en proporción a lo que
 * pesa cada una. Sin prorratearlo, la suma de la facturación por producto no
 * da igual que las ventas del cierre, y dos pantallas que miran lo mismo
 * mostrarían números distintos.
 */
export function rentabilidadProductos({ pedidos = [], items = [], productos = [] }) {
  const entregados = new Map(
    pedidos.filter((p) => p.estado === 'entregado').map((p) => [p.id, p]),
  );

  // Cuánto factura cada pedido antes del descuento, para saber qué proporción
  // del descuento le toca a cada línea.
  const brutoPorPedido = new Map();
  for (const i of items) {
    if (!entregados.has(i.pedido_id)) continue;
    const monto = i.cantidad * i.precio_unitario;
    brutoPorPedido.set(i.pedido_id, (brutoPorPedido.get(i.pedido_id) || 0) + monto);
  }

  const nombres = new Map(productos.map((p) => [p.id, p.nombre]));
  const acc = new Map();

  for (const i of items) {
    const pedido = entregados.get(i.pedido_id);
    if (!pedido) continue;

    const bruto = i.cantidad * i.precio_unitario;
    const brutoPedido = brutoPorPedido.get(i.pedido_id) || 0;
    const proporcion = brutoPedido > 0 ? bruto / brutoPedido : 0;
    const descuento = (pedido.descuento || 0) * proporcion;

    const fila = acc.get(i.producto_id) || {
      producto_id: i.producto_id,
      nombre: nombres.get(i.producto_id) || 'Producto dado de baja',
      unidades: 0, facturacion: 0, costo: 0,
    };

    fila.unidades += i.cantidad;
    fila.facturacion += bruto - descuento;
    fila.costo += i.cantidad * i.costo_unitario;
    acc.set(i.producto_id, fila);
  }

  const filas = [...acc.values()];
  const total = filas.reduce((a, f) => a + f.facturacion, 0);

  return filas
    .map((f) => ({
      ...f,
      margen: f.facturacion - f.costo,
      margenPct: f.facturacion > 0 ? ((f.facturacion - f.costo) / f.facturacion) * 100 : 0,
      aportePct: total > 0 ? (f.facturacion / total) * 100 : 0,
    }))
    .sort((a, b) => b.facturacion - a.facturacion);
}

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
