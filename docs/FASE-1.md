# Fase 1 — Producción y costeo ✅

Ya se conoce el costo real de cada producto. Se cargan insumos con su costo,
se arman recetas, se planifica una jornada de cocina y al cerrarla el sistema
descuenta los insumos, suma lo producido y congela el costo.

Todo vive en `js/modules/produccion.js` con cuatro pantallas y subnavegación.

---

## Qué quedó construido

### Conversión de unidades — `js/calc.js`

Era el TODO que hacía inservible el costeo: una receta que mezclaba gramos con
kilos daba un número cualquiera. Ahora `convertir()` maneja g↔kg y ml↔l dentro
de la misma familia.

**Si las unidades no son compatibles, tira error en vez de devolver un número.**
Un costo mal convertido no se nota mirando la pantalla: se nota tres meses
después, cuando el margen histórico no cierra. El editor de recetas solo ofrece
las unidades compatibles con el insumo, así que por la interfaz no se puede
cargar mal.

### 1 · Insumos

Listado agrupado por categoría en orden de góndola, con barra de nivel y badge
de estado. Alta y edición.

**Registrar compra** es la transacción central. En orden:

```
compra_insumo
  ├─ insumo.stock_actual         sumado
  ├─ insumo.costo_unitario       promedio ponderado (PDR §5.1)
  ├─ movimiento_caja             egreso automático, apunta a la compra
  ├─ movimiento_stock_insumo     tipo 'compra'
  └─ recálculo del costo de todos los productos que usan ese insumo
```

Antes de confirmar, la pantalla muestra la cuenta: *"Pagás $40.000 por kg. El
costo del insumo queda en $27.547 (venía de $9.500)."*

Si algún producto quedó bajo el 25% de margen, avisa con nombre y número:
*"Empanada de carne — bajó a 14.8% de margen."*

### 2 · Recetas

Qué insumos lleva un producto por lote, en qué cantidad y con qué merma. El
costo por unidad y el margen se recalculan **en vivo** mientras se escribe, así
se ve el efecto de subir 50 g de carne antes de guardar.

### 3 · Órdenes de producción

Una orden es una jornada de cocina.

- Antes de empezar: tabla de **insumos requeridos vs disponibles**, faltantes en rojo
- Asignar trabajadoras crea sus jornadas, con la tarifa congelada desde
  `tarifa_historica` según la fecha de la orden — no desde `trabajadora.tarifa_dia`
- Al cerrar se carga la cantidad **real**: descuenta insumos con merma, suma
  producto terminado, congela `costo_unitario_snapshot` e imputa las jornadas

**No se cierra una orden con insumo insuficiente.** Tira un error con la lista de
faltantes. Para cerrar igual hay que dar un motivo, y ese ajuste queda
registrado con su movimiento de stock.

### 4 · Stock terminado

Qué hay de cada producto con badge de estado y el valor total del stock. Ajuste
manual con **motivo obligatorio** — el mismo criterio que en insumos.

---

## Decisiones tomadas

**La mano de obra no entra en el costo del producto.** Se imputa a la orden y al
cierre semanal. Está en el PDR §5.2 y se respetó: la tarifa es por día
trabajado, prorratearla daría un costo unitario que se mueve sin relación con el
producto.

**El snapshot manda sobre el costo actual.** Al cerrar una orden se congela el
costo unitario en `produccion_item`. Si al día siguiente se dispara la carne,
el costo de hoy sube pero el de la producción de ayer no se toca. Hay un test
que verifica exactamente eso.

**Permiso nuevo: `gestionarInsumos`.** Comprar y editar insumos y recetas es
plata: solo admin. Cargar y cerrar órdenes de producción no lo es, y la
trabajadora tiene que poder hacerlo (PDR §2). Ese es el corte.

**Una trabajadora no ve quién trabajó en la orden.** El bloque "Quiénes
trabajan" solo aparece con `verEquipoCompleto`: para una trabajadora, la lista de
nombres asignados ya sería ver los días de otra (regla 8). El autoreporte de la
propia jornada es de la Fase 3.

**Se puede vender con stock en cero, pero no producir con insumo en cero.** No es
contradictorio: la comida terminada está físicamente ahí aunque el sistema diga
cero, pero si no hay harina no hay harina.

**Las recetas no se siembran.** `seed()` carga diez insumos con costos de punto
cero, que se corrigen solos con la primera compra real. Las recetas se arman
desde la pantalla con los insumos reales de la cocina: ese es el trabajo de la
puesta en marcha, no algo para inventar acá.

---

## Arreglos que salieron al paso

- **Las fechas se mostraban un día antes.** `new Date('2026-07-28')` es
  medianoche UTC, que en Argentina todavía es el 27 a las 21:00. `ui.fecha()`
  ahora parsea las fechas `YYYY-MM-DD` como locales
- **`hoyISO()` daba mañana después de las 21:00.** Una venta en la cancha de
  Uncas quedaba fechada al día siguiente. Está en `ui.hoyISO()` y lo usan los
  dos módulos
- **Dos campos al lado se iban de pantalla a 390px.** El ancho por defecto de un
  `<input>` es de 20 caracteres y no achicaba: `min-width: 0` en `.input`,
  `.field` y `.grow`
- **Los tests no corrían.** Importaban `./js/…` desde `test/`, que no existe

---

## Checklist de aceptación

**Automático** — `npm test` · 135 pruebas (42 + 20 + 73)

- [x] El costo ponderado se aplica bien al comprar y no reemplaza al anterior
- [x] La compra genera **un** egreso en caja, automático
- [x] Una receta que mezcla gramos con kilos costea bien
- [x] Unidades incompatibles tiran error, no un número inventado
- [x] Cerrar una orden descuenta los insumos correctos, con merma
- [x] El snapshot de producción no cambia cuando después sube un insumo
- [x] No se cierra una orden con faltante sin motivo explícito
- [x] Los ajustes de stock exigen motivo y guardan la diferencia
- [x] La jornada congela la tarifa histórica, no la de la ficha
- [x] Una trabajadora no ve costos, ni márgenes, ni al equipo

**Probado a 390px en el navegador**

- [x] Las cuatro pantallas y los cinco modales, sin scroll horizontal
- [x] Flujo completo: receta → orden → asignar → cerrar → stock actualizado
- [x] Compra con alerta de margen
- [x] Ajuste rechazado sin motivo
- [x] Vista de trabajadora sin un solo número de plata

---

## Cómo probarlo

```bash
python -m http.server 8000
```

1. **Insumos** → tocá Harina 000 → Registrar compra → 25 kg por $40.000.
   El costo pasa de $1.200 a $1.400: promedio ponderado, no reemplazo
2. **Recetas** → Empanada de carne → 1 kg de harina + 500 g de carne con 10% de
   merma, rinde 24. Mirá el costo moverse mientras escribís
3. **Órdenes** → `+` → 48 empanadas → mirá los insumos requeridos → asigná a
   alguien → Cerrar orden
4. **Stock** → las 48 aparecen sumadas

Para empezar de cero: `await db.reset()` en la consola y recargar.

---

## Lo que sigue

Fase 2 (clientes, pedidos y agenda de entregas) o Fase 3 (jornadas y
liquidación). La Fase 1 ya dejó las jornadas creándose desde las órdenes, así
que la 3 arranca con datos reales para mostrar.

Sigue pendiente de la Fase 2 lo que ya estaba: **anular una venta**.
