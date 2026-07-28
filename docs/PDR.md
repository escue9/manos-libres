# PDR — Sistema Operativo de Gestión
## Unidad de Negocio: Cocina del CIC (Manos Libres)

**Versión** 1.0 · **Fecha** 28/07/2026 · **Responsable** Juan Martín Aróztegui
**Organización** Mirmidones Asociación Civil · **Sede** CIC Barrio Movediza, Tandil

---

## 1. Resumen ejecutivo

Manos Libres opera una cocina comunitaria en el CIC Barrio Movediza que emplea a mujeres en situación de vulnerabilidad para producir y vender alimentos (empanadas, tartas, bondiola desmechada, pizzas). Hoy la gestión es manual: cuadernos, planillas sueltas y mensajes de WhatsApp.

Este documento define **el sistema operativo de la unidad de negocio**: una PWA que centraliza producción, stock, ventas, jornales y rentabilidad, con datos confiables para tomar decisiones y para rendir cuentas ante financiadores.

### Problemas que resuelve

| Problema actual | Consecuencia | Cómo lo resuelve el sistema |
|---|---|---|
| No se sabe el costo real por producto | Se vende a pérdida sin darse cuenta | Costeo por receta desde insumos reales |
| Stock sin control | Faltantes en plena producción, mercadería vencida | Stock de insumos y producto terminado con alertas |
| Pedidos en WhatsApp sin registro | Pedidos perdidos, entregas olvidadas | Módulo de pedidos con estados y agenda de entrega |
| Jornales anotados a mano | Errores de liquidación, conflictos | Registro de jornadas con liquidación automática |
| Rentabilidad desconocida | No se sabe si el proyecto se sostiene | Cierre semanal automático con ganancia neta |
| Rendición de cuentas manual | Horas perdidas antes de cada informe | Exportación de reportes en un click |

### Objetivos medibles (primeros 90 días)

- 100% de los pedidos cargados en el sistema (hoy: 0%)
- Costo real conocido de cada producto del catálogo
- Liquidación semanal de jornales en menos de 5 minutos
- Reporte de rentabilidad semanal disponible sin trabajo manual
- Cero faltantes de insumo por sorpresa en jornada de producción

---

## 2. Alcance

### Dentro de la V1

1. **Producción y stock** — insumos, recetas, costeo, órdenes de producción, stock doble (insumo + terminado)
2. **Pedidos y ventas** — clientes, pedidos multicanal, estados, cobros
3. **Trabajadoras y jornales** — registro de jornadas, tarifas, liquidación semanal
4. **Caja y rentabilidad** — movimientos, cierre semanal, margen por producto, reportes

### Fuera de la V1 (backlog)

- Facturación electrónica / AFIP
- Catálogo público y pedidos online del cliente final
- Integración directa con WhatsApp Business API
- Gestión de otras unidades de negocio (carpintería, herrería)
- Contabilidad formal / balance para presentación legal

> **Nota de arquitectura:** el modelo de datos incluye el campo `unidad_negocio` desde el día uno. La V1 opera solo la cocina del CIC, pero el sistema queda preparado para carpintería y herrería sin rehacer el esquema.

### Usuarios y roles

| Rol | Quién | Qué puede hacer | Qué NO puede hacer |
|---|---|---|---|
| **Admin** | Juan Martín | Todo: configuración, precios, costos, liquidaciones, reportes, exportar | — |
| **Trabajadora** | Equipo de cocina | Cargar producción, registrar ventas del día, marcar su jornada, ver stock | Ver costos, márgenes, ganancias, tarifas ajenas; editar precios; borrar registros |
| **Dirigente** *(fase 2)* | Comisión Mirmidones | Ver reportes y rentabilidad en modo lectura | Cargar o editar datos operativos |

**Principio de privacidad:** una trabajadora nunca ve la tarifa, los días ni la liquidación de otra. Solo ve lo propio.

---

## 3. Modelo de datos

Diseñado en formato relacional para que la migración de IndexedDB a Supabase/PostgreSQL sea directa: mismas tablas, mismos campos, mismas relaciones.

### 3.1 Diagrama de relaciones

