# Tests

Pruebas de la capa de datos, permisos y cálculos. No tocan el DOM.

## Correr

```bash
npm install      # fake-indexeddb, única dependencia y solo para testing
npm test         # las tres suites
```

O de a una: `node test/fase-0.test.mjs` · `venta-rapida.test.mjs` · `fase-1.test.mjs`

`fake-indexeddb` simula IndexedDB en Node para poder ejercitar `db.js` sin navegador.
La app en producción no usa npm ni tiene dependencias.

## Qué cubre

- `db.js` — seed idempotente, filtros, order, insert/update/delete, config, exportAll
- `auth.js` — hash del PIN con salt, login de admin y trabajadora, tabla de permisos,
  `filtrarPropio()` (la regla de privacidad entre trabajadoras)
- `calc.js` — conversión de unidades, costo ponderado, costeo por receta con merma,
  márgenes, tarifa vigente a una fecha, cierre semanal por devengado, saldo de caja,
  cuadrantes de rentabilidad
- `modules/pedidos.js` — la transacción de venta rápida completa
- `modules/produccion.js` — compra con promedio ponderado, cierre de orden de
  producción, ajustes de stock

Los casos que más importan son los que verifican que **no** pasen cosas: que una
trabajadora no vea la caja, que el cierre ignore los pedidos no entregados y las
jornadas sin confirmar, que el PIN nunca quede en texto plano, que una orden no
cierre sin insumo, y que el snapshot de costo de una producción vieja **no cambie**
cuando después sube un insumo.
