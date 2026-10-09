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

---

## Addendum — permisos aplicados en la función

Los permisos se validaban solo en la interfaz: los botones se ocultaban, pero
`registrarCompra()` y `guardarReceta()` seguían siendo invocables desde la
consola con rol de trabajadora.

Se agregó `auth.exigir(accion)`, que corta con error si el rol no tiene el
permiso, y se aplicó en las dos funciones que tocan el costeo.

**Por qué importa más allá de la consola:** en la fase 5 cada `exigir()` necesita
su política de RLS equivalente en Supabase. Con el permiso escrito solo en la UI,
ese contrato no existía en ningún lado ejecutable ni testeable — y la primera
señal de que faltaba una política habría sido un error en producción.

### Dónde NO se puso, y por qué

`ajustarStockInsumo()` y `ajustarStockProducto()` quedan sin validación a
propósito:

1. `cerrarOrden()` llama a `ajustarStockInsumo()` cuando hay faltante, y cerrar
   órdenes sí lo puede hacer una trabajadora. Guardar la función rompería ese
   flujo legítimo.
2. Un ajuste mueve cantidades, no plata: no toca `costo_unitario` ni precios, y
   siempre deja un `movimiento_stock_*` con motivo obligatorio. El daño posible
   es acotado y auditable.

El acceso por interfaz igual está restringido: la pantalla de Insumos completa
está detrás de `gestionarInsumos`.

### Tests

9 casos nuevos en `test/fase-1.test.mjs`. Los que importan son los que verifican
que **no** pase nada: que tras el rechazo el costo del insumo no se haya movido y
que no haya quedado un egreso huérfano en caja.

---

## Addendum — vuelta del receso

Octubre 2026. Volvemos de un receso y arrancó Rocío. Hacía falta poner el stock
en cero, cargar las compras de la semana y la producción que salió, y que esa
carga se pudiera hacer sin pantalla, desde la consola o desde otra sesión de
Claude.

### Las pantallas, reorganizadas

Los segmentos pasaron a ser **Stock · Compras · Recetas · Producción**. El PDR
§4.1 se actualizó.

- **Stock** junta lo que antes eran dos pantallas: producto terminado arriba
  (es lo que se mira para vender), insumos abajo por categoría con barra de
  nivel. Tocar cualquier fila ajusta con motivo. El admin ve además "Nuevo
  insumo" y **"Reiniciar stock"**, que pide un motivo escrito
- **Compras** es pantalla propia: el historial de la semana con su total y la
  hoja de compra. En la hoja el insumo se busca escribiendo, y si no existe se
  da de alta ahí mismo. La cantidad va con unidad (500 g de un insumo en kg),
  el medio de pago con los mismos botones que la venta rápida, y antes de
  guardar se ve el costo unitario que resulta
- **Recetas** y **Producción** (las órdenes) quedan como estaban

La trabajadora ve Stock y Producción, en cantidades. Compras, Recetas y el
reinicio no aparecen, y la hoja de una orden no muestra ni un peso.

### Lógica nueva

| Función | Qué hace |
|---|---|
| `calc.costoLote()` | costo de una vuelta de receta con merma; `costoProducto` la divide por el rinde |
| `calc.margenPct()` | el porcentaje de `margen()` solo |
| `crearInsumo()` | alta con stock y costo en cero. Exige `gestionarInsumos` — el modal lo insertaba sin permiso |
| `ajustarStock({ tabla, id, cantidad_nueva, motivo })` | envoltura de los dos ajustes |
| `reiniciarStock(motivo)` | ajuste a cero de todo lo que no está en cero, con una **referencia común** a todos |
| `validarSemana()` / `cargarSemana()` | el importador, abajo |

Otros cambios:

- `crearOrden()` devuelve además `requerimientos` y `faltantes`
- Las alertas de margen traen el texto del PDR: *"Subió el costo de carne
  picada. Empanada de carne bajó a 15.1% de margen."*
- **Un producto sin receta y sin costo manual ya no cierra una orden.**
  Congelaba un snapshot en $0, un margen falso del 100% grabado para siempre
- `guardarReceta()` lee los insumos de la base y no de `state`
- `window.ml.produccion.*` existe solo con sesión de admin. No es la barrera:
  cada función hace su `auth.exigir()`
- `sw.js` pasa a `cocina-cic-v9` para que los celulares bajen el módulo nuevo

### Carga semanal sin pantalla

#### Cómo se usa