```
unidad_negocio
     │
     ├── insumo ──────────< receta_item >────── producto
     │      │                                      │
     │      ├──< compra_insumo                     ├──< movimiento_stock_producto
     │      └──< movimiento_stock_insumo           │
     │                                    orden_produccion ──< produccion_item ──> producto
     │
     ├── cliente ──< pedido ──< pedido_item ─────> producto
     │                  │
     │                  └──< cobro
     │
     ├── trabajadora ──< jornada ──> orden_produccion (opcional)
     │        │
     │        └──< tarifa_historica
     │
     └── movimiento_caja ──> [cobro | compra_insumo | jornada | gasto manual]
```

### 3.2 Entidades

#### `unidad_negocio`
La unidad operativa. V1 = solo "Cocina CIC".

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `nombre` | text | "Cocina CIC" |
| `tipo` | enum | `alimentos` \| `carpinteria` \| `herreria` |
| `activa` | bool | |
| `created_at` | timestamp | |

---

#### `insumo`
Materia prima comprada. Es la base de todo el costeo.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `unidad_negocio_id` | uuid FK | |
| `nombre` | text | "Harina 000", "Carne picada" |
| `categoria` | text | Almacén, Carnicería, Verdulería, Lácteos, Packaging |
| `unidad_medida` | enum | `kg` \| `g` \| `l` \| `ml` \| `unidad` |
| `costo_unitario` | decimal | Costo por unidad_medida. **Se actualiza con cada compra** |
| `stock_actual` | decimal | En unidad_medida |
| `stock_minimo` | decimal | Umbral de alerta |
| `proveedor_habitual` | text | nullable |
| `activo` | bool | |
| `updated_at` | timestamp | Para saber qué tan viejo es el costo |

> **Regla de costeo:** `costo_unitario` se recalcula por **promedio ponderado** con cada compra registrada. Fórmula en §5.1.

---

#### `producto`
Lo que se vende. Puede tener receta (se produce) o no (reventa).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `unidad_negocio_id` | uuid FK | |
| `nombre` | text | "Empanada de carne", "Combo bondiola 6 porciones" |
| `categoria` | text | Empanadas, Tartas, Combos, Pizzas |
| `unidad_venta` | enum | `unidad` \| `docena` \| `kg` \| `combo` |
| `precio_venta` | decimal | |
| `costo_calculado` | decimal | **Derivado de la receta.** Solo lectura, se recalcula |
| `costo_manual` | decimal | nullable. Para productos sin receta cargada |
| `stock_actual` | int | Producto terminado disponible |
| `stock_minimo` | int | |
| `rinde_por_lote` | int | Cuántas unidades produce una vuelta de receta |
| `activo` | bool | |

> **Costo efectivo** = `costo_calculado` si hay receta; si no, `costo_manual`.

---

#### `receta_item`
Cuánto insumo lleva un producto. El corazón del costeo.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `producto_id` | uuid FK | |
| `insumo_id` | uuid FK | |
| `cantidad` | decimal | Por **lote**, no por unidad |
| `unidad_medida` | enum | Debe ser convertible a la del insumo |
| `merma_pct` | decimal | Desperdicio esperado. Default 0 |

---

#### `orden_produccion`
Una jornada de cocina. Descuenta insumos, suma producto terminado.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `unidad_negocio_id` | uuid FK | |
| `fecha` | date | |
| `estado` | enum | `planificada` \| `en_curso` \| `cerrada` \| `cancelada` |
| `costo_insumos` | decimal | Snapshot al cerrar |
| `costo_mano_obra` | decimal | Suma de jornadas vinculadas |
| `notas` | text | |
| `cerrada_at` | timestamp | |

#### `produccion_item`
| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `orden_produccion_id` | uuid FK | |
| `producto_id` | uuid FK | |
| `cantidad_planificada` | int | |
| `cantidad_real` | int | Lo que efectivamente salió |
| `costo_unitario_snapshot` | decimal | Costo congelado al momento de producir |

> **Por qué el snapshot:** si mañana sube la harina, el margen histórico de la producción de hoy no debe cambiar. Los reportes históricos quedan inmutables.

---

#### `cliente`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `nombre` | text | |
| `telefono` | text | Clave práctica de identificación |
| `direccion` | text | nullable |
| `tipo` | enum | `particular` \| `club` \| `institucion` \| `revendedor` |
| `notas` | text | Alergias, preferencias, referencia de zona |
| `created_at` | timestamp | |

**Campos derivados** (calculados, no almacenados): cantidad de pedidos, total gastado, ticket promedio, fecha último pedido, segmento (Nuevo / Frecuente ≥2 / Fiel ≥5).

---

