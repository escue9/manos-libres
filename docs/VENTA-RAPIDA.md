# Venta rápida ✅

La pantalla del mostrador del CIC y de la cancha de Uncas. Portada desde
`docs/mockups/venta-rapida.html` a `js/modules/pedidos.js` + `css/components.css`.

Es la pantalla más usada del sistema. Si tiene fricción, no la usan y vuelven
al cuaderno.

---

## Cómo funciona

1. Grilla de productos agrupados por categoría, dos columnas
2. Un tap suma una unidad — badge naranja con la cantidad, borde encendido
3. Para restar: el botón `−` de la tarjeta, o **mantener apretado 0,5s**
4. La barra inferior muestra items y total en vivo
5. **Cobrar** abre la hoja: cliente (opcional) + medio de pago
6. **Confirmar** registra todo y muestra el total del día actualizado

Cada tap vibra el teléfono. Suena a poco, pero es la confirmación que necesita
alguien que está cargando sin mirar la pantalla.

## Qué pasa al confirmar

Una venta de mostrador es un pedido que **termina** entregado y cobrado. En orden:

```
pedido (estado: pendiente, canal: cic_presencial, estado_pago: impago)
  └─ pedido_item[]        con precio_unitario y costo_unitario CONGELADOS
  └─ por cada producto:
       ├─ producto.stock_actual  descontado (releído de la base, no de la caché)
       └─ movimiento_stock_producto  tipo 'venta', cantidad negativa
  └─ cobro                monto y medio
       └─ movimiento_caja ingreso automático, apunta al cobro
  └─ pedido → entregado / pagado / monto_cobrado      ← el commit
```

**El pedido nace `pendiente` y recién el último paso lo confirma.** IndexedDB no
da una transacción que abarque las cinco tablas: si algo falla en el medio, se
revierte todo lo escrito y se devuelve el stock. Naciendo `entregado`/`pagado`,
un corte a mitad dejaba una venta fantasma sumando a la ganancia sin un peso de
respaldo, y la usuaria —que veía "no se pudo"— la volvía a cargar. El stock va
antes que el cobro porque es el paso con más escrituras: si revienta ahí,
todavía no se registró plata en la caja.

**Los snapshots son el punto clave.** Si mañana sube la carne, el margen de las
ventas de hoy no cambia. Los reportes históricos quedan inmutables (PDR §3).

**El movimiento de caja se genera solo.** Nunca cargarlo a mano además: eso
produce doble conteo, que es el error más común en este tipo de sistemas
(regla 6 de `CLAUDE.md`).

---

## Decisiones tomadas

**Se puede vender sin stock cargado.** La tarjeta avisa en amarillo, pero no
bloquea. Razón: la comida está físicamente ahí; si el stock dice cero es porque
no se cargó la producción, no porque no haya. Bloquear la venta por un dato mal
cargado sería la forma más rápida de que dejen de usar el sistema. El stock
queda en negativo y eso mismo es la señal de que falta cargar producción.

**El cliente es opcional.** En el mostrador no se le pide el nombre a nadie.
Aparecen como chips los clientes ya cargados, por si es una venta a alguien
conocido.

**Reusa el modal de `components.css`.** El mockup traía su propio bottom sheet;
se descartó y se usó el `.modal__panel` que ya existía, que en mobile ya es una
hoja desde abajo. Las clases crípticas del mockup (`.p`, `.qty`, `.pay`, `.who`)
se renombraron a `.producto-card`, `.producto-card__cantidad`, `.medio`, `.chips`.

---

## Tests

`node test/venta-rapida.test.mjs` · 20 pruebas

Cubre la transacción completa: que el pedido nazca entregado, que los snapshots
se congelen, que se genere **un solo** movimiento de caja, que el stock baje y
deje rastro, y que el cierre semanal después vea esa venta con el costo correcto.

---

## Pendiente de Fase 2

- [ ] Pedidos con fecha de entrega futura y cliente obligatorio
- [ ] Agenda semanal de entregas
- [ ] Clientes con segmento e historial
- [ ] Anular una venta del día (hoy hay que borrarla desde la consola)

Lo de anular es lo primero que van a pedir apenas alguien se equivoque.
