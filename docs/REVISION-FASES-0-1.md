# Revisión profunda — capa base, Fase 1, y auditoría de la revisión anterior

Tres revisiones en paralelo antes de arrancar la Fase 2:

1. **La capa base** (`db.js`, `auth.js`, `sw.js`, `app.js`, `ui.js`) — nunca se había revisado
2. **La Fase 1** (producción y costeo) — la había escrito y auto-revisado yo, con el sesgo que eso implica
3. **Los arreglos de `docs/REVISION-FASES-2-3.md`** — nadie los había revisado

La tercera fue la más incómoda y la más útil: **uno de esos arreglos había
introducido un bug peor que el original.**

---

## El arreglo que rompió más de lo que arregló

Para evitar que se cerrara la hoja de cobro mientras guardaba, se apagaba
`pointerEvents` de los `[data-close]` del modal. En la rama de éxito nunca se
restauraba — y el fondo del modal es un nodo **permanente** de `index.html`.

Después de la primera venta del día, **ningún modal se podía volver a cerrar
tocando afuera**. Y como `modalOrden`, `modalInsumo`, `modalCompra`,
`modalAjuste` y el menú del header no tienen botón de cerrar, la única salida
era una acción destructiva o recargar la app.

Ahora el bloqueo es una bandera en `ui`, `cerrarModal()` la respeta y devuelve
si pudo cerrar, y `abrirModal()` la limpia en cada apertura.

En el mismo módulo: `ui.confirmar()` **nunca resolvía si tocabas "Cancelar"**.
El modal cerraba, la promesa quedaba colgada para siempre y el handler que la
esperaba no terminaba nunca. Ahora resuelve por cualquier vía de cierre.

---

## Lo que corrompía o perdía datos

### El backup no se podía restaurar

`importAll()` **no la llamaba nadie**: no había botón, y en el celular de la
cocina no hay consola. El `.json` semanal era un archivo que nadie podía volver
a meter en la app. Y si se lo llamaba, escribía encima fila por fila sin borrar:
restaurar la copia del lunes revivía lo borrado y dejaba lo cargado el jueves,
mezclando dos momentos distintos sin avisar.

Ahora: botón **Restaurar** en el menú, con confirmación que dice la fecha de la
copia y que lo posterior se pierde; `importAll` reemplaza tabla por tabla en una
transacción, valida que el archivo sea un backup y rechaza los de versiones más
nuevas. La descarga además estaba rota en Firefox (el `<a>` fuera del DOM y el
blob revocado en la misma vuelta del event loop) y el toast decía "Copia
descargada" pasara lo que pasara.

**El export ya no lleva los PIN.** Llevaba el hash del admin, el salt y el de
cada trabajadora en el mismo archivo que se manda por WhatsApp: con el salt al
lado, cuatro dígitos se rompen probando diez mil combinaciones.

### `update()` perdía escrituras

Era read-modify-write en **dos transacciones** y reescribía la fila entera, no
las claves del patch. Dos escrituras sobre la misma fila —dos pestañas, o el
stock y el costo del mismo insumo— se pisaban sin error. Ahora es un cursor
dentro de una sola transacción `readwrite` que aplica solo el patch.

Y `update`/`delete` **sin filtros ahora tiran error**: un `.eq()` olvidado
vaciaba la tabla, y hasta la Fase 5 el backup es la única copia.

### Una trabajadora con el PIN del admin entraba como admin

`ingresar()` prueba el PIN primero contra el admin y después contra cada
trabajadora, y nada impedía repetirlo. Con 1234 —el PIN más elegido del mundo—
una trabajadora veía la caja, los costos y las tarifas de sus compañeras. Entre
trabajadoras pasaba lo mismo: la de uuid más chico se quedaba con la sesión.
Ahora el PIN repetido se rechaza al asignarlo.

### El service worker cacheaba cualquier cosa como si fuera la app