#### `pedido`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `unidad_negocio_id` | uuid FK | |
| `cliente_id` | uuid FK | |
| `canal` | enum | `whatsapp` \| `instagram` \| `cic_presencial` \| `club_uncas` \| `otro` |
| `fecha_pedido` | date | |
| `fecha_entrega` | date | Para la agenda de entregas |
| `estado` | enum | `pendiente` \| `confirmado` \| `en_produccion` \| `listo` \| `entregado` \| `cancelado` |
| `total` | decimal | Suma de items menos descuento |
| `descuento` | decimal | |
| `monto_cobrado` | decimal | Suma de cobros. Derivado |
| `estado_pago` | enum | `impago` \| `sena` \| `pagado` — derivado de cobros vs total |
| `notas` | text | |
| `created_by` | uuid FK trabajadora/admin | Auditoría |

#### `pedido_item`
| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `pedido_id` | uuid FK | |
| `producto_id` | uuid FK | |
| `cantidad` | int | |
| `precio_unitario` | decimal | Snapshot del precio al momento del pedido |
| `costo_unitario` | decimal | Snapshot del costo. Permite margen real por pedido |

#### `cobro`
Un pedido puede tener varios cobros (seña + saldo).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `pedido_id` | uuid FK | |
| `fecha` | date | |
| `monto` | decimal | |
| `medio` | enum | `efectivo` \| `transferencia` \| `mercadopago` \| `otro` |

---

#### `trabajadora`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `unidad_negocio_id` | uuid FK | |
| `nombre` | text | |
| `telefono` | text | |
| `tarifa_dia` | decimal | Tarifa vigente |
| `fecha_ingreso` | date | Dato para informes sociales |
| `activa` | bool | |
| `pin_acceso` | text | Hash. Login simple sin email |

#### `tarifa_historica`
Para que una liquidación vieja no cambie si se actualiza la tarifa.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `trabajadora_id` | uuid FK | |
| `tarifa_dia` | decimal | |
| `vigente_desde` | date | |

#### `jornada`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `trabajadora_id` | uuid FK | |
| `fecha` | date | |
| `orden_produccion_id` | uuid FK | nullable. Vincula mano de obra a producción |
| `tarifa_aplicada` | decimal | Snapshot de `tarifa_historica` vigente a esa fecha |
| `origen_carga` | enum | `admin` \| `autoreporte` — quién la cargó |
| `confirmada` | bool | Las cargadas por la trabajadora entran en `false` |
| `estado_pago` | enum | `pendiente` \| `pagada` |
| `fecha_pago` | date | nullable |

> Solo las jornadas con `confirmada = true` entran en la liquidación y en el costo laboral del cierre semanal.

> **Restricción:** única por (`trabajadora_id`, `fecha`). Una jornada por día por persona.

---

#### `movimiento_caja`
Libro único de entradas y salidas. Todo lo financiero pasa por acá.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `unidad_negocio_id` | uuid FK | |
| `fecha` | date | |
| `tipo` | enum | `ingreso` \| `egreso` |
| `origen` | enum | `cobro` \| `compra_insumo` \| `jornal` \| `gasto_operativo` \| `aporte` \| `retiro` |
| `referencia_id` | uuid | ID del cobro / compra / jornada que lo originó |
| `monto` | decimal | Siempre positivo; el signo lo da `tipo` |
| `descripcion` | text | |
| `categoria_gasto` | text | Solo si `origen = gasto_operativo`. Gas, luz, flete, packaging, mantenimiento |
| `medio` | enum | `efectivo` \| `transferencia` \| `mercadopago` |

> **Regla de integridad:** los movimientos con `origen` distinto de `gasto_operativo`/`aporte`/`retiro` se generan **automáticamente**. No se cargan a mano. Esto evita el doble conteo, que es el error más común en este tipo de sistemas.

#### `compra_insumo`
| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `insumo_id` | uuid FK | |
| `fecha` | date | |
| `cantidad` | decimal | |
| `costo_total` | decimal | |
| `proveedor` | text | |

Al registrarse: actualiza `insumo.stock_actual`, recalcula `insumo.costo_unitario` y genera el `movimiento_caja` de egreso.

---

