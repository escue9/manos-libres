# Fase 4 — Caja, cierre semanal y rentabilidad ✅

513 pruebas en verde. El módulo existe para responder tres preguntas que hasta
ahora el sistema tenía pero no mostraba: cuánto hay en la caja, si la semana dio
ganancia, y qué producto conviene empujar.

---

## Qué se construyó

El tab **Caja** tiene tres pantallas: Movimientos · Cierre · Rentabilidad.

### Movimientos

Libro único con el saldo arriba, filtro por entró/salió y exportable a CSV.
Cada fila dice de dónde vino, y los automáticos se marcan como tales.

El alta manual acepta **solo** gasto operativo, aporte y retiro. Los cobros, las
compras de insumo y los jornales los genera su propio módulo (regla 6); el
formulario lo explica y la función los rechaza aunque se la llame desde la
consola. El rubro solo aparece si es un gasto, que es el único caso donde
significa algo.

### Cierre semanal

Navegación por semanas, hero con semáforo y el desglose del PDR §5.3:

```
Ventas
− Costo de mercadería
= Margen bruto            (%)
− Costo laboral
− Gastos operativos
= Ganancia neta           (%)
```

Debajo, en su **propio bloque y con su propia explicación**, la caja de la
semana: lo que efectivamente entró y salió.

### Rentabilidad por producto

Por semana, mes o todo. Cada producto con unidades vendidas, facturación,
margen en pesos y en porcentaje, y cuánto aporta al total. Clasificados en los
cuatro cuadrantes del PDR contra la mediana del resto.

### Exportables

- **CSV** de movimientos, con `;` y BOM para que Excel en español no rompa los
  acentos ni interprete la coma como decimal
- **Rendición de cuentas** — movimientos por rubro más el resultado del período
- **Impacto social** — jornadas generadas, mujeres que trabajaron, trabajadoras
  activas y monto pagado en jornales. Es el dato que piden los concursos de
  financiamiento

Los dos reportes salen por la ventana de impresión del navegador, que en el
celular ofrece "Guardar como PDF". Generar un PDF a mano necesitaría una
librería y la regla 2 no las admite.

---

## Decisiones

### Caja y rentabilidad nunca comparten un número

Es la regla 5 y es la razón de ser del módulo. Se calculan por separado, se
muestran en bloques distintos y el de caja lleva una línea que lo explica en
castellano: *un pedido entregado e impago suma a la ganancia de arriba y no
acá*. Confundirlas es lo que hace parecer rentable a un negocio que no cobra.

### El descuento se prorratea entre las líneas del pedido

`rentabilidadProductos()` reparte el descuento del pedido entre sus líneas en
proporción a lo que pesa cada una. Sin prorratearlo, la suma de la facturación
por producto no da igual que las ventas del cierre, y dos pantallas que miran lo
mismo mostrarían números distintos. Hay un test que verifica que cierren exacto.

### Una semana sin actividad no va en verde

El semáforo sobre un cero se leía como "todo bien" cuando en realidad no dice
nada. Una semana sin entregas queda neutra y lo aclara con palabras.

### Sin semana anterior no se inventa un porcentaje

Comparar contra cero da `-100%` o infinito. Cuando no hay base, se dice que es
la primera semana con datos y listo.

### La comisión mira, no opera

El rol `dirigente` ve la caja y puede exportar, pero no carga movimientos.
Permiso nuevo `cargarCaja`, aplicado con `auth.exigir()` dentro de la función y
no solo escondiendo el botón.

---

## Tests

`node test/fase-4.test.mjs` · 68 casos (37 originales, 13 del addendum de
anulaciones y 18 del de comparativas)

Los que más valen son los que verifican que **no** pase algo:

- Un cobro, una compra de insumo o un jornal **no se pueden cargar a mano**
- Un monto en cero, negativo o con fecha futura no entra
- Un pedido entregado e impago suma a las ventas y **no mueve la caja**;
  cobrarlo sí la mueve y **no vuelve a sumar** a las ventas
- La facturación por producto cierra exacto contra las ventas del cierre
- La rentabilidad usa los snapshots, no los precios de hoy (regla 4)
- Un producto dado de baja no rompe el informe
- Una trabajadora no carga movimientos y no ve la tab; la comisión ve pero no
  opera

---

## Pendiente

- [x] Filtro por rubro dentro de los gastos — ver el addendum de comparativas
- [x] Comparar el cierre contra el promedio de las últimas cuatro semanas, no
      solo contra la anterior — ídem
