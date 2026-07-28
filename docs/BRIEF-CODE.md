# Brief para Claude Code — continuar el desarrollo

Handoff del proyecto. Lo que sigue está pensado para pegarse en Claude Code,
una sección por vez.

---

## 0. Antes de escribir una línea de código

### Sacar el proyecto de OneDrive

**Esto primero.** OneDrive sincroniza mientras git escribe en `.git/` y puede
corromper el repositorio en pleno commit. Es un problema conocido y molesto de
diagnosticar.

```bash
mkdir -p C:\dev
robocopy "C:\Users\Usuario\OneDrive\Escritorio\Manos Libres\S O Manos Libres" C:\dev\cocina-cic /E
cd C:\dev\cocina-cic
```

Si preferís dejarlo en OneDrive, al menos pausá la sincronización mientras
trabajás.

### Iniciar git

```bash
git init
git add .
git commit -m "Fase 0 + venta rápida

PWA de gestión para la cocina comunitaria de Manos Libres en el CIC.
Capa de datos con API compatible con Supabase, login por PIN con hash,
permisos por rol y venta rápida de mostrador. 62 tests pasando."
```

Commiteá al cerrar cada fase, no al final de todo.

### Verificar que arranca

```bash
python -m http.server 8000
node test/fase-0.test.mjs        # 42 pruebas
node test/venta-rapida.test.mjs  # 20 pruebas
```

Los tests necesitan `npm install fake-indexeddb` una sola vez. La app en
producción no tiene dependencias.

---

## 1. Estado actual

### Construido y probado

| Archivo | Qué hace |
|---|---|
| `js/db.js` | IndexedDB con **API idéntica a Supabase**. 18 tablas. `exportAll()`, `seed()`, `config` clave/valor |
| `js/auth.js` | PIN con SHA-256 + salt por instalación, sesión, tabla de permisos por rol, `filtrarPropio()` |
| `js/login.js` | Pantalla de PIN con teclado numérico propio, alta en primer arranque |
| `js/calc.js` | Costo ponderado, costeo por receta, márgenes, cierre semanal, cuadrantes |
| `js/state.js` | Caché en memoria + eventos |
| `js/ui.js` | Formato en pesos, semana desde lunes, modal, toast, estados vacíos |
| `js/app.js` | Gate de login, nav filtrado por rol, backup a JSON |
| `js/modules/pedidos.js` | **Venta rápida completa** — la transacción de referencia |
| `css/` | Sistema de diseño completo, dark mode, mobile-first |

### Stubs con checklist en comentarios

`js/modules/produccion.js` · `trabajadoras.js` · `caja.js`

### Mockups sin portar

`docs/mockups/cierre-semanal.html` y `registro-jornadas.html`.
Son referencia visual, no código a copiar. Ver las reglas de portado en `CLAUDE.md`.

### Deuda conocida

- [ ] **Prueba offline sin hacer** — instalar la PWA en el celular y abrirla en
      modo avión. Hay que hacerlo antes de que la app entre a la cocina.
- [ ] **No se puede anular una venta** — hoy hay que borrarla desde la consola.
      Es lo primero que van a pedir apenas alguien tape de más.

---

## 2. Leer antes de programar

Por orden de importancia:

1. **`CLAUDE.md`** — las 8 reglas no negociables. Si rompés una, rompés el proyecto
2. **`docs/PDR.md`** — modelo de datos completo, flujos y fórmulas
3. **`js/modules/pedidos.js`** — la función `registrarVenta()` es el patrón a
   imitar para toda transacción: encadena pedido → items → cobro → caja → stock,
   congelando snapshots

Los tres errores que más fácil se cometen acá:

- **Usar `indexedDB` directo en un módulo.** Todo pasa por `db.js` o la migración
  a Supabase se rompe
- **Recalcular un histórico contra precios actuales.** Los snapshots de
  `pedido_item` y `produccion_item` son inmutables
- **Sumar caja y rentabilidad en la misma cifra.** Rentabilidad es devengado
  (pedidos entregados), caja es percibido (cobros). Un pedido entregado e impago
  suma a la ganancia pero no a la caja

---

## 3. Fase 1 — Producción y costeo

