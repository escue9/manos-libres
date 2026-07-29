# Revisión profunda — Fases 2 y 3

Revisión de código de lo construido en Ventas (venta rápida) y Equipo (jornadas
y liquidación). Cada hallazgo se reprodujo corriendo el módulo real antes de
tocar nada, y cada arreglo dejó su caso en `test/regresiones.test.mjs`.

**Lo importante:** las cinco suites por fase estaban en verde y ninguna de ellas
veía estos bugs. Faltaba un tipo de prueba, no más pruebas del mismo tipo:
ninguna renderizaba dos veces sobre el mismo nodo, ninguna llamaba a las
funciones exportadas con argumentos inventados, y ninguna simulaba un fallo a
mitad de una transacción.

---

## Los que pagaban de más

### 1 · Los listeners se acumulaban en cada render

`js/modules/trabajadoras.js` · `js/modules/pedidos.js`

Las dos vistas colgaban sus listeners de `vista`, que es el `<section>`
permanente de `index.html`. `vista.innerHTML = …` borra los hijos pero **no** los
listeners del propio nodo. Como `render()` se vuelve a llamar desde el handler,
cada tap dejaba un handler más pegado, y todos corrían.

Medido, marcando cuatro días seguidos en Equipo:

```
tap 27/07 ->  1 jornada
tap 28/07 ->  4 jornadas
tap 29/07 -> 11 jornadas
tap 30/07 -> 26 jornadas

esperado: 4 jornadas / $20.000
real:    26 jornadas / $130.000
```

El viernes se liquidaba **seis veces y media** lo que correspondía, con su egreso
en caja. En venta rápida el mismo defecto hacía que, después de ir y volver de
otra pestaña, un tap sumara dos empanadas y se cobrara el doble.

**Arreglo:** el contenido va dentro de un nodo propio (`#equipo-root`,
`#venta-root`) y los listeners cuelgan de ahí. Mueren con el `innerHTML`.

---

## Los que dejaban entrar donde no

### 2 · El `origen` de una jornada era un parámetro, y esquivaba las dos guardas

`js/modules/trabajadoras.js` — `marcarJornada()`

```js
if (origen === 'admin') auth.exigir('liquidar');
if (origen === 'autoreporte' && auth.trabajadoraId !== trabajadoraId) throw …
```

Con `origen: 'x'` no corría ninguna de las dos. Desde la consola del celular,
una trabajadora podía borrar días confirmados de otra —que entonces cobraba
menos— y crear jornadas a nombre de otra. Peor: el `'creada'`/`'borrada'` que
devuelve funcionaba como oráculo para reconstruirle la semana entera, que es
exactamente lo que prohíbe la regla 8.

**Arreglo:** el origen ya no se pasa, se deriva del rol. La superficie
desaparece en vez de taparse.

### 3 · `asignarTrabajadoras()` no validaba permisos

`js/modules/produccion.js`

Las jornadas que crea nacen `confirmada: true`, o sea que van derecho a la
liquidación sin pasar por el circuito de autoreporte. El bloque de equipo estaba
oculto en la interfaz, pero la función quedaba abierta: una trabajadora podía
autoasignarse días pagos. **Arreglo:** `auth.exigir('liquidar')`.

### 4 · `window.db` y `window.auth` iban a producción

`js/app.js`

Anulaban todos los `auth.exigir()` del sistema. Con la sesión de una trabajadora
abierta, `auth.rol = 'admin'` alcanzaba para ver la caja, y
`db.from('trabajadora').select()` devolvía nombres, tarifas y **hashes de PIN**
de todo el equipo — que con el salt disponible se rompen offline en segundos.

**Arreglo:** solo en `localhost`. Y `state.cargar()` ahora recorta lo que cada
rol puede tener en memoria: el hash del PIN no lo lleva nadie, y la tarifa ajena
tampoco. Ocultarla al renderizar no alcanzaba, el dato seguía estando.

---

## Los que descuadraban los números

### 5 · Una jornada retroactiva se pagaba con la tarifa nueva

`js/calc.js` — `tarifaVigente()`

Cuando ninguna fila histórica era anterior a la fecha, caía al fallback, que es
`trabajadora.tarifa_dia`: **la tarifa de hoy**. Y las trabajadoras del `seed()`
no tienen fila inicial, así que el primer aumento dejaba el historial arrancando
recién ese día.

Ana a $5.000, el 29/07 le suben a $9.000, y después cargan la jornada olvidada
del 01/06: se pagaba $9.000. Es justo lo que `tarifa_historica` viene a evitar.

**Arreglo:** si la fecha es anterior a todo el historial se usa la fila más
vieja, no la tarifa actual. Y `guardarTrabajadora()` siembra la fila vieja antes
de registrar el aumento, para las que venían sin historial.

### 6 · A la que dejó de trabajar se le pagaba sin mostrarlo

`js/modules/trabajadoras.js`

`resumenSemana()` armaba las filas desde `state.trabajadoras`, que trae solo las
activas. `liquidarSemana()` no filtra por activa: paga todas las confirmadas del
rango. María trabaja lunes y martes, la dan de baja el miércoles, y el viernes
el modal mostraba un total y la caja registraba $10.000 más. Si era la única con
pendiente, el botón quedaba deshabilitado y esos días **no se pagaban nunca**.

**Arreglo:** el resumen suma a quien tenga jornadas en el rango aunque ya no
esté activa, con un badge "Ya no trabaja". Lo que se muestra es lo que se paga.

### 7 · Se podía desconfirmar una jornada ya liquidada

`confirmarJornada()` solo validaba el permiso, no el estado. Desconfirmar algo
pagado saca el jornal del costo laboral pero deja el egreso en la caja: la
rentabilidad y la caja dejan de cerrar, que es la regla 5. **Arreglo:** no se
tocan las pagadas.

