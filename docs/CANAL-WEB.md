# Canal de venta online ✅

476 pruebas en verde. Hecho fuera del orden de fases porque no dependía de la
Fase 4. Adelanta parte de la Fase 5 sin reemplazarla: **producción, stock,
jornadas y caja siguen en IndexedDB**.

Brief original: `docs/BRIEF-CANAL-ONLINE.md`.

---

## Por qué hay backend acá

El SO es local-first: IndexedDB en el navegador de cada dispositivo. Un cliente
que abre el catálogo desde su celular no tiene forma de escribir en esa base.
Para que el pedido llegue solo hace falta un lugar compartido.

```
Cliente → catalogo/ (público)  →  Supabase  →  el SO lo importa a su pedido local
                                   · catalogo_item   qué se publica
                                   · pedido_web      buzón de entrada
```

Son dos tablas, no una migración. Proyecto: `xkvkzuivyqunduavejla`, región
`sa-east-1`.

---

## Qué se construyó

### El link público — `catalogo/`

Página aparte, sin compartir CSS ni JS con el SO. Habla con PostgREST por
`fetch` plano, sin `supabase-js`: son dos requests y no hay librería que bajar.
Se abre desde un celular con mala señal, quizás desde un link reenviado en un
grupo, y si tarda cierran la pestaña.

Productos por categoría, stepper de cantidad igual al de la venta rápida, barra
inferior con el total en vivo, y el formulario en una hoja que sube desde abajo:
nombre, WhatsApp, retiro o domicilio, dirección solo si sale a la calle, fecha y
comentario. Al enviar, pantalla de confirmación con el número de pedido y un
botón para seguir por WhatsApp — en este rubro la venta se cierra hablando, no
con un "gracias por su compra".

### La pantalla del SO — `js/modules/canal-web.js`

Cuarta subvista de Pedidos, solo administración. Publicar y despublicar por
producto, sincronizar precios, el link con copiar y compartir, y el QR.

### Pendientes y el buzón — `js/modules/pedidos.js`

La subvista Pedidos pasó a llamarse **Pendientes** y agrupa por estado, con los
pedidos del catálogo sin revisar arriba de todo. La revisión va de a uno: qué
pidió, a cuánto, si el precio cambió, cuánto stock hay, y si el teléfono ya es
de un cliente conocido.

### El QR — `js/qr.js`

Modo byte, corrección M, versiones 1 a 10. Escrito a mano: no entran librerías
(regla 2) y un QR contra una API externa no se podría reimprimir sin internet
(regla 3).

---

## Decisiones

### El pedido web nunca entra directo al SO

Llega al buzón y alguien lo revisa antes de convertirlo en pedido. Un
formulario público es una puerta abierta: bromas, pruebas y errores de tipeo no
pueden ensuciar el stock ni la caja.

### El id del pedido lo genera el cliente

Parece al revés, pero `anon` no tiene SELECT sobre `pedido_web` — si lo tuviera,
cualquiera con el link leería los teléfonos y las direcciones de todos los
clientes. Sin SELECT, el insert no puede devolver la fila. Generar el uuid en el
navegador es lo que permite mostrarle al cliente su número de pedido.

### El grant de INSERT es por columna

`estado`, `pedido_id`, `procesado_at` y `creado_at` quedan fuera del grant, así
que nadie puede depositar un pedido ya marcado como importado para que no lo
revise nadie, ni falsear la fecha de entrada. Toman su default sí o sí.

### Primero el pedido local, después la marca en el buzón

`importarPedidoWeb()` crea el pedido en el SO **antes** de marcar el buzón. Al
revés, si la escritura local fallara, el buzón diría "importado" sin que exista
el pedido y nadie lo cocinaría.

Como el buzón es compartido y la cocina tiene más de un dispositivo, la marca
filtra por `estado = 'nuevo'`: es un compare-and-set. Si otra tablet lo tomó
mientras esta lo revisaba, se deshace el pedido local en vez de duplicarlo.

### Importar no toca el stock

El stock se descuenta al **entregar**. Un pedido para el viernes no puede bajar
el stock del lunes: la venta rápida del martes creería que no hay mercadería.
`registrarVenta()` sí descuenta en el acto, pero es otra cosa — ahí entregar y
cobrar pasan juntos.

### Despublicar apaga `activo`, no borra la fila

Un `pedido_web` viejo guarda el `catalogo_item_id` de lo que se pidió. Si se
borra la fila, ese pedido no se puede explicar nunca más.