La rama de navegación guardaba la respuesta **sin mirar `r.ok`**. En una red con
portal cautivo —las de los clubes lo son— el fetch resuelve 200 con el HTML del
portal, queda cacheado, y a partir de ahí abrir la app sin internet muestra la
pantalla del portal para siempre. Igual con un 502 durante un deploy. Rompía la
regla 3 sin forma de recuperarse desde la app.

Además, sin red y sin copia, el handler resolvía `undefined` y la pantalla
quedaba en blanco. Ahora devuelve un 503 con texto.

---

## Lo que daba números mal

### Un insumo sin costo costeaba como si fuera gratis

Todo insumo nuevo nace en `costo_unitario: 0` (el costo se carga con la primera
compra, que es deliberado). Pero `costoProducto()` lo sumaba como 0: una
empanada con carne premium sin comprar todavía costaba **$50 con 93% de margen
y ninguna alerta** — las alertas miran el margen bajo, y ese margen se ve
bárbaro. Se firma el precio tranquilo y el número está mal.

Ahora corta con un error que nombra el insumo, igual que con las unidades
incompatibles, y la pantalla lo muestra en rojo en vez de un número.

Relacionado: `costoEfectivo()` usaba `??`, así que un `costo_calculado` de 0 le
ganaba al `costo_manual` cargado a mano. Ahora usa `||`: cero es una receta
rota, no un producto gratis.

### Cambiar la unidad de un insumo no convertía nada

Pasar "Harina 000" de kg a g dejaba **$1.200 por gramo y 25 gramos de stock**:
la empanada pasaba a costar $50.217 y el margen a −6.177%. Ahora `guardarInsumo()`
convierte el stock y el costo (que se mueve al revés que la cantidad), y rechaza
el cambio entre familias pidiendo dar de baja el insumo.

### El doble tap duplicaba la receta y el costo

`#r-guardar` no se deshabilitaba: dos taps borraban e insertaban en paralelo y
dejaban **4 líneas donde iban 2**, con el costo del producto al doble. Ese costo
se congela después en los snapshots, que por la regla 4 son inmutables: el
margen histórico quedaba mal para siempre. Lo mismo en crear orden, nuevo insumo
y ajuste de stock. Ahora hay un helper `alGuardar()` que lo cubre en los seis.

### El insumo se descontaba por lo que salió, no por lo que se usó

Si se planificaban 48 empanadas y salían 36, la harina de las 48 se había usado
igual: quedaba media bolsa fantasma por jornada, y con cantidad real 0 la orden
cerraba **sin descontar nada**. Ahora descuenta por lo planificado.

Y si salía **más** de lo planificado, la orden no se podía cerrar: el campo de
motivo se decidía con los faltantes de lo planificado y nunca se renderizaba,
así que había que mentir el número. Ahora el modal se vuelve a abrir con el
campo y las cantidades que ya se habían cargado.

### `cerrarOrden()` no era atómica ni idempotente

Dos cierres en paralelo pasaban los dos: **+48 unidades de producto terminado
descontando los insumos una sola vez**. Ahora la orden se toma (`en_curso`)
antes de empezar, se libera si se corta antes de escribir, y cada stock se
relee justo antes de su update.

### Un stock negativo envenenaba el promedio ponderado

Con −5 kg a $600 y una compra de 10 kg a $2.000, el ponderado daba **$3.400** —
más caro que la bolsa más cara que se compró en la vida. Ahora el stock previo
negativo se trata como 0, y los ajustes no dejan bajar de cero.

### Una jornada futura se podía liquidar por adelantado

La guarda de fecha futura estaba solo en `marcarJornada()`. Por la puerta de
Producción: crear la orden del sábado el viernes, asignar el equipo, y liquidar
la semana pagaba un día que no pasó — y después no se podía deshacer, porque la
jornada quedaba `pagada` y nada la podía tocar. Ahora `asignarTrabajadoras()`
rechaza órdenes futuras y `liquidarSemana()` nunca alcanza un día posterior a
hoy.

---

## Lo que se veía mal

- **El modal de liquidación mostraba una multiplicación que no daba**:
  `días × tarifa de hoy` contra un total calculado con las tarifas congeladas.
  Subirle la tarifa a alguien el miércoles daba "2 × $9.000 = $10.000" en la
  última pantalla antes de pagar. Ahora desglosa por tarifa real.
