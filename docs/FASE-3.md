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

## Addendum — histórico y comprobantes

Los tres pendientes salieron juntos porque son la misma cosa vista desde dos
lados: qué se pagó, a quién y cuándo.

**Qué hay.** El admin tiene, debajo de "Liquidar semana", el botón
*Liquidaciones pagadas · comprobantes*: el histórico agrupado por día de pago,
con el nombre y el total de cada una. Al confirmar una liquidación se abren
solos los comprobantes de hoy, que es cuando se entregan. La trabajadora ve en
su pantalla el bloque *Lo que cobraste* con sus últimas cuatro liquidaciones
(el resto en "Ver todo"). Cada fila tiene dos botones: **Comprobante**, que abre
la ventana de impresión del navegador (de ahí sale "Guardar como PDF"), y
**WhatsApp**, un link `wa.me` con el comprobante en texto.

**Decisiones:**

- **Sin tablas ni columnas nuevas.** Una liquidación es (trabajadora,
  `fecha_pago`): `liquidarSemana()` ya le pone la misma fecha a todo el lote.
  Si a una persona se le pagan dos lotes el mismo día, salen en un solo
  comprobante — es la plata que recibió ese día. Hay test.
- **Sale de las jornadas, no de la caja.** El egreso de `movimiento_caja` es uno
  por todo el equipo y no dice cuánto fue de cada una, y la trabajadora no ve
  la caja. Un test verifica que la suma del histórico cuadra con los egresos.
- **El monto es `tarifa_aplicada` (regla 4).** Subirle la tarifa a alguien no
  mueve lo que ya cobró; el comprobante lista cada jornada con su tarifa
  congelada. Hay test.
- **Privacidad (regla 8).** `liquidacionesPagadas()` pasa por
  `auth.filtrarPropio()` antes que nada, y `comprobanteLiquidacion()` vuelve a
  validar el id: desde la consola, una trabajadora no saca el de otra.
- **WhatsApp.** El admin lo manda al teléfono de la ficha si es un celular
  argentino reconocible (10 dígitos → `549…`); si no, el link abre para elegir
  contacto en vez de adivinar. La trabajadora no lleva número: lo reenvía a
  quien quiera.
- **Qué dice el papel.** "Comprobante de pago de jornadas", con línea de
  "Recibí conforme". No dice recibo de sueldo, trabajo registrado ni nada que
  sugiera relación de dependencia: el vínculo todavía no está formalizado. El
  pie es de la Federación de Organizaciones Sociales «Mesa Solidaria Tandil».
- **La ventana de impresión es una copia de la de `caja.js`**, no un import: la
  de caja no se exporta. Si aparece un tercer papel, conviene mudar las dos a
  `ui.js`. Se abre sincrónica con el toque, antes de leer la base: Safari en el
  celular bloquea un `window.open` que llega después de un `await`.

**Tests nuevos:** 25 casos en `fase-3.test.mjs` (histórico, regla 4, texto del
comprobante, link de WhatsApp, vista de trabajadora, dos pagos el mismo día) y,
en `privacidad.test.mjs`, el render real de *Lo que cobraste* con jsdom: que no
aparezca lo cobrado por otra, que todos los botones de comprobante apunten a
ella, que el texto de WhatsApp no traiga datos ajenos ni número, y que el
comprobante impreso lleve su nombre y el pie de la Federación.