```
Leé CLAUDE.md, docs/PDR.md §4.1 y js/modules/pedidos.js (para ver el patrón de
transacción). Vamos a construir la Fase 1 en js/modules/produccion.js.

Cuatro pantallas dentro del módulo, con subnavegación:

1. INSUMOS
   - Listado agrupado por categoría, con nivel de stock y alerta de mínimo
   - Alta y edición de insumo
   - "Registrar compra": cantidad + costo total + proveedor.
     Al guardar, en este orden:
       a) suma stock del insumo
       b) recalcula insumo.costo_unitario con calc.costoPonderado()
       c) genera el movimiento_caja de egreso (automático, regla 6)
       d) deja movimiento_stock_insumo
       e) recalcula costo_calculado de todos los productos que usan ese insumo
       f) si alguno quedó bajo calc.MARGEN_MINIMO, avisa con el nombre:
          "Subió la carne. La empanada de carne bajó a 18% de margen."

2. RECETAS
   - Por producto: qué insumos lleva por lote, en qué cantidad, con qué merma
   - Muestra en vivo el costo por unidad y el margen resultante
   - IMPORTANTE: falta implementar la conversión de unidades (g↔kg, ml↔l).
     Está marcado como TODO en calc.costoProducto(). Resolvelo acá.

3. ÓRDENES DE PRODUCCIÓN
   - Nueva orden: fecha + productos planificados
   - Antes de empezar, tabla de insumos requeridos vs disponibles, faltantes en rojo
   - Asignar trabajadoras a la orden → crea sus jornadas automáticamente
   - Cerrar orden: se carga la cantidad REAL producida y entonces
       a) descuenta insumos según receta con merma
       b) suma producto terminado
       c) congela costo_unitario_snapshot en cada produccion_item
       d) suma el costo de las jornadas vinculadas a la orden
   - No se puede cerrar con insumo insuficiente sin un ajuste explícito con motivo

4. STOCK TERMINADO
   - Qué hay de cada producto, con badge de estado (ui.badgeStock ya existe)
   - Ajuste manual con motivo obligatorio

Reglas: ocultar costos si !auth.puede('verCostos'). Todo cambio de stock deja
movimiento_stock_*. Mobile-first, probá a 390px.

Agregá test/fase-1.test.mjs siguiendo el estilo de los existentes. Los casos que
más importan: que el costo ponderado se aplique bien al comprar, que cerrar una
orden descuente los insumos correctos, y que el snapshot no cambie después.
```

---

## 4. Fase 3 — Jornadas y liquidación

```
Leé docs/PDR.md §4.3 y el mockup docs/mockups/registro-jornadas.html.
Portalo a js/modules/trabajadoras.js siguiendo las reglas de portado de CLAUDE.md:
descartá del mockup las clases que ya existen en components.css y renombrá las
crípticas (.chd, .pn, .wkl, .tot, .sum).

El mockup trae dos vistas. Ambas van implementadas de verdad, no con un switch:
la que se muestra depende de auth.rol.

VISTA ADMIN
- Grilla trabajadoras × 7 días. Tap crea o borra la jornada
- La tarifa se congela desde tarifa_historica según la fecha, NO desde
  trabajadora.tarifa_dia. Si la tarifa cambió en marzo, una jornada de febrero
  se liquida con la vieja
- Total por trabajadora y total de la semana
- "Liquidar semana": jornadas a estado pagada + egreso en caja automático
- Las jornadas con confirmada=false se muestran con borde punteado y NO cuentan
  para el total hasta que el admin las confirme

VISTA TRABAJADORA
- Solo sus días y su total. Puede marcar los propios, entran con
  confirmada=false y origen_carga='autoreporte'
- CERO rastro de que existen otras personas en el equipo. Ni nombres, ni cantidad
  de gente, ni total del equipo. Usá auth.filtrarPropio() siempre

Restricción: una jornada por trabajadora por fecha. Validalo.

También hace falta una pantalla de alta de trabajadora que permita asignarle PIN
(auth.cambiarPinTrabajadora ya existe).

Agregá test/fase-3.test.mjs. El caso más importante es el de privacidad: que
filtrarPropio() no deje pasar datos de otras trabajadoras, y que las jornadas sin
confirmar no entren en la liquidación.
```

---

## 5. Fase 4 — Caja y rentabilidad