### 8 · La venta podía quedar a medio hacer y contar igual

`js/modules/pedidos.js` — `registrarVenta()`

IndexedDB no da una transacción que abarque las cinco tablas. El pedido nacía
`entregado`/`pagado`/`monto_cobrado: total` **antes** de que existiera el cobro.
Si fallaba el insert del cobro —almacenamiento lleno en un celular viejo—
quedaba una venta fantasma sumando a la ganancia sin un peso de respaldo, con el
stock sin descontar y sin su movimiento. Y como la interfaz decía "no se pudo",
la usuaria reintentaba y la duplicaba.

**Arreglo:** nace `pendiente`/`impago` y el último paso la pasa a
`entregado`/`pagado`. Un corte a mitad deja un pedido que no cuenta ni en la
rentabilidad ni en la caja, y se ve para limpiarlo.

### 9 · El stock se escribía desde la caché en memoria

`(l.producto.stock_actual || 0) - l.cantidad` tomaba el valor cacheado en
`state`, no el de la base: es un `SET`, no un decremento. Con dos pestañas
abiertas, la que tenía el dato viejo pisaba lo que había hecho la otra, y los
`movimiento_stock_producto` dejaban de cuadrar con `stock_actual` — que es el
único control que existe. **Arreglo:** se relee el producto antes de escribir.

---

## Los de uso diario

### 10 · "Mantener apretado para restar" no hacía nada

Documentado como funcionalidad viva en `docs/VENTA-RAPIDA.md`. A los 480 ms
restaba uno, y al soltar el navegador sintetizaba el `click` que volvía a sumar.
Neto: cero. La única forma real de restar quedaba siendo el `−` de 36 px, por
debajo del mínimo de 44 que usa el propio repo. **Arreglo:** una bandera que
consume el click siguiente, más 12 px de tolerancia al temblor del dedo.

### 11 · Se podía cerrar la hoja de cobro mientras guardaba

El botón se deshabilitaba, pero el fondo y "Cancelar" seguían activos y el
carrito no se vaciaba hasta el final. Cerrar mientras decía "Guardando…" dejaba
la barra con los items cargados: cobrar de nuevo eran dos ventas idénticas.
**Arreglo:** no se puede cerrar mientras guarda, y el carrito se vacía apenas la
venta existe.

### 12 · La hoja de cobro no decía qué se estaba cobrando

Último control antes de una escritura que no se puede deshacer, y solo mostraba
el total. Ahora muestra `3× Empanada de carne · 1× Tarta de verdura`. Cero taps
extra.

### 13 · Se podían marcar días que todavía no pasaron

Una jornada es un hecho. Los días futuros ahora están deshabilitados en la
grilla y rechazados en la función. El autoreporte además solo llega 14 días
atrás: marcar dentro de una semana ya liquidada metía jornadas nuevas en un
rango cerrado.

### 14 · Un tap sin querer borraba un día ya confirmado

La trabajadora podía borrar su propia jornada aunque el admin ya la hubiera
confirmado, sin aviso y sin rastro. Con botones de 44 px, una mano y apuro, era
el escenario más probable de todos. **Arreglo:** si ya la confirmaron, no se
toca.

### 15 · `created_by` quedaba en `null` en toda venta del admin

`auth.trabajadoraId` es `null` para el rol admin, así que no se distinguía "la
cargó el admin" de "no se sabe quién la cargó". Se agregó `created_by_rol`.

### 16 · El movimiento de stock caía otro día que su pedido

`toISOString()` da UTC. Una venta del domingo 21:30 dejaba el pedido fechado
domingo y el movimiento de stock lunes — y como los filtros comparan strings,
un día entero se caía de los reportes. Nuevo `ui.ahoraISO()`: marca de tiempo
con la fecha local adelante. **Esto importa antes de arrancar la Fase 4**, que
es la que filtra por rango semanal.

---

## Revisado y no tocado

**Quiénes trabajan en una orden abierta.** La Fase 1 lo había ocultado a las
trabajadoras y la Fase 3 lo abrió con un criterio distinto: se ven los nombres
mientras la orden está abierta —es la coordinación del día, están todas en la
misma cocina— y desaparece cuando la orden se cierra, que es lo que impediría
reconstruir la asistencia histórica de las demás. El razonamiento está en
`docs/FASE-3.md` y se respetó. **Es el único punto donde las dos fases opinaron
distinto: si preferís el criterio estricto de la Fase 1, es cambiar una línea.**

**Vender con stock en cero** sigue siendo deliberado (`docs/VENTA-RAPIDA.md`):
la comida está físicamente ahí, y el negativo es la señal de que falta cargar la
producción.

**Los chips de "cliente frecuente"** son los tres primeros por orden alfabético,
no los que más compran: el club que compra todas las semanas no aparece nunca.
No lo toqué porque el criterio real de segmentación es parte del módulo de
Clientes, que es lo que queda pendiente de la Fase 2.

**Anular una venta** sigue siendo deuda conocida, ya documentada.

---

## Tests

`npm test` · 226 pruebas (42 + 20 + 82 + 50 + fugas + 32)

`test/regresiones.test.mjs` es nuevo y tiene un caso por cada arreglo de acá.
Los tres que más valen:

- cuatro renders y un tap crean **una** jornada
- si falla el cobro, el pedido **no** queda como entregado ni suma a la ganancia
- una jornada anterior al aumento se paga con la tarifa vieja

Cambió un contrato: `state.cargar()` ahora depende del rol, así que hay que
llamarlo **después** de resolver la sesión. La app lo hace en `arrancarSesion()`.
