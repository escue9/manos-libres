# Fase 2 — Clientes, pedidos y agenda ✅

362 pruebas en verde. La venta rápida ya estaba (`docs/VENTA-RAPIDA.md`); esto
cierra lo que faltaba: los encargues, la agenda de entregas y los clientes.

---

## Qué se construyó

El tab **Pedidos** pasó a tener tres pantallas con subnavegación, y **Clientes**
es su propio tab.

### Pedidos

Lista de encargues con filtro (Abiertos · Entregados · Todos) y las alertas del
PDR §5.4 arriba de todo: entregas vencidas, entregas de hoy que no están listas,
y entregados hace más de una semana sin cobrar.

Cada fila lleva **dos** badges, porque un pedido tiene dos estados a la vez: el
del pedido y el del pago. Un pedido entregado e impago es un estado normal y hay
que verlo de un vistazo.

### Alta de pedido

Un solo formulario en el orden de la conversación real: quién, para cuándo, qué
lleva. El cliente se busca por nombre o por teléfono y, si no existe, se crea sin
salir del pedido.

### Agenda de entregas

Semana con `‹ ›`, agrupada por día, con el día de hoy marcado en naranja. Los días
sin entregas no ocupan lugar. Es la pantalla de cada mañana.

### Clientes

Listado con buscador y los campos derivados del PDR: cuántos pedidos, cuánto
gastó, ticket promedio, último pedido, segmento y cuánto debe. La ficha muestra
el historial y tiene "Nuevo pedido" directo.

---

## Decisiones

### Entregar y cobrar son dos botones distintos

Es la regla 5 hecha interfaz. **Entregar** mueve la rentabilidad —el cierre
semanal se calcula sobre pedidos `entregado`— y **cobrar** mueve la caja. El club
se lleva las empanadas el sábado y paga el lunes: entre esos dos días la ganancia
ya está y la plata no.

Juntarlos en un solo botón hubiera sido más cómodo y habría hecho exactamente lo
que la regla 5 prohíbe.

Por comodidad, entregar un pedido impago abre la hoja de cobro a continuación. Se
puede cerrar sin cobrar y el pedido queda entregado e impago, que es lo correcto.

### El stock se descuenta al entregar, no al cargar el pedido

Cargar un pedido no toca nada: ni stock ni caja. Recién al entregar sale el
producto terminado con su `movimiento_stock_producto`.

La venta rápida hace las dos cosas en el mismo tap porque entrega en el acto.

### Si falta producto, el pedido nace `en_produccion`

PDR §4.2, paso 4. Y se cierra el circuito: `demandaPendiente()` suma lo
comprometido en pedidos abiertos, le resta el stock, y **la nueva orden de
producción viene precargada con lo que falta**. Es un número editable, no una
orden: la última palabra la tiene quien cocina.

### Los snapshots sobreviven a la edición

Editar un pedido conserva el precio y el costo congelados de las líneas que ya
estaban. Solo los productos que se agregan hoy se costean hoy.

Si la empanada subió de $800 a $1.200 entre el pedido y la corrección, el cliente
paga los $800 que se le dijeron. Re-snapshotear todo al editar hubiera sido una
línea menos de código y una forma silenciosa de cambiarle el precio a alguien.

### Anular deshace todo — la deuda que quedaba de la venta rápida

Hasta acá, una venta cargada mal no se podía deshacer. Ahora `anularPedido()`:

- devuelve el producto al stock, con su movimiento y el motivo
- deja un **egreso compensatorio** en caja por cada cobro
- deja el pedido en `cancelado`, así que sale de la rentabilidad

**Los cobros no se borran.** La plata entró y después salió, y las dos cosas
pasaron de verdad. Borrarlos dejaría una caja que cierra por casualidad y un
historial que miente sobre lo que ocurrió ese día.

El motivo es obligatorio y va a `notas`: el esquema del PDR no tiene un campo
propio, y cuando esto pase a Postgres se verá si merece una columna.

### Anular es solo del admin

Permiso nuevo `anularPedidos`, apagado para la trabajadora. Es la única operación
del módulo que mueve stock **y** caja a la vez y hacia atrás. Cargar, entregar y
cobrar sí las hace ella: es su trabajo.

Los otros dos permisos nuevos —`cargarPedidos` y `gestionarClientes`— están
prendidos para trabajadora y apagados para la comisión, que mira y no opera.

### Cobrar de más no es un cobro

`registrarCobro()` rechaza cualquier monto que pase el total. Cobrar de más sería
una deuda del negocio con el cliente, y eso no tiene nada que ver con este
pedido. La suma de cobros contra el total es lo único que define `estado_pago`:
nunca se escribe a mano.

### La venta de mostrador se marca, no se deduce

Las ventas rápidas no aparecen en la lista de pedidos ni en la agenda: son
decenas por día y no hay nada que hacer con ellas ahí. Se ven en Caja y en el
cierre semanal.

La primera versión las reconocía por su forma —presencial + entregado + mismo
día— y eso hacía desaparecer de la lista a un encargue del CIC justo después de
entregarlo. Ahora llevan `es_mostrador`, que es una columna booleana más cuando
esto pase a Postgres.

### Los clientes frecuentes ahora son los que más compran

Los chips de la hoja de cobro eran los tres primeros por orden alfabético, así
que el club que compra todas las semanas no aparecía nunca. Era la deuda anotada
en `docs/REVISION-FASES-2-3.md`, y estaba esperando el criterio de segmentación
que trae este módulo.

### El teléfono identifica, así que se compara por dígitos

"2494 55-1234" y "249455 1234" son el mismo número. Sin normalizar, el mismo
cliente entraba dos veces, el historial quedaba partido y el segmento mentía.

---

## Qué mira cada rol

| | Admin | Trabajadora | Comisión |
|---|---|---|---|
| Tab Clientes | sí | no | no |
| Cargar y editar pedidos | sí | sí | no |
| Entregar y cobrar | sí | sí | no |
| Costo y margen del pedido | sí | **no** | sí |
| Anular | sí | **no** | no |
| Pantalla de arranque del tab | Pedidos | Venta rápida | — |

Verificado en el navegador: con sesión de trabajadora, la ficha del pedido no
trae el bloque de costo ni el botón de anular.

---

## Lo que quedó afuera

- **Editar un pedido ya entregado.** Para corregirlo hay que anularlo y cargarlo
  de nuevo. Es más ruidoso y deja el rastro completo, que es lo que importa.
- **Devolución parcial.** Anular es todo o nada.
- **Recordatorio de cobro por WhatsApp.** La alerta existe; mandar el mensaje es
  a mano.

---

## Tests

`test/fase-2.test.mjs` — 90 casos. Los que más valen son los que verifican que
**no** pase algo:

- cargar un pedido no toca el stock ni la caja
- entregar no toca la caja, y cobrar no entrega
- no se entrega dos veces, no se cobra de más, no se anula dos veces
- editar conserva el precio congelado aunque el producto haya subido
- el pedido anulado sale de la rentabilidad y deja la caja en cero
- la comisión no puede cobrar ni entregar, y la trabajadora no puede anular —
  cerrado en la función, no en la interfaz
