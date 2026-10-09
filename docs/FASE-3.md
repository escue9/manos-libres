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

- [ ] Comprobante de liquidación por trabajadora para imprimir o mandar
- [ ] Ver el histórico de liquidaciones pagadas
- [ ] Que la trabajadora vea cuánto cobró en semanas anteriores

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
