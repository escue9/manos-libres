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
