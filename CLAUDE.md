# Sistema Operativo — Cocina CIC (Manos Libres)

PWA de gestión para la cocina comunitaria de Manos Libres en el CIC Barrio Movediza, Tandil.
Proyecto de Mirmidones Asociación Civil. Emplea a mujeres en situación de vulnerabilidad.

**El documento de referencia es `docs/PDR.md`. Leelo antes de escribir código.**
Contiene el modelo de datos completo, los flujos de cada módulo, las fórmulas de costeo y el roadmap por fases.

---

## Reglas no negociables

Estas decisiones ya están tomadas. No las cambies sin que Juan Martín lo pida explícitamente.

### 1. `js/db.js` expone una API idéntica a Supabase

```js
await db.from('pedido').select().eq('estado', 'pendiente')
await db.from('pedido').insert({ ... })
```

Hoy por debajo hay IndexedDB. En la fase 5 se cambia la implementación interna de `db.js` por el cliente de Supabase y **ningún módulo se toca**. Si escribís `indexedDB` directo en un módulo, rompiste la migración.

### 2. Vanilla puro

HTML + CSS + JS. Sin React, sin Vue, sin bundler, sin npm, sin librerías externas. Los módulos ES nativos (`import`/`export`) sí.

### 3. Offline primero

La cocina del CIC tiene conexión inestable. La app abre y funciona sin internet, siempre. Todo se escribe local primero.

### 4. Los snapshots de costo y precio son inmutables

`pedido_item` guarda `precio_unitario` y `costo_unitario` al momento del pedido. `produccion_item` guarda `costo_unitario_snapshot`. Si mañana sube la harina, el margen histórico **no cambia**. Nunca recalcules un histórico contra precios actuales.

### 5. Caja y rentabilidad son cosas distintas

- **Rentabilidad** = devengado. Se calcula sobre pedidos `entregado`.
- **Caja** = percibido. Se calcula sobre cobros efectivos.

Un pedido entregado e impago suma a la ganancia pero no a la caja. Nunca los mezcles en la misma cifra.

### 6. Los movimientos de caja automáticos no se cargan a mano

Cobros, compras de insumo y jornales generan su `movimiento_caja` automáticamente. Solo `gasto_operativo`, `aporte` y `retiro` se cargan manualmente. Cargar un ingreso a mano además del automático produce doble conteo.

### 7. El stock nunca se edita libre

Todo cambio de stock deja un `movimiento_stock_*`. Los ajustes manuales exigen motivo.

### 8. Privacidad entre trabajadoras

Una trabajadora ve solo sus propias jornadas y su propio total. Nunca la tarifa, los días ni la liquidación de otra. Tampoco ve costos, márgenes ni ganancias.

---

## Identidad visual

Hereda la marca de Manos Libres (ver `.claude/skills/manos-libres-design/SKILL.md`).

```css
--bg:        #0e0e10;   /* fondo */
--surface:   #16161a;   /* tarjetas, tablas */
--produccion:#e8185a;   /* rosa */
--pedidos:   #f55b1e;   /* naranja */
--clientes:  #f5b800;   /* amarillo */
--equipo:    #1ec84a;   /* verde */
--caja:      #3db8f5;   /* azul */
```

- **Tipografías:** Fredoka One (títulos) · Nunito 700/800 (cuerpo) · JetBrains Mono (números)
- **Radios:** 10–14px · bordes sutiles · dark mode nativo
- **Mobile-first sin excusas.** Las trabajadoras cargan desde el celular, apuradas y con las manos ocupadas. Botones grandes, mínimo de taps, cero scroll horizontal, usable con una mano.

---

## Estructura

```
├── CLAUDE.md              este archivo
├── docs/PDR.md            documento de diseño — la fuente de verdad
├── index.html             shell de la app
├── manifest.json          PWA
├── sw.js                  service worker
├── css/
│   ├── base.css           variables, tipografías, reset
│   └── components.css     tablas, modales, cards, botones
└── js/
    ├── db.js              capa de datos — API igual a Supabase
    ├── state.js           estado en memoria + eventos
    ├── calc.js            costeo, márgenes, cierre semanal
    ├── auth.js            roles y permisos
    ├── ui.js              render y helpers
    └── modules/
        ├── produccion.js  insumos, recetas, órdenes, stock
        ├── pedidos.js     clientes, pedidos, entregas, cobros
        ├── trabajadoras.js jornadas y liquidación
        └── caja.js        movimientos, cierre, rentabilidad
```

---

## Mockups

`docs/mockups/` tiene tres pantallas diseñadas en Claude Design: venta rápida, cierre semanal y registro de jornadas. Son **referencia visual**, no código a copiar. No se mantienen actualizados: la fuente de verdad es el código.

Al portar un mockup:

1. **El repo manda en lo que ya existe.** Si el mockup redefine `.btn`, `.card`, `.badge`, `.days`, `.nav`, `.toast` o `.modal`, se descarta la versión del mockup y se usa la de `components.css`. El mockup solo aporta lo visual nuevo.
2. **Renombrar las clases crípticas.** Design generó nombres abreviados (`.casc`, `.met`, `.pcd`, `.chd`, `.pn`, `.wkl`). Traducilas a nombres legibles antes de que entren al repo.
3. **Los estilos reutilizables van a `components.css`**, no al módulo.
4. **Los datos mockeados se tiran.** Todo sale de `db.js` vía `state.js`.

## Roadmap — dónde estamos

- [x] **Fase 0 — Fundación** · estructura PWA, `db.js`, auth por PIN, navegación, identidad visual
- [x] **Fase 1 — Producción** · insumos, compras, recetas, costeo, órdenes, stock
- [~] **Fase 2 — Ventas** · ✅ venta rápida · pendiente: clientes, pedidos, agenda
- [x] **Fase 3 — Equipo** · trabajadoras, jornadas, liquidación, vista por rol
- [ ] **Fase 4 — Caja** · movimientos, cierre semanal, rentabilidad, exportables
- [ ] **Fase 5 — Nube** · Supabase, RLS, sync, deploy en Vercel

Cada fase deja el sistema usable. No arranques una fase sin cerrar la anterior.

---

## Cómo trabajar acá

- Servir con `python -m http.server 8000` (el service worker necesita localhost, no `file://`)
- Probar siempre en vista mobile del navegador, no en desktop
- Antes de dar una fase por terminada, revisá el checklist de §8 del PDR
- Los datos de prueba se cargan desde `js/db.js` → `seed()`
- Correr `npm test` antes de cerrar cualquier fase — son las tres suites juntas.
  Si tocaste `db.js`, `auth.js` o `calc.js`, agregá el caso que cubra el cambio.
- Para empezar de cero: en la consola `await db.reset()` y recargar. Ojo que eso
  también borra el PIN de administración.

## Contexto de las organizaciones

`.claude/skills/` tiene el contexto institucional de Manos Libres, Mirmidones y la identidad de diseño. Consultalos cuando necesites entender el negocio, no solo el código.