- [x] Editar o anular un movimiento manual cargado con un error de tipeo — ver
      el addendum de abajo
- [x] Que la rentabilidad permita elegir un rango de fechas arbitrario — ver
      el addendum de comparativas

---

## Addendum — anular un movimiento manual

Un gasto tipeado con un cero de más no tenía arreglo salvo la consola. Ahora en
**Movimientos** los manuales vigentes (gasto, aporte, retiro) se tocan y abren
su detalle con dos salidas: **Anular y cargar corregido** —que abre el alta
precargada— o **Solo anular**. Las dos piden motivo.

`anularMovimiento(id, motivo)` no borra nada. Deja un contramovimiento del tipo
opuesto, mismo origen, monto y rubro, con `referencia_id` al original, igual
que `anularPedido()` con los cobros. No hizo falta migración: el esquema ya
tenía todo.

**Lleva la fecha del original, no la de hoy.** La devolución de un pedido es
plata que salió hoy; un error de carga es plata que nunca se movió. Con la
fecha de hoy, la semana del error seguiría mostrando el gasto falso.

Lo que tuvo que cambiar alrededor para que la anulación no ensucie números:

- `calc.cierreSemanal()` resta los gastos de tipo ingreso, que son anulaciones.
  Antes sumaba el monto sin mirar el tipo y el gasto anulado contaba doble
- "Caja de la semana" deja afuera el par anulado: sin eso, un gasto de $85.000
  anulado inflaba el *entró* y el *salió* en $85.000 cada uno
- La rendición de cuentas muestra el neto por rubro. Antes, un rubro con los
  dos sentidos —un cobro y su devolución— mostraba solo el ingreso

Los automáticos (cobro, compra, jornal) no se anulan desde la caja: se deshacen
desde su origen, o la caja queda descolgada del pedido o la compra.

De paso se corrigió el pie de los reportes impresos, que nombraba a Mirmidones
como titular, y el texto del reporte de impacto, que decía "trabajo registrado"
cuando el vínculo laboral todavía no está formalizado.

---

## Addendum — comparativas, rango y rubro

### El cierre contra el promedio de cuatro semanas

Debajo del desglose, un bloque **Contra las semanas anteriores** pone ventas,
margen bruto y ganancia neta contra la semana anterior y contra el promedio de
las cuatro anteriores. La cuenta vive en `calc.promedioSemanas()` y la
variación en `calc.variacionPct()`, las dos puras y con tests.

**Se promedian solo las semanas con ventas.** La cocina para por semanas
enteras, y una semana parada no es una semana mala: es una semana que no hubo.
Si entrara, dos semanas paradas de cuatro partirían el promedio a la mitad y
cualquier semana normal se vería como un +100%. Una semana sin ventas con un
gasto suelto (la garrafa) tampoco cuenta. La pantalla dice cuántas semanas
entraron —"de la única semana con entregas de las últimas 4"— para que un
promedio de una no se lea como si fueran cuatro. Sin ninguna, no hay promedio
y se dice con palabras.

Los porcentajes del promedio salen de los promedios en pesos, no del promedio
de porcentajes: una semana chica con mucho margen no pesa igual que una grande.

Contra una base en cero, `variacionPct()` devuelve `null` y se muestra un
guion. Con base negativa divide por el valor absoluto, para que salir de una
pérdida se lea como mejora.

La comparativa es **solo devengado**: la caja de la semana no se compara ni se
promedia (regla 5). Las anulaciones ya llegan resueltas, porque el promedio se
arma con el mismo `cierreSemanal()` que resta el contramovimiento.

El cierre lee las cuatro tablas una sola vez y calcula las cinco semanas sobre
eso, en lugar de ir cinco veces a la base.

### Rentabilidad por rango

Un chip más, **Rango**, con dos fechas *desde · hasta* en una línea (entra a
390px). Arranca en los últimos 30 días. Un rango al revés no se calcula: se
avisa con `calc.errorRango()` en vez de dejar la lista vacía, que se leería
como "no se vendió nada". Recalcula en `change`, no en `input`.

### Filtro por rubro

El doc decía "cuando haya volumen suficiente", y hoy la cocina no produce.
Se hizo igual porque salió chico: dentro de **Salió** aparece una segunda fila
de chips con los rubros que efectivamente tienen gastos, y nada más. No toca
datos ni cálculos, solo qué filas se ven.