- **`order()` ordenaba por código UTF-16**: "Ñoquis" y "Ácido cítrico" caían
  después de la Z y parecían no estar cargados. Ahora usa `localeCompare` en
  es-AR.
- **`inicioSemana('2026-07-27')`** devolvía la semana anterior para todos los
  lunes, porque parseaba en UTC. No explotaba todavía porque el único llamador
  le pasa un `Date` — pero la Fase 4 es justo la que va a pasarle strings.
- **`ui.fecha(null)`** mostraba "31/12" (el epoch) y `ui.fecha(undefined)`
  tiraba `RangeError`, que deja la vista en blanco. Ahora devuelve "—".
- **El listener de teclado del login** se acumulaba en cada cierre de sesión y
  hacía contar doble cada dígito.

---

## Permisos: la documentación decía algo que el código no hacía

`docs/FASE-1.md` justificaba que `ajustarStockInsumo()` no validara permisos
diciendo que "la pantalla de Insumos completa está detrás de `gestionarInsumos`".
No era así: las cuatro subpestañas se renderizan para todos los roles y solo se
escondían el FAB y los botones de compra.

Se resolvió eligiendo el corte y escribiéndolo una sola vez: permiso nuevo
**`cargarProduccion`** (admin y trabajadora sí, comisión no) en `crearOrden`,
`cerrarOrden` y los dos ajustes de stock. `gestionarInsumos` sigue siendo solo
admin para comprar y editar recetas.

---

## Lo que quedó anotado y no se tocó

- **`window.db`/`window.auth` solo en localhost es defensa en profundidad, no
  una garantía.** Desde la consola alcanza con `(await import('/js/auth.js')).auth`
  para conseguir lo mismo: en una app estática sin servidor no hay forma de
  cerrarlo. La garantía real llega con RLS en la Fase 5. El doc anterior lo
  daba por cerrado y no lo estaba.
- **La sesión se puede falsificar** escribiendo `sessionStorage` a mano. Misma
  historia: se arregla de verdad con Supabase Auth.
- **`db.js` no espeja la semántica de Supabase** en `single()` (allá tira error
  con 0 o N filas), en `.update().select()` y en `neq` con nulls. Hoy no rompe
  nada, pero es trabajo de la Fase 5 y conviene tenerlo escrito antes de migrar.
- **`delete` no deja tombstone**, así que la sync de la Fase 5 va a resucitar lo
  borrado offline. Es una tabla nueva de tres campos; va con la Fase 5.
- **Anular una venta** sigue siendo deuda, y ahora es más urgente: el
  procedimiento documentado era borrarla desde la consola, que en el celular ya
  no existe.
- La coma decimal en los `<input type="number">` se lee como campo vacío en un
  teclado en español ("1,5" → `""`). Merece un helper en `ui.js`.

---

## Tests

`npm test` · **272 pruebas** (48 + 20 + 82 + 50 + fugas + 72)

La auditoría también revisó **los tests**, y encontró que varios de la tanda
anterior eran decorativos:

- Los tres de fechas pasaban con el bug restaurado en cualquier máquina con
  `TZ=UTC`, y uno pasaba 21 de cada 24 horas incluso en Buenos Aires. Ahora
  fijan la hora de la franja peligrosa y verifican que la marca no sea UTC.
- `ninguna trae el hash del PIN` pasaba con y sin el arreglo, porque el `seed()`
  no crea PINs y no había nada que filtrar. Ahora el test asigna uno primero.

`test/fase-0.test.mjs` incorpora además las comprobaciones estáticas que
`docs/FASE-0.md` daba por hechas y no existían en ninguna suite: que los 25
archivos del SHELL existan, que los íconos del manifest estén cacheados, que
ningún módulo use `indexedDB` directo y que cada `getElementById` tenga su id en
el HTML. La primera detectó que al SHELL le faltaba `logo-maskable.png` — que es
exactamente lo que rompe el modo avión.
