# Brief — Canal de venta online

Dos tareas separadas para Claude Code. **Hacer la A completa antes de empezar la B.**

- **A** — el link público que se comparte a los clientes
- **B** — el panel de pedidos pendientes dentro del SO

---

## Contexto: por qué hay backend acá

El SO es local-first: IndexedDB en el navegador de cada dispositivo. Un cliente que
abre el catálogo desde su celular no tiene forma de escribir en esa base.

Para que el pedido llegue solo al SO hace falta un lugar compartido. **No se migra
todo a Supabase**: se crean dos tablas que funcionan como buzón.

```
Cliente → catalogo (público)  →  Supabase  →  SO lo importa a su pedido local
                                  · catalogo_item   qué se publica
                                  · pedido_web      buzón de entrada
```

Todo lo demás — producción, stock, jornadas, caja — sigue local y sin tocar. Esto
adelanta parte de la Fase 5, no la reemplaza.

### Decisiones ya tomadas

- **Formas de entrega:** solo retiro en el CIC o envío a domicilio
- **Costo de envío:** por ahora sin cargo. Se deja el campo `costo_envio` en cero,
  preparado, para no migrar después
- **Uncas:** queda como canal de mostrador, se consume en el acto
- **El pedido web nunca entra directo al SO.** Llega al buzón y alguien lo revisa
  antes de convertirlo en pedido. Un formulario público es una puerta abierta:
  bromas, pruebas y errores de tipeo no pueden ensuciar el stock ni la caja

---

# TAREA A — El link de venta online

```
Leé CLAUDE.md y docs/PDR.md antes de empezar.

Vamos a crear un catálogo público, separado del SO, que recibe pedidos.

## 1. Proyecto Supabase

Creá el proyecto y estas dos tablas.

### catalogo_item — lo que se publica
  id            uuid pk default gen_random_uuid()
  producto_id   uuid          -- id del producto en el SO, para poder mapear al importar
  nombre        text not null
  descripcion   text
  categoria     text
  precio        numeric not null
  unidad_venta  text          -- unidad | docena | kg | combo
  foto_url      text
  orden         int default 0
  activo        bool default true
  updated_at    timestamptz default now()

### pedido_web — buzón de entrada
  id             uuid pk default gen_random_uuid()
  creado_at      timestamptz default now()
  nombre         text not null
  telefono       text not null
  modo_entrega   text not null check (modo_entrega in ('retira_cic','domicilio'))
  direccion      text                    -- obligatoria si modo_entrega = domicilio
  fecha_deseada  date
  notas          text
  items          jsonb not null          -- [{catalogo_item_id, nombre, cantidad, precio}]
  total          numeric not null
  estado         text default 'nuevo' check (estado in ('nuevo','importado','descartado'))
  pedido_id      uuid                    -- id del pedido del SO una vez importado
  procesado_at   timestamptz

### RLS — esto es lo que hay que hacer bien

  catalogo_item
    anon    SELECT donde activo = true. Nada más
    authenticated  ALL

  pedido_web
    anon    INSERT solamente. NUNCA select
            (si anon pudiera leer, cualquiera con el link ve los pedidos, los
             teléfonos y las direcciones de todos los clientes)
    authenticated  SELECT + UPDATE

Creá un usuario de Supabase Auth para el SO (email + password, uno solo). Con ese
usuario el SO lee el buzón. La anon key va en el catálogo público, que solo puede
insertar.

Validá con checks en la base, no solo en el formulario:
  - total >= 0
  - jsonb_array_length(items) between 1 and 50
  - length(nombre) between 2 and 80
  - direccion not null cuando modo_entrega = 'domicilio'

## 2. La página: catalogo/index.html

Archivo aparte del SO. No importa nada de js/ ni de css/ del SO: es una página
pública que carga rápido en un celular con mala señal.

Sí respeta la identidad de Manos Libres, la misma de CLAUDE.md:
fondo #0e0e10, superficies #16161a, acento naranja #f55b1e para el pedido,
Fredoka One en títulos, Nunito 700/800 en cuerpo, JetBrains Mono en los precios.
Mobile-first a 390px.

Estructura:

  1. Encabezado con el logo (assets/logo-mark.png) y una línea de qué es
     Manos Libres. Es una cocina comunitaria de Mirmidones que emplea a mujeres
     en situación de vulnerabilidad: eso vende, ponelo arriba y sin golpes bajos

  2. Productos agrupados por categoría, traídos de catalogo_item.
     Tarjeta: foto si hay, nombre, descripción corta, precio.
     Botón + / − para la cantidad. Mismo patrón que la venta rápida del SO

  3. Barra inferior fija con el total en vivo y "Hacer el pedido"

  4. Formulario, en una hoja que sube desde abajo:
       - Nombre           obligatorio
       - WhatsApp         obligatorio, validá 10 dígitos sin 0 ni 15
       - Cómo lo recibís  dos botones grandes: "Retiro en el CIC" | "Envío a domicilio"
       - Dirección        aparece solo si eligió domicilio, obligatoria ahí
       - Para cuándo      fecha, opcional
       - Comentario       opcional

  5. Al enviar: inserta en pedido_web y muestra una pantalla de confirmación con
     el resumen y un botón "Escribirnos por WhatsApp" que abre wa.me con un
     mensaje ya redactado con el número de pedido.

     Esto último importa: el pedido queda registrado igual, pero el cliente
     termina en una conversación. En este rubro la venta se cierra hablando, no
     con un "gracias por su compra".

## 3. Si Supabase no responde

Sin conexión o con el insert fallado, el botón cambia a "Pedir por WhatsApp" y
abre wa.me con el pedido completo en el mensaje. El cliente nunca ve un error
sin salida.

## 4. Anti-basura

Es un formulario público sin captcha:
  - Campo honeypot oculto: si viene lleno, se descarta en silencio
  - Un pedido por dispositivo cada 60 segundos (localStorage)
  - Los checks de la base son la última línea, no la primera

## 5. Deploy

Vercel, junto al SO pero en su propia ruta: el SO en la raíz y el catálogo en
/catalogo. La anon key de Supabase va en el cliente — es pública por diseño, la
seguridad la da RLS, no esconderla.

## 6. Herramienta para el SO

En el módulo de pedidos, una pantalla "Catálogo online" con:
  - Qué productos están publicados, con toggle para publicar y despublicar
  - Botón para sincronizar precios del SO hacia catalogo_item
  - El link, con botón de copiar y otro de compartir por WhatsApp
  - Un QR del link, para imprimir y pegar en el CIC

Publicar un producto copia nombre, precio, categoría y unidad desde el producto
del SO, y guarda producto_id para poder mapear al importar.
```

