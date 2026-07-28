# Tests

Pruebas de la capa de datos, permisos y cálculos. No tocan el DOM.

## Correr

```bash
npm install fake-indexeddb   # única dependencia, solo para testing
node test/fase-0.test.mjs
```

`fake-indexeddb` simula IndexedDB en Node para poder ejercitar `db.js` sin navegador.
La app en producción no usa npm ni tiene dependencias.

## Qué cubre

- `db.js` — seed idempotente, filtros, order, insert/update/delete, config, exportAll
- `auth.js` — hash del PIN con salt, login de admin y trabajadora, tabla de permisos,
  `filtrarPropio()` (la regla de privacidad entre trabajadoras)
- `calc.js` — costo ponderado, costeo por receta con merma, márgenes, cierre semanal
  por devengado, saldo de caja, cuadrantes de rentabilidad

Los casos que más importan son los que verifican que **no** pasen cosas: que una
trabajadora no vea la caja, que el cierre ignore los pedidos no entregados y las
jornadas sin confirmar, y que el PIN nunca quede en texto plano.
