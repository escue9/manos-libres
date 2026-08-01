/**
 * qr.js — generador de códigos QR, en vanilla y sin dependencias.
 *
 * Existe porque el catálogo se pega impreso en la pared del CIC y las reglas
 * del proyecto no admiten librerías externas (regla 2). Una API tipo
 * api.qrserver.com además rompería la regla 3: el día que haya que reimprimir
 * el cartel sin internet, no habría QR.
 *
 * Alcance: modo byte, corrección de errores M (recupera ~15%), versiones 1 a
 * 10 — hasta 213 caracteres, de sobra para una URL. No hace falta más.
 *
 * Referencia: ISO/IEC 18004. Los nombres siguen al estándar para que se pueda
 * seguir con la norma al lado.
 */

/* ------------------------------------------------------------------ */
/*  Aritmética en GF(256)                                              */
/* ------------------------------------------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;   // polinomio primitivo del estándar
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Polinomio generador de grado n: producto de (x - α^i). */
function generador(n) {
  let p = [1];
  for (let i = 0; i < n; i++) {
    const q = new Array(p.length + 1).fill(0);
    for (let j = 0; j < p.length; j++) {
      q[j] ^= p[j];                      // término en x
      q[j + 1] ^= mul(p[j], EXP[i]);     // término independiente
    }
    p = q;
  }
  return p;
}

/** Los n codewords de corrección de una tira de datos. */
export function correccion(datos, n) {
  const g = generador(n);
  const buf = new Uint8Array(datos.length + n);
  buf.set(datos);

  for (let i = 0; i < datos.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 0; j < g.length; j++) buf[i + j] ^= mul(g[j], factor);
  }
  return [...buf.slice(datos.length)];
}

/* ------------------------------------------------------------------ */
/*  Tablas por versión — nivel de corrección M                         */
/* ------------------------------------------------------------------ */