#### `movimiento_stock_insumo` / `movimiento_stock_producto`
Trazabilidad completa. Nunca se edita un stock a mano sin dejar rastro.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `insumo_id` / `producto_id` | uuid FK | |
| `fecha` | timestamp | |
| `tipo` | enum | `compra` \| `produccion` \| `venta` \| `ajuste` \| `merma` |
| `cantidad` | decimal | Positivo entra, negativo sale |
| `referencia_id` | uuid | Orden, pedido o ajuste manual |
| `motivo` | text | Obligatorio si tipo = `ajuste` o `merma` |

---

## 4. Módulos y flujos

### 4.1 Producción y Stock · *rosa `#e8185a`*

**Pantallas:** Insumos · Recetas · Órdenes de producción · Stock terminado

#### Flujo: registrar una compra
1. Admin abre Insumos → "Registrar compra"
2. Elige insumo (o crea uno nuevo), carga cantidad, costo total y proveedor
3. Sistema: suma stock → recalcula costo unitario ponderado → genera egreso en caja → recalcula el costo de todos los productos que usan ese insumo
4. Si algún producto quedó con margen bajo el 25%, se muestra alerta: *"Subió el costo de la carne. La empanada de carne bajó a 18% de margen."*

#### Flujo: jornada de producción
1. Admin crea orden de producción con fecha y productos planificados
2. Sistema muestra **insumos requeridos vs disponibles** y marca en rojo los faltantes antes de empezar
3. Se asignan trabajadoras a la orden → se crean sus jornadas automáticamente
4. Al cerrar: se carga la cantidad real producida
5. Sistema: descuenta insumos según receta (con merma) → suma producto terminado → congela costo unitario → suma costo de mano de obra a la orden

#### Reglas
- No se puede cerrar una orden con stock de insumo insuficiente sin confirmar un ajuste explícito
- La diferencia entre cantidad planificada y real queda registrada como indicador de eficiencia
- El stock nunca se edita libremente: se ajusta con motivo obligatorio

---

### 4.2 Pedidos y Ventas · *naranja `#f55b1e`*

**Pantallas:** Pedidos activos · Agenda de entregas · Clientes · Venta rápida

#### Flujo: pedido por WhatsApp
1. Se carga cliente (busca por teléfono; si no existe, lo crea en el mismo formulario)
2. Se agregan productos con cantidad. El sistema valida stock y avisa si hay que producir
3. Se define fecha de entrega y canal
4. Se guarda como `confirmado`. Si falta stock, pasa a `en_produccion` y aparece sugerido en la próxima orden de producción
5. Al entregar: se marca `entregado` → descuenta stock terminado → registra el cobro → genera ingreso en caja

#### Flujo: venta rápida (mostrador CIC / cancha de Uncas)
Pantalla simplificada para trabajadoras: grilla de productos con foto y precio, tap para sumar, total en vivo, cobrar. Sin datos de cliente obligatorios. Un tap por producto, dos taps para cerrar la venta.

#### Agenda de entregas
Vista de calendario semanal con los pedidos por día de entrega. Es la pantalla que se mira cada mañana.

---

### 4.3 Trabajadoras y Jornales · *verde `#1ec84a`*

**Pantallas:** Equipo · Registro semanal · Liquidación

#### Flujo: registro semanal
Grilla de trabajadoras × días de la semana. Tap para marcar jornada trabajada. Cada tap crea o borra una `jornada` con la tarifa vigente congelada.

#### Flujo: liquidación
1. Admin abre Liquidación de la semana
2. Ve por trabajadora: días trabajados × tarifa = total a pagar
3. Confirma el pago → jornadas pasan a `pagada` → se genera egreso en caja
4. Se puede exportar un comprobante simple por trabajadora

#### Vista de la trabajadora
Solo ve sus propios días marcados y su total pendiente de la semana. Puede marcar su propia jornada (queda pendiente de confirmación del admin). No ve nada del resto del equipo.

---

### 4.4 Caja y Rentabilidad · *azul `#3db8f5`*

**Pantallas:** Caja · Cierre semanal · Rentabilidad por producto · Reportes

#### Cierre semanal (la pantalla clave)

```
GANANCIA NETA DE LA SEMANA          $ XXX.XXX
────────────────────────────────────────────
  Ventas totales                    $ XXX.XXX
– Costo de mercadería vendida       $  XX.XXX
= Margen bruto                      $ XXX.XXX   (XX%)
– Costo laboral                     $  XX.XXX
– Gastos operativos                 $   X.XXX
= GANANCIA NETA                     $  XX.XXX   (XX%)
```