```js
const prod = await import('/js/modules/produccion.js');

// Primero ver si pasa, sin escribir nada
await prod.cargarSemana(semana, { soloValidar: true });

// Después cargar
const resumen = await prod.cargarSemana(semana);
```

```js
const semana = {
  reinicio: { motivo: 'Vuelta del receso: conteo en cero' },
  insumos_nuevos: [
    { nombre: 'Tapas de empanada', categoria: 'Almacén', unidad_medida: 'unidad', stock_minimo: 48 },
  ],
  compras: [
    { insumo: 'Carne picada', cantidad: 4000, unidad_medida: 'g', costo_total: 40000,
      proveedor: 'Carnicería', fecha: '2026-10-05' },
    { insumo: 'Tapas de empanada', cantidad: 48, costo_total: 9600, fecha: '2026-10-05', medio: 'transferencia' },
  ],
  recetas: [
    { producto: 'Empanada de carne', rinde_por_lote: 24, items: [
      { insumo: 'Carne picada', cantidad: 1000, unidad_medida: 'g', merma_pct: 10 },
      { insumo: 'Tapas de empanada', cantidad: 24, unidad_medida: 'unidad' },
    ] },
  ],
  producciones: [
    { fecha: '2026-10-06', notas: 'Primera jornada de Rocío',
      items: [{ producto: 'Empanada de carne', cantidad: 48 }] },
  ],
};
```

Insumos y productos se nombran por `nombre` (sin importar mayúsculas) o por
`insumo_id` / `producto_id`. Todas las secciones son opcionales.

#### Qué pasa al cargar

En este orden, y cada paso llama a la misma función que usa la pantalla:

```
reiniciarStock(motivo)    ajuste a 0 de cada insumo y producto con stock ≠ 0
crearInsumo()             nace con stock y costo en cero
registrarCompra()         stock, costo ponderado, egreso en caja, movimiento
guardarReceta()           reemplaza la receta y recalcula el costo
crearOrden() + cerrarOrden()   descuenta insumos con merma, suma producto,
                               congela el snapshot
recalcularCostos()        las alertas de margen, con todo ya aplicado
```

Devuelve un resumen: qué se reinició, qué compras movieron qué costo, qué
órdenes se cerraron con qué costo de insumos, y los productos bajo el 25%.

#### Si algo está mal, no se escribe nada

IndexedDB no da una transacción que abarque todas las tablas. Si la carga
fallara en la tercera producción, quedarían las compras con su egreso en caja y
sin la producción que les sigue.

Por eso `validarSemana()` simula la semana entera en memoria antes de escribir:
el reinicio pone el stock en cero, las compras lo suben y mueven el costo, las
recetas reemplazan a las que había, las producciones consumen. Así ve que falta
carne en la última orden antes de registrar la primera compra.

El error trae **todos** los problemas, cada uno con su lugar:

```
La semana no se cargó. 2 problemas:
- compras[1]: No existe el insumo "Harina 0000"
- producciones[0]: falta stock de Carne picada (hacen falta 2 kg, hay 1).
  Comprá lo que falta o poné motivo_ajuste
```

Con `motivo_ajuste` en la producción, el faltante se ajusta con ese motivo y la
orden cierra, igual que desde la pantalla.

---

#### Decisiones tomadas

**El reinicio no toca el costo.** El último costo conocido sigue siendo la mejor
referencia, y con el stock en cero la próxima compra lo reemplaza entero: el
promedio ponderado contra cero da el precio de la compra.

**Un producto sin receta cierra con su costo manual.** No descuenta insumos. Si
tampoco tiene costo manual, la orden no cierra: un snapshot en $0 es un margen
falso del 100% que queda grabado para siempre (regla 4). Esto vale también para
`cerrarOrden()` desde la pantalla, no solo para el importador.

**La compra puede venir en otra unidad.** `{ cantidad: 4000, unidad_medida: 'g' }`
de un insumo que se mide en kg se carga como 4 kg. Si las unidades no se pueden
convertir (kg y l), es un error.

**Las firmas viejas no se tocaron.** `registrarCompra({ insumoId, costoTotal })`
y `cerrarOrden(id, cantidades, { motivoAjuste })` las usan la pantalla y los
tests. El JSON entra en snake_case y el importador traduce.

**Estado de la orden: `planificada`, no `abierta`.** Es el que dicen el PDR §3 y
el código.

#### Tests

`test/carga-semana.test.mjs` · 78 pruebas. Las que importan son las que
verifican que **no** pase nada: una semana con seis errores no escribe ni la
compra que estaba bien, y un faltante en la producción se detecta antes de
registrar la compra.