### `canal` se partió en dos

Mezclaba por dónde **entró** el pedido con cómo **llega** al cliente. Con el
catálogo web eso ya no cierra: hay pedidos que entran por la página y salen a
domicilio. Ahora son `canal` + `modo_entrega`, con migración a la versión 3 de
la base.

### `costo_envio` queda afuera del margen

Hoy vale cero. Suma al total del pedido pero sale del cálculo de margen del
producto: si entrara, el día que se empiece a cobrar el flete toda la
rentabilidad por producto quedaría inflada.

---

## Lo que verifiqué contra el proyecto real

No contra un mock:

| Prueba | Resultado |
|---|---|
| `anon` lee el catálogo activo | 200 |
| `anon` intenta leer el buzón | **401 permission denied** |
| Domicilio sin dirección · teléfono con 0 y 15 · carrito vacío · total negativo | rechazados por los checks |
| Colar un pedido ya marcado como `importado` | **401** — el grant por columna |
| Falsear `creado_at` | **401** |
| Pedido real desde la página a 375px | llegó al buzón con el mismo código que vio el cliente |

Los dos avisos del linter de seguridad son por políticas `using (true)` para
`authenticated`. Están así a propósito: hay un solo usuario autenticado, que es
el SO, y tiene que poder administrar las dos tablas. Atarlas a un `uid`
rompería si alguna vez se recrea el usuario.

---

## Bugs que aparecieron probándolo

Ninguno lo encontraron los tests:

- **`toISOString()` daba UTC** y después de las 21:00 el campo de fecha del
  catálogo no dejaba elegir *hoy* — justo cuando alguien pide para esa noche.
- **El formato del QR pisaba el módulo oscuro**: la segunda copia se parte 7 + 8
  y no 8 + 7.
- **El estado vacío de Pendientes se adelantaba al buzón**: sin ningún pedido
  local pero con pedidos esperando en la nube, no había forma de llegar a ellos.
  Es exactamente la situación del primer día.
- **Dos renders encimados** terminaban en cualquier orden porque el buzón viaja
  por red: el que arrancaba primero llegaba último y repintaba el contador
  viejo, ofreciendo revisar pedidos ya revisados.
- **`onupgradeneeded` solo creaba índices sobre tablas nuevas**, así que agregar
  un índice a `pedido` habría obligado a borrar la base de una cocina con meses
  de datos cargados.
- **`expires_in: 0` caía en el `|| 3600`** porque cero es falsy, y un token ya
  vencido se habría dado por bueno una hora.

---

## Tests

`node test/canal-web.test.mjs` · 102 casos
`node test/migracion-v3.test.mjs` · 12 casos

Los que más valen son los que verifican que **no** pase algo:

- Importar dos veces el mismo `pedido_web` no crea dos pedidos
- Un `pedido_web` descartado no se puede importar después
- Aceptar un pedido **no** mueve stock ni caja; entregarlo sí mueve las dos, y
  una sola vez
- Si otro dispositivo tomó el pedido primero, la importación falla y **no deja
  un pedido colgado** en el SO
- Un pedido con precio viejo se importa con el precio que confirmó la
  administración, y ese precio queda congelado en `pedido_item`
- Una trabajadora no puede ver el buzón, ni importar, ni descartar, ni publicar
- La contraseña de Supabase **no queda guardada en ningún lado**: se usa una vez
  para pedir los tokens y se descarta

El del QR compara contra los vectores de la norma: la corrección Reed-Solomon
reproduce el ejemplo de la ISO 18004 y las quince cadenas de información de
formato coinciden con la tabla publicada.

---

## Pendiente

- [ ] **El usuario de Supabase Auth.** Sin él el SO no lee el buzón de verdad:
      todo se probó contra un buzón simulado. `nube.conectar()` está listo
- [ ] **El WhatsApp de la cocina** en `catalogo/config.js`. Sin él la página no
      muestra ningún botón de contacto, incluido el del camino de error
- [ ] **El deploy.** El conector de Vercel no tiene permiso para crear
      proyectos y `gh` no está instalado. La vía buena es conectar el repo por
      git: resuelve los binarios de `assets/` y deja deploy automático
- [ ] **Escanear el QR impreso una vez** antes de mandarlo a hacer en cantidad.
      Es lo único que no se puede verificar por código
- [ ] Foto por producto en el catálogo — el campo `foto_url` está, falta subirlas
- [ ] Badge de pedidos nuevos en la nav, no solo dentro de la pantalla