Con comparación contra la semana anterior y semáforo: verde si hay ganancia, amarillo si el margen neto está por debajo del 15%, rojo si hay pérdida.

#### Rentabilidad por producto
Tabla ordenable: producto · unidades vendidas · facturación · costo · margen $ · margen % · aporte al total.

Clasificación automática en cuatro cuadrantes:

| | Alto volumen | Bajo volumen |
|---|---|---|
| **Alto margen** | ⭐ Estrella — empujar | 💎 Oportunidad — promocionar |
| **Bajo margen** | ⚠️ Revisar precio o costo | ❌ Candidato a discontinuar |

#### Reportes exportables
- **Rendición de cuentas** (PDF): ingresos, egresos, saldo, detalle por rubro — formato apto para financiadores
- **Impacto social** (PDF): jornadas generadas, monto pagado en jornales, cantidad de trabajadoras activas — el dato que piden los concursos de financiamiento
- **Datos crudos** (CSV): pedidos, movimientos, jornadas

---

## 5. Reglas de negocio y fórmulas

### 5.1 Costo de insumo — promedio ponderado

```
costo_nuevo = (stock_previo × costo_previo + cantidad_comprada × costo_compra_unit)
              ÷ (stock_previo + cantidad_comprada)
```

Evita que una compra puntual cara o barata distorsione todo el costeo.

### 5.2 Costo de producto

```
costo_lote = Σ ( receta_item.cantidad × insumo.costo_unitario × (1 + merma_pct) )
costo_unitario = costo_lote ÷ producto.rinde_por_lote
```

> **Decisión:** la mano de obra **no** se prorratea dentro del costo unitario del producto. Se imputa como costo laboral en el cierre semanal. Razón: la tarifa es por día trabajado, no por unidad producida — prorratearla daría un costo unitario que varía sin relación con el producto. El margen bruto queda limpio y comparable entre productos.

### 5.3 Márgenes

```
margen_bruto_$     = precio_venta – costo_unitario
margen_bruto_%     = margen_bruto_$ ÷ precio_venta × 100
```

**Cierre semanal** — todo se calcula sobre pedidos con estado `entregado` en el rango de fechas:

```
ventas             = Σ pedido_item.cantidad × precio_unitario – descuentos
costo_mercaderia   = Σ pedido_item.cantidad × costo_unitario   (snapshots)
costo_laboral      = Σ jornada.tarifa_aplicada  donde confirmada = true
gastos_operativos  = Σ movimiento_caja  donde origen = gasto_operativo
ganancia_neta      = ventas – costo_mercaderia – costo_laboral – gastos_operativos
```

> **Ventas ≠ caja.** El cierre de rentabilidad se calcula por **devengado** (lo entregado en la semana), mientras que la caja registra el **percibido** (lo efectivamente cobrado). Un pedido entregado e impago suma a la ganancia pero no a la caja. Las dos vistas se muestran por separado y nunca se mezclan: confundirlas es el error clásico que hace parecer rentable un negocio que no cobra.

### 5.4 Alertas del sistema

| Condición | Alerta |
|---|---|
| `insumo.stock_actual ≤ stock_minimo` | Reponer insumo |
| `producto.stock_actual ≤ stock_minimo` | Producir |
| `margen_bruto_% < 25` | Revisar precio o costo |
| `pedido.fecha_entrega = hoy` y estado ≠ `listo` | Entrega en riesgo |
| `insumo.updated_at > 60 días` | Costo desactualizado |
| Ganancia neta semanal negativa | Semana en pérdida |
| Pedido `entregado` con `estado_pago ≠ pagado` a +7 días | Cobro pendiente |
| Jornada con `confirmada = false` a +3 días | Autoreporte sin confirmar |

---

## 6. Arquitectura técnica

### Stack

| Capa | V1 (local) | V2 (nube) |
|---|---|---|
| UI | HTML + CSS + JS vanilla | igual |
| Datos | IndexedDB (wrapper propio) | Supabase / PostgreSQL |
| Auth | PIN local por rol | Supabase Auth + RLS |
| Offline | Service Worker + cache | Sync con cola de conflictos |
| Deploy | PWA instalable | Vercel |

**Sin frameworks ni dependencias externas.** La cocina del CIC tiene conexión inestable: la app tiene que abrir y funcionar sin internet, siempre.

### Estructura de archivos