/** [codewords de corrección por bloque, bloques g1, datos g1, bloques g2, datos g2] */
const BLOQUES_M = {
  1:  [10, 1, 16, 0, 0],
  2:  [16, 1, 28, 0, 0],
  3:  [26, 1, 44, 0, 0],
  4:  [18, 2, 32, 0, 0],
  5:  [24, 2, 43, 0, 0],
  6:  [16, 4, 27, 0, 0],
  7:  [18, 4, 31, 0, 0],
  8:  [22, 2, 38, 2, 39],
  9:  [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

/** Centros de los patrones de alineación. */
const ALINEACION = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const datosTotales = (v) => {
  const [, b1, d1, b2, d2] = BLOQUES_M[v];
  return b1 * d1 + b2 * d2;
};

/** El indicador de cantidad de caracteres pasa de 8 a 16 bits en la versión 10. */
const bitsCuenta = (v) => (v < 10 ? 8 : 16);

/** La versión más chica donde entra el texto. */
function versionPara(bytes) {
  for (let v = 1; v <= 10; v++) {
    const capacidad = datosTotales(v) * 8 - 4 - bitsCuenta(v);
    if (bytes.length * 8 <= capacidad) return v;
  }
  throw new Error('El texto no entra en un QR de hasta versión 10.');
}

/* ------------------------------------------------------------------ */
/*  Codificación de los datos                                          */
/* ------------------------------------------------------------------ */

function codificar(bytes, version) {
  const bits = [];
  const empujar = (valor, largo) => {
    for (let i = largo - 1; i >= 0; i--) bits.push((valor >> i) & 1);
  };

  empujar(0b0100, 4);                        // modo byte
  empujar(bytes.length, bitsCuenta(version));
  for (const b of bytes) empujar(b, 8);

  const capacidad = datosTotales(version) * 8;
  // Terminador: hasta cuatro ceros, o menos si ya no entran.
  empujar(0, Math.min(4, capacidad - bits.length));
  while (bits.length % 8) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  // Relleno alternado, tal cual lo fija la norma.
  const RELLENO = [0xec, 0x11];
  while (codewords.length < datosTotales(version)) {
    codewords.push(RELLENO[(codewords.length - bits.length / 8) % 2]);
  }
  return codewords;
}

/** Parte en bloques, calcula la corrección de cada uno y los intercala. */
function intercalar(codewords, version) {
  const [nEC, b1, d1, b2, d2] = BLOQUES_M[version];

  const bloques = [];
  let i = 0;
  for (let n = 0; n < b1; n++) { bloques.push(codewords.slice(i, i + d1)); i += d1; }
  for (let n = 0; n < b2; n++) { bloques.push(codewords.slice(i, i + d2)); i += d2; }

  const ec = bloques.map((b) => correccion(b, nEC));

  const salida = [];
  const maxDatos = Math.max(d1, d2);
  for (let c = 0; c < maxDatos; c++) {
    for (const b of bloques) if (c < b.length) salida.push(b[c]);
  }
  for (let c = 0; c < nEC; c++) {
    for (const b of ec) salida.push(b[c]);
  }
  return salida;
}

/* ------------------------------------------------------------------ */
/*  Información de formato y de versión — BCH                          */
/* ------------------------------------------------------------------ */

function bch(valor, generador, gradoGen) {
  let v = valor;
  const bitsGen = 32 - Math.clz32(generador);
  while (32 - Math.clz32(v) >= bitsGen) {
    v ^= generador << ((32 - Math.clz32(v)) - bitsGen);
  }
  return v;
}

/** 15 bits: 2 de nivel de corrección, 3 de máscara, 10 de BCH, con XOR fijo. */
function formato(mascara) {
  const datos = (0b00 << 3) | mascara;             // 00 = nivel M
  const resto = bch(datos << 10, 0b10100110111);
  return ((datos << 10) | resto) ^ 0b101010000010010;
}

/** 18 bits, solo para versiones 7 en adelante. */
function infoVersion(v) {
  return (v << 12) | bch(v << 12, 0b1111100100101);
}

/* ------------------------------------------------------------------ */
/*  Armado de la matriz                                                */
/* ------------------------------------------------------------------ */

const MASCARAS = [
  (f, c) => (f + c) % 2 === 0,
  (f) => f % 2 === 0,
  (f, c) => c % 3 === 0,
  (f, c) => (f + c) % 3 === 0,
  (f, c) => (Math.floor(f / 2) + Math.floor(c / 3)) % 2 === 0,
  (f, c) => ((f * c) % 2) + ((f * c) % 3) === 0,
  (f, c) => (((f * c) % 2) + ((f * c) % 3)) % 2 === 0,
  (f, c) => (((f + c) % 2) + ((f * c) % 3)) % 2 === 0,
];

function esqueleto(version) {
  const n = version * 4 + 17;
  const m = Array.from({ length: n }, () => new Array(n).fill(null));

  const finder = (f0, c0) => {
    for (let f = -1; f <= 7; f++) {
      for (let c = -1; c <= 7; c++) {
        if (f0 + f < 0 || f0 + f >= n || c0 + c < 0 || c0 + c >= n) continue;
        const borde = f === -1 || f === 7 || c === -1 || c === 7;
        const anillo = f === 0 || f === 6 || c === 0 || c === 6;
        const centro = f >= 2 && f <= 4 && c >= 2 && c <= 4;
        m[f0 + f][c0 + c] = !borde && (anillo || centro);
      }
    }
  };

  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);

  // Patrones de alineación, salteando los que pisarían un finder.
  const ejes = ALINEACION[version];
  for (const f0 of ejes) {
    for (const c0 of ejes) {
      if ((f0 < 8 && c0 < 8) || (f0 < 8 && c0 > n - 9) || (f0 > n - 9 && c0 < 8)) continue;
      for (let f = -2; f <= 2; f++) {
        for (let c = -2; c <= 2; c++) {
          m[f0 + f][c0 + c] = Math.max(Math.abs(f), Math.abs(c)) !== 1;
        }
      }
    }
  }

  // Patrones de sincronismo.
  for (let i = 8; i < n - 8; i++) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
  }

  m[n - 8][8] = true;   // módulo oscuro, siempre encendido

  return m;
}

/** Reserva los lugares de formato y versión para que no los pise el dato. */
function reservados(version) {
  const n = version * 4 + 17;
  const r = Array.from({ length: n }, () => new Array(n).fill(false));

  for (let i = 0; i < 9; i++) { r[8][i] = true; r[i][8] = true; }
  for (let i = 0; i < 8; i++) { r[8][n - 1 - i] = true; r[n - 1 - i][8] = true; }

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) { r[i][n - 11 + j] = true; r[n - 11 + j][i] = true; }
    }
  }
  return r;
}

/** Recorrido en zigzag de abajo a la derecha hacia arriba, de a dos columnas. */
function ubicarDatos(m, reserva, bytes) {
  const n = m.length;
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

  let k = 0;
  let arriba = true;

  for (let c = n - 1; c > 0; c -= 2) {
    if (c === 6) c--;                       // la columna de sincronismo no cuenta
    for (let paso = 0; paso < n; paso++) {
      const f = arriba ? n - 1 - paso : paso;
      for (const cc of [c, c - 1]) {
        if (m[f][cc] !== null || reserva[f][cc]) continue;
        m[f][cc] = k < bits.length ? bits[k] === 1 : false;
        k++;
      }
    }
    arriba = !arriba;
  }
}

function aplicarMascara(m, reserva, esqueletoFijo, mascara) {
  const n = m.length;
  const salida = m.map((fila) => [...fila]);
  for (let f = 0; f < n; f++) {
    for (let c = 0; c < n; c++) {
      if (esqueletoFijo[f][c] !== null || reserva[f][c]) continue;
      if (MASCARAS[mascara](f, c)) salida[f][c] = !salida[f][c];
    }
  }
  return salida;
}

