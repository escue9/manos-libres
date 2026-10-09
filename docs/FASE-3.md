# Fase 3 — Jornadas y liquidación ✅

194 pruebas en verde, incluida una que renderiza la vista de trabajadora con
jsdom y busca fugas de datos ajenos.

---

## Qué se construyó

### Registro semanal

Grilla de trabajadoras × 7 días. Un tap crea la jornada, otro la borra. Navegación
entre semanas con `‹ ›`.

Los días se ven distinto según su estado, sin necesidad de leer nada:

| Estado | Cómo se ve |
|---|---|
| Sin marcar | gris |
| Cargada por el admin | verde lleno |
| Autoreportada, sin confirmar | borde punteado verde |
| Ya liquidada | atenuada con ✓ |

### Liquidación

Detalle por trabajadora, total, y confirmación. Al confirmar: las jornadas pasan
a `pagada` con fecha, y se genera **un solo** egreso en caja automáticamente
(regla 6).

Las jornadas sin confirmar quedan afuera y siguen disponibles para la próxima.
El modal lo avisa antes de confirmar.

### Vista de trabajadora

Ve su tarjeta, sus días y su total. Puede marcar sus propios días, que entran
con `confirmada = false` y `origen_carga = 'autoreporte'` — no suman a su total
hasta que la administración los confirme.

### Alta y edición

Nombre, teléfono, tarifa, PIN de acceso y estado activa. Al crear se deja la
tarifa inicial en `tarifa_historica`; al editarla, una fila nueva desde hoy.

---

## Decisiones

### Quiénes trabajan en la orden — resuelto

La duda que quedó de la Fase 1. El corte quedó **por estado de la orden, no por
rol**:

- **Orden abierta** → se ven los nombres de las asignadas, en solo lectura. Es la
  coordinación del día, que además tienen delante de los ojos: están todas en la
  misma cocina.
- **Orden cerrada** → el bloque desaparece para quien no sea admin.

**El razonamiento:** la regla 8 protege la tarifa, los días acumulados y la
liquidación. No dice que no puedan saber con quién están cocinando. El riesgo real
es otro: recorrer las órdenes viejas, cada una con su fecha, permite reconstruir
la asistencia completa de las demás — y eso sí son "los días de otra". Cerrando el
historial se corta esa vía sin volver la herramienta absurda.

Asignar sigue siendo solo del admin: la trabajadora ve los nombres, no los toca.

### La tarifa se congela por fecha de jornada

`marcarJornada()` resuelve la tarifa con `calc.tarifaVigente()` según la fecha,
no desde `trabajadora.tarifa_dia`. Si Ana pasa de $5.000 a $8.000 un jueves, las
jornadas de lunes a miércoles siguen valiendo $5.000. Hay test que lo verifica.

### Las jornadas de una orden no se borran desde acá

Si una jornada tiene `orden_produccion_id`, tocar el día tira error y explica que
viene de una orden. Se desasigna desde la orden, que es donde el dato tiene
sentido. Evita que la orden quede diciendo que trabajaron tres personas mientras
las jornadas dicen dos.

### Una jornada pagada no se toca

Desmarcar algo ya liquidado descuadraría la caja contra las jornadas. Se rechaza
con un mensaje que lo dice.

---

## Tests

`node test/fase-3.test.mjs` · 50 casos
`node test/privacidad.test.mjs` · render real con jsdom

Los que más valen son los que verifican que **no** pase algo:

- Una trabajadora no puede marcar el día de otra, ni cargarse como admin, ni
  confirmarse a sí misma, ni liquidar, ni dar de alta a nadie
- `resumenSemana()` desde su rol no devuelve el id ni el nombre de ninguna otra
- Liquidar dos veces la misma semana falla y **no deja un segundo egreso**
- Las jornadas sin confirmar no se pagan y no entran al costo laboral del cierre

El de privacidad renderiza la vista con jsdom y revisa el HTML resultante: que no
aparezcan nombres, ids ni tarifas ajenas, que no estén los botones de liquidar ni
editar, y que los 7 botones de día apunten todos a ella.

---

## Pendiente

- [x] Comprobante de liquidación por trabajadora para imprimir o mandar
- [x] Ver el histórico de liquidaciones pagadas
- [x] Que la trabajadora vea cuánto cobró en semanas anteriores

---

## Addendum — se cobra por producción

Octubre de 2026. Arrancó Rocío y cobra por lo que produce: cada producto tiene
asignada una ganancia por unidad y quien lo produce la cobra. **La tarifa por día
deja de existir para todas.**

### Qué cambió