```
cocina-cic/
├── index.html
├── manifest.json
├── sw.js
├── css/
│   ├── base.css              variables, tipografías, reset
│   └── components.css        tablas, modales, cards, botones
├── js/
│   ├── db.js                 capa de datos — API igual a Supabase
│   ├── state.js              estado en memoria y eventos
│   ├── calc.js               costeo, márgenes, cierre semanal
│   ├── auth.js               roles y permisos
│   ├── ui.js                 render y helpers
│   └── modules/
│       ├── produccion.js
│       ├── pedidos.js
│       ├── trabajadoras.js
│       └── caja.js
└── assets/
    └── logo.png
```

### Clave de la migración

`db.js` expone una API idéntica a la de Supabase:

```js
db.from('pedido').select().eq('estado','pendiente')
db.from('pedido').insert({...})
```

Migrar a la nube = cambiar la implementación interna de `db.js`. Ni una línea de los módulos cambia. Esta es la decisión técnica más importante del proyecto y es lo que hace viable el "local primero, DB después".

### Estrategia de sincronización (V2)

Cada registro lleva `updated_at` y `sync_status` (`local` / `synced` / `conflict`). La sincronización sube los cambios locales pendientes y baja los remotos. Ante conflicto: gana el más reciente, y el descartado queda registrado para revisión manual. En un equipo de 3-5 personas con roles separados, los conflictos reales son raros.

### Identidad visual

Hereda la identidad de Manos Libres:

- **Fondo:** `#0e0e10` / superficies `#16161a`
- **Colores por módulo:** producción `#e8185a` · pedidos `#f55b1e` · clientes `#f5b800` · trabajadoras `#1ec84a` · caja `#3db8f5`
- **Tipografías:** Fredoka One (títulos) · Nunito 700/800 (cuerpo) · JetBrains Mono (números)
- **Radios:** 10–14px · bordes sutiles · dark mode nativo

**Mobile-first, sin excusas.** Las trabajadoras cargan desde el celular, muchas veces con las manos ocupadas y apuradas. Botones grandes, mínimo de taps, cero scroll horizontal, funciona con una sola mano.

---

## 7. Roadmap

| Fase | Contenido | Entregable |
|---|---|---|
| **0 — Fundación** | Estructura PWA, `db.js`, auth por PIN, navegación, identidad visual | App instalable que abre y navega |
| **1 — Producción** | Insumos, compras, recetas, costeo, órdenes de producción, stock | Se conoce el costo real de cada producto |
| **2 — Ventas** | Clientes, pedidos, agenda de entregas, venta rápida, cobros | Todos los pedidos entran al sistema |
| **3 — Equipo** | Trabajadoras, jornadas, liquidación, vista limitada por rol | Liquidación semanal automática |
| **4 — Caja** | Movimientos, cierre semanal, rentabilidad por producto, exportables | Reporte de rentabilidad y rendición de cuentas |
| **5 — Nube** | Supabase, RLS por rol, sync, deploy en Vercel | Multi-dispositivo con datos respaldados |

Cada fase deja el sistema **usable**. No hay una fase que exija esperar a la siguiente para que sirva de algo.

### Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Las trabajadoras no adoptan la carga digital | Venta rápida con 2 taps; capacitación en la fase 2; convivencia con el cuaderno el primer mes |
| Datos históricos inexistentes al arrancar | Cargar el catálogo y costos actuales como punto cero; no intentar reconstruir el pasado |
| Pérdida de datos antes de la fase 5 | Exportación JSON completa semanal desde la fase 0 |
| Costos de insumos que cambian rápido (inflación) | Alerta de costo desactualizado a 60 días; recálculo automático de márgenes en cada compra |

---

## 8. Definición de terminado — V1

El sistema está listo cuando:

- [ ] Se registra una compra de insumo y el costo de los productos afectados se actualiza solo
- [ ] Se cierra una orden de producción: descuenta insumos, suma terminados, imputa mano de obra
- [ ] Se carga un pedido, se entrega y queda cobrado, con stock y caja actualizados
- [ ] Se marca la semana de jornadas y se liquida con un click
- [ ] El cierre semanal muestra la ganancia neta sin ningún cálculo manual
- [ ] Una trabajadora entra con su PIN y solo ve lo que le corresponde
- [ ] La app funciona sin internet y los datos persisten al cerrarla
- [ ] Se exporta el reporte de rendición de cuentas en PDF

---

*Documento vivo. Se actualiza al cerrar cada fase del roadmap.*