function escribirFormato(m, mascara) {
  const n = m.length;
  const bits = formato(mascara);
  const bit = (i) => ((bits >> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);

  // La segunda copia se parte 7 + 8, no 8 + 7: la fila n-8 de esa columna es
  // el módulo oscuro, que va siempre encendido y no lleva formato.
  for (let i = 0; i <= 6; i++) m[n - 1 - i][8] = bit(i);
  for (let i = 7; i <= 14; i++) m[8][n - 15 + i] = bit(i);
}

function escribirVersion(m, version) {
  if (version < 7) return;
  const n = m.length;
  const bits = infoVersion(version);
  for (let i = 0; i < 18; i++) {
    const b = ((bits >> i) & 1) === 1;
    const f = Math.floor(i / 3);
    const c = i % 3;
    m[f][n - 11 + c] = b;
    m[n - 11 + c][f] = b;
  }
}

/* --- puntuación de máscaras: gana la que menos molesta al lector --- */

function penalidad(m) {
  const n = m.length;
  let total = 0;

  // Regla 1 — corridas de cinco o más del mismo color.
  const corridas = (leer) => {
    for (let a = 0; a < n; a++) {
      let largo = 1;
      for (let b = 1; b < n; b++) {
        if (leer(a, b) === leer(a, b - 1)) largo++;
        else { if (largo >= 5) total += 3 + (largo - 5); largo = 1; }
      }
      if (largo >= 5) total += 3 + (largo - 5);
    }
  };
  corridas((f, c) => m[f][c]);
  corridas((c, f) => m[f][c]);

  // Regla 2 — bloques de 2×2 del mismo color.
  for (let f = 0; f < n - 1; f++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[f][c];
      if (v === m[f][c + 1] && v === m[f + 1][c] && v === m[f + 1][c + 1]) total += 3;
    }
  }

  // Regla 3 — el patrón que se confunde con un finder.
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [false, false, false, false, true, false, true, true, true, false, true];
  const coincide = (leer, a, b, patron) => patron.every((v, i) => leer(a, b + i) === v);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b + 11 <= n; b++) {
      if (coincide((x, y) => m[x][y], a, b, P1) || coincide((x, y) => m[x][y], a, b, P2)) total += 40;
      if (coincide((x, y) => m[y][x], a, b, P1) || coincide((x, y) => m[y][x], a, b, P2)) total += 40;
    }
  }

  // Regla 4 — desbalance entre módulos claros y oscuros.
  let oscuros = 0;
  for (const fila of m) for (const v of fila) if (v) oscuros++;
  const pct = (oscuros * 100) / (n * n);
  total += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return total;
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

/**
 * La matriz de módulos del QR. `true` es oscuro.
 * @returns {boolean[][]}
 */
export function matriz(texto) {
  const bytes = [...new TextEncoder().encode(String(texto))];
  const version = versionPara(bytes);

  const codewords = intercalar(codificar(bytes, version), version);

  const fijo = esqueleto(version);
  const reserva = reservados(version);

  const base = fijo.map((fila) => [...fila]);
  ubicarDatos(base, reserva, codewords);

  // Se prueban las ocho máscaras y se queda la de menor penalidad, que es
  // literalmente lo que dice la norma. Sin esto el QR igual es válido, pero
  // hay lectores baratos que no lo enganchan.
  let mejor = null;
  let mejorPuntaje = Infinity;

  for (let mascara = 0; mascara < 8; mascara++) {
    const cand = aplicarMascara(base, reserva, fijo, mascara);
    escribirFormato(cand, mascara);
    escribirVersion(cand, version);
    const p = penalidad(cand);
    if (p < mejorPuntaje) { mejorPuntaje = p; mejor = cand; }
  }

  return mejor.map((fila) => fila.map(Boolean));
}

/**
 * El QR como SVG, listo para meter en el DOM o para imprimir.
 * El margen de 4 módulos es obligatorio: sin zona quieta muchos lectores no
 * encuentran el código.
 */
export function svg(texto, { margen = 4, oscuro = '#0e0e10', claro = '#ffffff' } = {}) {
  const m = matriz(texto);
  const n = m.length;
  const lado = n + margen * 2;

  // Un solo <path> con todos los módulos: mil rectángulos sueltos hacen que
  // imprimir desde el celular tarde una eternidad.
  let d = '';
  for (let f = 0; f < n; f++) {
    for (let c = 0; c < n; c++) {
      if (m[f][c]) d += `M${c + margen} ${f + margen}h1v1h-1z`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" `
    + `shape-rendering="crispEdges" role="img" aria-label="Código QR del catálogo">`
    + `<rect width="${lado}" height="${lado}" fill="${claro}"/>`
    + `<path d="${d}" fill="${oscuro}"/></svg>`;
}

export const _paraTests = { formato, infoVersion, versionPara, codificar };