| Antes | Ahora |
|---|---|
| La jornada congelaba la tarifa del día | La jornada es asistencia: `tarifa_aplicada` = 0 |
| Liquidación = días × tarifa | Liquidación = unidades × pago por unidad |
| La mano de obra iba aparte, en el cierre semanal | Entra en el costo del producto (`calc.costoEfectivo`) |
| La ficha pedía tarifa por día | La ficha no tiene tarifa; la paga está en la receta del producto |

### Qué registros genera cada operación

```
fijarPagoProduccion(producto, monto)       producto.pago_produccion
                                           (solo admin; devuelve la alerta de margen)

cerrarOrden(orden, reales, { productoras })
  ├─ produccion_item.costo_unitario_snapshot  materiales + pago por unidad
  ├─ pago_produccion                          una fila por productora y línea,
  │                                           con el monto por unidad congelado
  └─ orden.costo_mano_obra                    la suma de esas filas

liquidarSemana(desde, hasta)
  ├─ pago_produccion → pagada + fecha_pago    lo confirmado de días que pasaron
  └─ movimiento_caja                          UN egreso, origen 'jornal'
```

### Decisiones tomadas

**La paga es costo.** Con un pago por unidad, la razón del PDR §5.2 para dejar la
mano de obra afuera —una tarifa por día no se reparte entre unidades— dejó de
existir. El margen de Recetas y el que se congela en cada venta ya es el real.
Por eso el costo laboral del cierre semanal no la suma: estaría dos veces.

Un efecto a tener en cuenta: en la rentabilidad, la paga se reconoce cuando se
**vende** lo producido; en la caja, cuando se **liquida**. Son cosas distintas a
propósito (regla 5).

**`null` no es cero.** Un producto sin pago definido no deja cerrar la orden: si
no, Rocío produciría y nadie se enteraría de que no cobra hasta el día de la
liquidación. Un 0 cierra, pero tiene que estar puesto a propósito.

**Cada línea tiene su productora.** Si dos personas hicieron empanadas, la línea
se reparte (24 y 24) y el reparto tiene que sumar lo que salió. Se paga lo que
salió, no lo planificado.

**Lo que carga ella, queda a confirmar.** Igual que el autoreporte de jornadas:
si cierra la administración entra confirmado; si cierra una trabajadora, espera
el tap de confirmación. Y una trabajadora solo puede cargarse a sí misma:
repartir con una compañera es escribir plata a nombre de otra.

**Va en una tabla aparte.** Las trabajadoras leen las órdenes. Si el pago viviera
en `produccion_item`, cada una vería cuánto cobró la otra (regla 8).
`pago_produccion` se protege como `jornada`: cada una ve lo suyo.

**Ven cuánto se paga cada producto.** Es lo que cobran y es igual para todas.
Siguen sin ver costos, márgenes ni lo que cobró otra.

**El histórico no se toca.** Las jornadas pagadas por día quedan como estaban.
Si quedó alguna confirmada sin pagar, la liquidación la paga con su tarifa
congelada.

### En la nube

`supabase/migrations/20261008_pago_produccion.sql`:

- `producto.pago_produccion`, legible para todo el equipo; solo la administración
  lo cambia (guarda en `producto_costo()`)
- la tabla `pago_produccion` con RLS espejo de `jornada`. Una trabajadora inserta
  solo lo suyo, sin confirmar
- el servidor pone el monto cuando carga alguien que no fija costos, y lo congela
- `costo_efectivo_producto()` y el snapshot de producción suman el pago
- `costo_mano_obra_orden()` suma lo producido. Como el sync sube la orden antes
  que sus pagos, cada pago que llega recalcula la mano de obra de su orden

**Se aplica antes de publicar la app nueva.** Si un celular sincroniza primero,
Postgres rechaza la columna y la tabla que todavía no existen.

### Pantallas

- **Recetas:** campo "se le paga a quien lo produce", con costo y margen en vivo
  (materiales + paga). La lista marca en rojo los productos sin paga
- **Cerrar orden:** quién hizo cada línea —por defecto la asignada a la orden si
  hay una sola— y "+ Repartir con otra". Si falta la paga, la administración la
  define ahí mismo
- **Equipo:** por persona, unidades y total, el detalle por producto, los días
  que vino y los botones para confirmar lo que cargó ella. La liquidación
  desglosa unidades × monto congelado
- **Lo mío** (la trabajadora): su total, lo que le falta cobrar, lo que espera
  confirmación y la tabla de cuánto se paga cada producto

### Tests

Se reescribió `test/fase-3.test.mjs`: la paga por día ya no existe. Hay pruebas
nuevas o reescritas en `test/carga-semana.test.mjs`, `test/regresiones.test.mjs`,
`test/fase-1.test.mjs` y `test/privacidad.test.mjs`, más `test/migracion-v5.test.mjs`
para la tabla nueva. Las que más valen:

- un reparto que no suma lo que salió no cierra, y no deja pagos colgados
- cerrar dos veces en paralelo no paga dos veces
- una trabajadora no se carga producción a nombre de otra, ni se confirma, ni se
  sube el pago
- subir el pago de un producto no cambia lo ya producido
- la venta congela materiales + pago
- María no ve lo que produjo ni cobró Ana (el render, con jsdom)

---

## Addendum — histórico de liquidaciones y comprobantes

Cierra los tres pendientes. Son la misma cosa vista desde dos lados: qué se
pagó, a quién y cuándo. Está hecho sobre el modelo de pago por producción.

**Qué hay.** El admin tiene, debajo de "Liquidar semana", el botón
*Liquidaciones pagadas · comprobantes*: el histórico agrupado por día de pago,
con el nombre y el total de cada una. Al confirmar una liquidación se abren
solos los comprobantes de hoy, que es cuando se entregan. La trabajadora ve en
**Lo mío** el bloque *Lo que cobraste* con sus últimas cuatro liquidaciones (el
resto en "Ver todo"), entre su total de la semana y la tabla de cuánto se paga
cada producto. Cada fila tiene dos botones: **Comprobante**, que abre la
ventana de impresión del navegador (de ahí sale "Guardar como PDF"), y
**WhatsApp**, un link `wa.me` con el comprobante en texto.

**Decisiones:**

- **Sin tablas ni columnas nuevas.** Una liquidación es (trabajadora,
  `fecha_pago`): `liquidarSemana()` ya le pone la misma fecha a todo el lote.
  Si a una persona se le pagan dos lotes el mismo día, salen en un solo
  comprobante — es la plata que recibió ese día. Hay test.
- **Dos fuentes, cada fila contada una vez.** Lo de ahora sale de
  `pago_produccion` pagado; lo de antes del cambio, de las `jornada` pagadas
  **con** tarifa, que son histórico real y siguen apareciendo. Las jornadas de
  ahora (tarifa cero) son asistencia y no se listan. Las dos tablas no se
  pisan, así que nada suma dos veces. Hay test con una liquidación vieja y una
  jornada de asistencia pagada en el mismo lote.
- **No sale de la caja.** El egreso de `movimiento_caja` es uno por todo el
  equipo y no dice cuánto fue de cada una, y la trabajadora no ve la caja. Un
  test verifica que lo pagado hoy en el histórico cuadra con los egresos.
- **Montos congelados (regla 4).** El comprobante desglosa
  `unidades × pago_unitario` por producto con el monto de cada fila; si el pago
  de un producto cambió entre dos órdenes del mismo lote, salen dos líneas.
  Subir el pago de la tarta no mueve lo ya cobrado. Hay test.
- **Privacidad (regla 8).** `liquidacionesPagadas()` pasa las dos tablas por
  `auth.filtrarPropio()` antes que nada, y `comprobanteLiquidacion()` vuelve a
  validar el id: desde la consola, una trabajadora no saca el de otra, ni el
  nuevo ni el viejo por día.
- **Qué dice el papel.** "Comprobante de pago por producción" con las unidades
  producidas, o "Comprobante de pago de jornadas" si es una liquidación de
  antes del cambio — llamarla de producción sería reescribirla. Línea de
  "Recibí conforme". No dice recibo de sueldo, trabajo registrado ni nada que
  sugiera relación de dependencia. El pie es de la Federación de
  Organizaciones Sociales «Mesa Solidaria Tandil».
- **WhatsApp.** El admin lo manda al teléfono de la ficha si es un celular
  argentino reconocible (10 dígitos → `549…`); si no, el link abre para elegir
  contacto en vez de adivinar. La trabajadora no lleva número: lo reenvía a
  quien quiera.
- **La ventana de impresión es una copia de la de `caja.js`**, no un import: la
  de caja no se exporta. Si aparece un tercer papel, conviene mudar las dos a
  `ui.js`. Se abre sincrónica con el toque, antes de leer la base: Safari en el
  celular bloquea un `window.open` que llega después de un `await`.

**Tests nuevos:** en `fase-3.test.mjs`, el histórico (regla 4, la liquidación
vieja por día, nada sumado dos veces), el texto y el HTML del comprobante, el
link de WhatsApp, lo que ve la trabajadora y dos pagos el mismo día. En
`privacidad.test.mjs`, el render real de *Lo que cobraste* con jsdom: que no
aparezca lo cobrado por otra, que los dos comprobantes —el de producción y el
viejo— apunten a ella, que el texto de WhatsApp no traiga datos ajenos ni
número, que el comprobante impreso lleve su nombre, diga "por producción" y el
pie de la Federación, y que desde la consola no saque el de otra.