---

# TAREA B — Panel de pedidos pendientes

**No empezar hasta que A esté andando y probada con un pedido real.**

```
Leé CLAUDE.md, docs/PDR.md §4.2 y js/modules/pedidos.js.

La pestaña Pedidos hoy es solo venta rápida. Un SO necesita saber qué está
pendiente de entregar, no solo qué se cobró. La reorganizamos.

## 1. Cambios en el modelo

En la tabla pedido, agregar:

  modo_entrega   'en_el_acto' | 'retira_cic' | 'domicilio'
  direccion_entrega  text     -- solo si domicilio
  costo_envio    decimal default 0   -- preparado, hoy siempre 0
  origen_web_id  uuid          -- id del pedido_web del que vino, si vino de ahí

Y limpiar canal, que hoy mezcla dos cosas distintas:

  canal        por dónde ENTRÓ:  'whatsapp' | 'instagram' | 'catalogo_web'
                                 | 'mostrador_cic' | 'mostrador_uncas' | 'otro'
  modo_entrega cómo LLEGA al cliente

Migrá los datos existentes: canal 'cic_presencial' y 'club_uncas' pasan a
'mostrador_cic' y 'mostrador_uncas', con modo_entrega 'en_el_acto'.
Subí DB_VERSION y escribí la migración en el onupgradeneeded de db.js.

El costo de envío NO es venta de producto. Cuando se empiece a cobrar, tiene que
sumar al total del pedido pero quedar afuera del cálculo de margen del producto,
o la rentabilidad por producto queda mal. Dejalo separado desde ahora aunque
valga cero.

## 2. Subnavegación de la pestaña

Igual que Producción, con subvistas:

  Pendientes · Agenda · Venta rápida

Venta rápida se mueve adentro y no se toca su lógica. registrarVenta() queda
como está: ya descuenta stock y genera el movimiento de caja.

## 3. Pendientes — la pantalla principal

Pedidos que no están entregados ni cancelados, agrupados por estado:

  Nuevos del catálogo   los del buzón sin importar. Arriba de todo y contados
                        en un badge
  Confirmados           aceptados, esperando producción
  En producción         están en una orden
  Listos               esperando que los retiren o salgan a repartir

Cada tarjeta: cliente, teléfono, qué pidió, total, cuándo, y modo de entrega
bien visible — retiro y domicilio son dos trabajos distintos.

Alerta en rojo si fecha_entrega es hoy y el estado no es 'listo'.

## 4. Importar del buzón

Botón "Revisar pedidos nuevos" que trae de pedido_web los que están en 'nuevo'.

Para cada uno, una pantalla de revisión:
  - Qué pidió y a cuánto, con el total recalculado contra los precios ACTUALES
    del SO. Si el precio cambió desde que se publicó el catálogo, mostrá las dos
    cifras y que decida la administración
  - Cliente: si el teléfono ya existe, lo vincula; si no, ofrece crearlo
  - Cada ítem se mapea por producto_id. Si alguno no matchea, se elige a mano
  - Stock disponible de cada producto, para saber si hay que producir
  - Dos botones: "Aceptar pedido" y "Descartar"

Aceptar crea el pedido en el SO con estado 'confirmado', canal 'catalogo_web',
guarda origen_web_id, y marca el pedido_web como 'importado' con su pedido_id.
Descartar solo lo marca como 'descartado' con motivo. Nunca se borra del buzón.

IMPORTANTE — el stock se descuenta al ENTREGAR, no al aceptar. Un pedido para el
viernes no puede bajar el stock del lunes: la venta rápida del martes creería que
no hay mercadería. Mirá cómo lo hace registrarVenta() y no lo copies tal cual:
esa función es para venta en el acto, donde entregar y cobrar pasan juntos.

## 5. Carga manual

El mismo formulario, con el botón + de la pantalla. Para lo que llega por
teléfono o por chat. Mismo modelo, distinto canal.

## 6. Entregar

Desde la tarjeta: marcar entregado → descuenta stock y deja movimiento_stock →
registra el cobro → genera el ingreso en caja. Es la cadena de registrarVenta()
pero disparada al entregar.

Si no hay stock suficiente, avisá pero dejá entregar: la comida está ahí, el
stock en negativo es la señal de que falta cargar producción. Mismo criterio que
la venta rápida, está explicado en docs/VENTA-RAPIDA.md.

## 7. Agenda

Vista por día de fecha_entrega, la semana a la vista. Separada en dos bloques
porque son dos trabajos:
  - Retiran en el CIC: lista de bolsas con nombre
  - Domicilio: recorrido con direcciones

## 8. Permisos

Ya existen cargarPedidos y anularPedidos en auth.js. Una trabajadora carga,
entrega y cobra. Importar del buzón y descartar es de administración: agregá
gestionarCanalWeb.

Aplicá auth.exigir() en las funciones, no solo escondiendo botones. Está
explicado en docs/FASE-1.md, sección del addendum.

## 9. Tests

test/canal-web.test.mjs. Los casos que importan son los que verifican que NO
pase algo:
  - Importar dos veces el mismo pedido_web no crea dos pedidos
  - Un pedido_web descartado no se puede importar después
  - Aceptar un pedido NO mueve stock ni caja
  - Entregarlo sí mueve las dos cosas, y una sola vez
  - Una trabajadora no puede importar ni descartar del buzón
  - Un pedido con precio viejo se importa con el precio que confirmó la
    administración, y ese precio queda congelado en pedido_item
```

---

## Orden y criterio

1. **A completa**, con un pedido de prueba entrando al buzón desde el celular
2. Recién ahí **B**

Si B se hace primero, se termina construyendo un panel contra datos imaginados.

## Lo que no hay que perder de vista

El catálogo lo va a abrir gente en el celular, con mala señal, quizás desde un
link reenviado en un grupo. Si tarda o pide demasiados datos, cierran la pestaña.

Y del otro lado: cada pedido del buzón es trabajo para alguien que ya está
cocinando. Revisarlo tiene que ser leer y tocar un botón, no llenar un formulario
de nuevo.
