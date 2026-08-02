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

`node test/fase-4.test.mjs` · 37 casos

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

- [ ] Filtro por rubro dentro de los gastos, cuando haya volumen suficiente
- [ ] Comparar el cierre contra el promedio de las últimas cuatro semanas, no
      solo contra la anterior
- [ ] Editar o anular un movimiento manual cargado con un error de tipeo
- [ ] Que la rentabilidad permita elegir un rango de fechas arbitrario