```
Leé docs/PDR.md §4.4 y el mockup docs/mockups/cierre-semanal.html.
Portalo a js/modules/caja.js. El mockup ya trae navegación entre semanas con
datos históricos: mantené esa idea.

calc.cierreSemanal() y calc.cuadrantes() ya están implementados y testeados.
Este módulo es sobre todo presentación: no reimplementes los cálculos.

1. CIERRE SEMANAL
   - Hero con la ganancia neta y semáforo (calc devuelve el campo 'semaforo')
   - Desglose en cascada: ventas → −costo mercadería → margen bruto →
     −costo laboral → −gastos → ganancia neta
   - Comparación contra la semana anterior
   - Cuatro stat cards

2. RENTABILIDAD POR PRODUCTO
   - Tabla con cuadrantes (estrella / oportunidad / revisar / discontinuar)
   - En mobile se apila como tarjetas: usá .table--stack, ya existe

3. LIBRO DE CAJA
   - Movimientos con filtro por origen y medio
   - Carga manual SOLO de gasto_operativo, aporte y retiro.
     Los cobros, compras y jornales ya se generan solos: si dejás cargarlos a
     mano se produce doble conteo
   - Saldo con calc.saldoCaja()
   - Mostrar caja (percibido) y rentabilidad (devengado) claramente separadas

4. EXPORTABLES
   - Rendición de cuentas en PDF: ingresos, egresos, saldo, detalle por rubro
   - Impacto social en PDF: jornadas generadas, monto pagado en jornales,
     cantidad de trabajadoras activas. Este es el que piden los concursos de
     financiamiento
   - CSV crudo de pedidos, movimientos y jornadas

   Para el PDF, sin librerías externas: armá una vista imprimible con @media print
   y window.print(). Es suficiente y no rompe la regla de vanilla puro.

Este módulo es solo para admin y dirigente.
```

---

## 6. Fase 5 — Supabase

```
Leé docs/PDR.md §6. Vamos a migrar a Supabase sin tocar los módulos.

1. ESQUEMA
   Traducí las 18 tablas de db.js a SQL. Cada tabla con id uuid primary key
   default gen_random_uuid(), created_at y updated_at timestamptz.
   Respetá los tipos del PDR §3: los enum como check constraints o tipos enum.

2. RLS — tiene que espejar exactamente PERMISOS de js/auth.js
   - admin: acceso total
   - trabajadora: lee productos y stock; escribe pedidos, jornadas y producción;
     NO lee costos, márgenes ni jornadas ajenas
   - La política de jornada es la delicada: una trabajadora solo ve las filas
     donde trabajadora_id = auth.uid()
   - Los costos viven en insumo, receta_item, producto.costo_* y
     pedido_item.costo_unitario. Esas columnas no pueden ser legibles por
     trabajadoras: resolvelo con vistas o con column-level security

3. db.js
   Reemplazá la implementación interna por el cliente de Supabase.
   La API pública (from().select().eq()...) NO cambia. Ningún módulo se toca.
   Si tenés que modificar un módulo, algo salió mal.

4. SYNC OFFLINE
   Cada registro ya tiene sync_status ('local' | 'synced' | 'conflict').
   Escribir siempre local primero, encolar, subir cuando hay red.
   Ante conflicto gana el updated_at más reciente y el descartado queda
   registrado para revisión manual.
   NO rompas el offline: la cocina del CIC tiene la conexión que tiene.

5. DEPLOY
   Vercel, sitio estático. Variables de entorno para la URL y la anon key.

Antes de migrar: exportá los datos con db.exportAll() y guardá el JSON.
```

---

## 7. Cómo trabajar

- **Una fase por vez.** Cada una deja el sistema usable
- **Commit al cerrar cada fase**, con los tests en verde
- **Correr los tests antes de dar algo por terminado.** Si tocaste `db.js`,
  `auth.js` o `calc.js`, agregá el caso que cubra el cambio
- **Probar siempre en vista mobile de 390px**, no en desktop
- Para empezar de cero: en la consola `await db.reset()` y recargar. Ojo que eso
  borra también el PIN de administración

## Lo que no hay que perder de vista

Las que van a usar esto son mujeres cargando desde el celular, apuradas, con las
manos ocupadas. Si una pantalla tiene fricción, no la usan y vuelven al cuaderno
— y ahí se pierde todo el sistema, no esa pantalla.

Ante la duda entre una función más y menos taps: menos taps.
