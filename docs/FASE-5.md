# Fase 5 — Nube · cerrada

El esquema del SO vive en Postgres con RLS, los costos los pone el servidor y
ya no se leen desde la cocina, cada persona tiene su usuario, hay un
replicador que empuja y trae y ya está enganchado en la interfaz, y el SO vive
en `https://manos-libres-app.vercel.app`. **`db.js` sigue siendo IndexedDB** y
eso ahora es una decisión y no una etapa: ver §4.2.

El orden fue a propósito: primero se dejó al servidor capaz de sostener las
reglas solo, después se lo conectó. Al revés, el día que la app empezara a leer
de la nube ya sería tarde para descubrir que el servidor no garantizaba nada.

---

## Los dos proyectos de Supabase

| Proyecto | Región | Qué tiene |
|---|---|---|
| `manos-libres-canal-web` (`xkvkzuivyqunduavejla`) | `sa-east-1` | el bueno: canal web + las 18 tablas del SO |
| `escue9's Project` (`dcgbqhedpgutpsagmasy`) | `us-west-2` | sobra de un intento anterior |

El primero es al que apunta `catalogo/config.js`. El esquema del SO se creó
ahí adentro y no en un proyecto aparte, y eso compra dos cosas:
`pedido.origen_web_id` es una FK real contra `pedido_web` en vez de un uuid
suelto, y una sola sesión de Supabase cubre todo.

El segundo no lo usa nadie y ocupa uno de los dos slots del plan free. La
organización está en **free**, así que el branching de Supabase —que sería la
forma cómoda de probar una migración— pide Pro y no está disponible. Por eso
todo lo que se probó contra la base se probó adentro de una transacción con
`rollback`.

---

## Qué se construyó

### §1 — Las 18 tablas · `20260803_esquema_so.sql`

Traducción mecánica del modelo de `docs/PDR.md` §3, que se diseñó relacional
justamente para que esta migración no tuviera que decidir nada. Las 18 tablas,
sus índices —los mismos filtros que ya usa el cliente— y un trigger de
`updated_at` en cada una, porque el sync se apoya en esa columna para resolver
conflictos.

Las reglas que se podían escribir como constraint quedaron escritas como
constraint, no como una validación de JavaScript que el servidor cree de
palabra:

- un pedido a domicilio sin dirección no entra
- un ajuste de stock sin motivo tampoco (regla 7)
- `categoria_gasto` solo existe si el movimiento es un gasto operativo
- una jornada por día por persona, con `unique (trabajadora_id, fecha)`: sin
  eso, dos taps desde dos dispositivos pagan el mismo día dos veces
- un `pedido_web` se importa una sola vez, con un índice único parcial sobre
  `origen_web_id`

### §2 — RLS espejando `js/auth.js`

`anon` no toca nada del SO: `revoke all` en las 18 tablas. Lo único público
sigue siendo el catálogo.

Sobre `authenticated`, las políticas repiten la tabla `PERMISOS` de
`js/auth.js`. Tres funciones deciden quién es quien: `rol_actual()`,
`es_admin()` y `ve_numeros()` —admin y comisión—. De ahí salen cuatro grupos:

- **lectura del equipo** — producción y ventas son el trabajo diario de la
  cocina y las lee cualquiera que esté autenticado
- **la cocina opera** — escribir productos, órdenes, pedidos, cobros y stock es
  de admin y trabajadora. La comisión mira, no opera
- **solo administración escribe** — recetas, compras, unidades de negocio y
  config. Una receta define el costo
- **la parte delicada de la regla 8** — la caja es de quien ve números; una
  trabajadora se ve a sí misma y ve sus jornadas y su tarifa, ninguna otra.
  Puede autorreportarse un día, pero entra sin confirmar, sin tarifa y con el
  pago pendiente, y puede deshacerlo mientras siga así. Confirmar y pagar es de
  administración

### §3 — El costo lo pone el servidor · `20260804_costos_servidor.sql`

Esta era la nota `PENDIENTE` que había quedado abierta arriba, y merece
contarse como el problema que era.

La regla 8 dice que una trabajadora no ve costos. RLS filtra **filas, no
columnas**, así que `insumo.costo_unitario`, `producto.costo_calculado` y
`pedido_item.costo_unitario` quedaban legibles para todo el mundo: viven en
tablas que la cocina necesita leer para trabajar. El arreglo evidente —vistas
sin las columnas de costo— chocaba de frente con algo: la venta rápida que
corre la trabajadora escribe `pedido_item.costo_unitario` como snapshot, y
**quien no puede leer un costo no lo puede calcular**.

Las salidas eran dos: que el snapshot lo llene el servidor, o que la venta
rápida deje de andar sin conexión. La segunda contradice la regla 3 —la cocina
del CIC se queda sin señal y se vende igual—, así que se tomó la primera.

Lo que entró:

1. el costeo de `js/calc.js` traducido a SQL: unidades con su familia y su base,
   costo de receta con merma, y el costo efectivo con la misma semántica del
   `||` del cliente (un costo calculado en 0 es una receta rota, no un producto
   gratis)
2. tres triggers que llenan lo que hoy calcula el cliente: el costo del pedido
   al vender, el snapshot de producción al registrar cantidad real, y
   `costo_insumos` + `costo_mano_obra` al cerrar la orden
3. esos snapshots quedan congelados (regla 4)

---

## Decisiones

### Los enum van como check constraints

Agregar un valor a un check es un `ALTER` de un segundo. Agregarlo a un tipo
enum es una migración con downtime. El modelo tiene una docena larga de campos
así —canales, estados, medios de pago— y todos van a crecer.

### El rol viaja en `app_metadata`, no en `user_metadata`

Es la diferencia entre un permiso y una sugerencia: `user_metadata` lo edita el
propio usuario, y ahí cualquiera se hace admin con una línea en la consola.
`app_metadata` lo pone la administración al dar de alta al usuario y el cliente
no lo puede tocar.

El default de `rol_actual()` es `trabajadora`, así que una request sin rol en el
token cae siempre del lado seguro.

### Un costo que no se sabe devuelve `null`, no un error

`calc.js` tira error cuando una conversión de unidades es imposible. Del lado
del navegador eso corta una pantalla; del lado del servidor cortaría un sync, y
un sync trabado no se destraba solo. Acá viaja un `null` hacia arriba, que
significa "no sé cuánto cuesta", y cada quien decide qué hacer con eso.

Por lo mismo, un insumo sin costo cargado hace que `costo_receta_producto()`
devuelva `null` —no vale cero, vale "todavía no sabemos"— pero entra como 0 en
el costo de cierre de la orden. Cuando ese trigger corre, la orden ya se cerró
en la cocina y está llegando por sync: plantarse dejaría el sync trabado para
siempre por una compra que falta cargar.

### La mano de obra tenía el mismo agujero y no estaba visto

Una trabajadora puede cerrar una orden, pero solo ve sus propias jornadas. Su
cliente suma bien lo que ve y manda un número que es correcto para ella y falso
para la orden. Por eso `costo_mano_obra` se recalcula **siempre** que cierre
alguien que no ve la caja, y no solo cuando viene vacío. Es el costo con otra
cara.

### Un 0 se ignora en silencio; un cambio deliberado corta

Los dos casos parecen el mismo `update` y no lo son. Un cliente que no lee
costos reenvía la fila con 0 cada vez que sincroniza: eso es eco, no una
decisión de nadie, y se descarta sin ruido. Un número distinto mandado por
alguien que sí ve costos es otra cosa, y ahí el trigger levanta excepción: el
margen histórico no se reescribe (regla 4).

`puede_fijar_costos()` acepta además la sesión que **no viene de la API** —el
editor SQL, una migración, un backfill—, que no tiene claims de JWT. Sin esa
segunda mitad, arreglar un histórico a mano sería imposible: el trigger lo
revertiría en silencio.

### Desfase conocido y aceptado

Un pedido cargado sin señal y sincronizado tres días después congela el costo
del día en que **llegó**, no el del día en que se vendió. Es la contra de la
decisión y no tiene arreglo mientras el que vende no pueda leer costos.

Se prefiere eso antes que dejar el snapshot en 0, que sería un margen del 100%
en el histórico. El desfase está acotado por cuánto tarda el celular en volver a
tener señal, y solo aplica a quien no ve costos: lo que carga la administración
viaja con el costo del momento.

### Las funciones de costeo no son API

Son `security definer` porque leen columnas que quien las dispara no tiene por
qué poder leer —es todo el punto del archivo—, así que se les revoca el
`execute`. Si quedaran públicas, una trabajadora las llamaría por RPC y tendría
el costo de cada producto de a un id por vez, que es exactamente lo que se está
tapando. Los triggers no necesitan el grant: corren con el permiso de su dueño.

---

## Lo que verifiqué contra el Postgres real

No contra un mock. Primero simulando el JWT de cada rol, después la vuelta
completa entrando como `authenticated` con RLS activo, siempre dentro de una
transacción con `rollback`.

| Prueba | Resultado |
|---|---|
| Una trabajadora lee productos e insumos y descuenta stock | anda — es su trabajo |
| Una trabajadora contra la caja, las jornadas ajenas o las tarifas ajenas | no ve nada |
| Una trabajadora cargando un movimiento de caja o escribiendo una receta | rechazado |
| Una trabajadora confirmando o pagando una jornada | rechazado |
| Venta desde un cliente sin costos: `costo_unitario` en 0 | lo llenó el servidor |
| Reenvío de la misma línea con 0 | ignorado, el snapshot no se movió |
| Cierre de orden con 36 planificadas y rinde 24 | 1,5 lotes · **1800** |
| Una trabajadora leyendo `insumo.costo_unitario` | **1200 — lo lee** |

El caso del cierre valió el viaje: los dos campos son `integer` y sin el cast a
`numeric` la división entera de Postgres truncaba 36/24 a 1 lote, devolviendo
1200 en vez de 1800. Un test contra números redondos no lo habría mostrado.

La última fila es el agujero que queda abierto, y está **medido, no supuesto**:
hoy una trabajadora lee el costo del insumo derecho de la columna. La interfaz
los esconde; el servidor todavía no.

El linter de Supabase encontró que las tres funciones de trigger quedaban
publicadas en `/rest/v1/rpc`. No era explotable —una función de trigger llamada
suelta muere con "can only be called as triggers"— pero se revocó el `execute`
igual, para sacar la advertencia y dejar dicho que no son un endpoint. Postgres
chequea ese permiso al **crear** el trigger y no cada vez que dispara, así que
revocarlo no los apaga; está probado.

---

### §4.1 — La identidad · `20260805_identidad.sql`

El login era un PIN de cuatro dígitos hasheado con salt contra IndexedDB, y no
había ningún usuario de Supabase en ninguna parte. Todo el RLS de arriba cuelga
de `trabajadora.auth_user_id` → `auth.users` y del rol en `app_metadata`. Un
replicador que arrancara así caía en `anon`, y `anon` no toca nada del SO: no es
que vea de menos, es que no ve nada.

**Decisión:** cada trabajadora usa su propio celular —no hay un aparato
compartido en el CIC—, así que el PIN sigue siendo la puerta visible. Es lo que
hace que la app se use: entran apuradas y con las manos ocupadas, y cuatro taps
es lo que tolera ese momento. Detrás, cada una tiene su usuario propio de
Supabase, creado por administración, con la sesión guardada en su dispositivo.
El PIN pasa a **desbloquear esa sesión**, no a ser la credencial.

`trabajadora` suma `email` —la llave para aparear con `auth.users`, no para
mandar mails— y `rol`. La tabla dejó de ser "las que cocinan" para ser "las que
entran": la comisión es una fila más. El nombre le queda grande, pero
renombrarla arrastra las 18 tablas, los módulos y el backup de quien ya lo esté
usando.

El apareo va por los dos lados, porque administración puede cargar primero el
equipo o primero las cuentas. El trigger sobre `auth.users` va `after` y no
`before`: en un `before` la fila del usuario todavía no existe y el FK de
`auth_user_id` la rechaza. Dar de baja no borra el usuario, le deja el rol en
`inactiva`, que no existe en ninguna política.

Del lado del cliente, `sesion.js` se lleva la sesión que era la primera mitad de
`nube.js` —dejó de ser "la cuenta con la que el SO publica el catálogo" para ser
la de la persona que usa el aparato— y `auth.ingresar()` verifica que la sesión
guardada sea de quien tipeó el PIN. Sin eso, un PIN correcto en el celular de
otra escribe todo firmado por la dueña del aparato. La comparación es contra lo
último que dijo el servidor, cacheado: tiene que andar sin señal.

**La contra, dicha:** la sesión vive en el teléfono, así que quien tenga ese
teléfono tiene por delante nada más que el PIN; y dar de alta a alguien nueva
deja de ser escribir cuatro dígitos.

### §4.2 — El replicador · `js/sync.js`

`CLAUDE.md` decía que en esta fase "se cambia la implementación interna de
`db.js` por el cliente de Supabase". Escrito así no se puede: la regla 3 dice
que la app abre y funciona sin internet **siempre**, y un `db.js` que sea un
cliente REST no abre en la cocina del CIC un día de lluvia. Las dos reglas no
pueden ser ciertas a la vez.

Gana la 3, que es la que decide si la app se usa o no. IndexedDB sigue siendo la
fuente de verdad del dispositivo y Postgres es el espejo —que es, además, lo que
ya decía la cabecera de la migración del esquema—. Así que no es un motor nuevo
adentro de `db.js`: es un replicador al lado. La regla 1 se cumple igual y
mejor: los módulos nunca se enteran de que existe un servidor.

Cada escritura ya quedaba con `sync_status: 'local'` desde la Fase 0. Empujar es
mandar eso; traer es pedir lo que cambió. Gana el `updated_at` más nuevo. Lo que
hubo que agregar:

- **lápidas** (IndexedDB v4, store `borrado`). Sin ellas, una fila borrada sin
  señal es indistinguible de una que nunca existió acá, y el pedido anulado el
  martes reaparecía el miércoles traído por el pull.
- marcar una fila como sincronizada **no puede tocar `updated_at`**. Si lo
  tocara, cada push haría parecer modificada la fila recién subida y el sync no
  terminaría nunca.
- **orden de subida explícito**, que no es el de `TABLES`: ahí `trabajadora` cae
  después de `pedido`, y `pedido.created_by` la referencia.
- **`config` no sincroniza**, y no es un olvido: ahí viven el hash del PIN de
  administración, el salt y el refresh token del dispositivo.
- se **empuja primero y se trae después**. Al revés, lo que baja pisaría por
  `updated_at` lo que todavía no subió, y la venta cargada sin señal
  desaparecería sin que nadie se entere.
- el marcador del pull se guarda con el `updated_at` que vino en las filas y no
  con `Date.now()`: los relojes de los celulares no están en hora.

**Lo que este diseño no resuelve:** un borrado hecho en otro dispositivo no se
entera acá, porque el pull pregunta "qué cambió" y una fila borrada no cambió,
no está. Para eso está `traerTodo()`. La salida completa es borrado lógico en
las 18 tablas, y eso ensucia cada consulta del sistema para resolver un caso que
pasa una vez por mes.

### §4.3 — Los costos dejan de estar a la vista · `20260806_costos_ocultos.sql`

Con los snapshots resueltos en §3, esconder los costos ya no rompe la venta
rápida ni el cierre de orden. Acá se cierra el agujero que estaba medido: una
trabajadora leyendo `insumo.costo_unitario` = 1200 derecho de la columna.

Vistas `_v` y no solo un `revoke`: en Supabase todos entran con el mismo rol de
Postgres —`authenticated`— y los permisos de columna no leen claims del JWT, así
que revocar la columna se la saca también a la administración. La vista devuelve
la fila completa con el costo en `null` si quien pregunta no puede verlo, y el
replicador lee por ahí sin necesitar saber qué rol tiene.

Dos cosas que no eran obvias:

- hay que **guardar las columnas antes de esconderlas**. El dispositivo de una
  trabajadora baja el insumo con el costo en `null` y, al contar stock, devuelve
  la fila entera con ese `null` adentro. Sin la guarda, contar la harina le
  borraba el costo a toda la cocina. Es la regla del §3 otra vez: un dato que el
  que escribe no puede ver, no lo puede pisar.
- **`revoke select (columna)` no alcanza** si sigue en pie el `grant select` de
  la tabla entera. Se aplica sin error, queda prolijo en la migración, y la
  columna se sigue leyendo igual. Hay que sacar el permiso de tabla y devolverlo
  enumerando columnas — lo cual significa que una columna nueva en esas cinco
  tablas hay que agregarla también acá y en su vista, o nace invisible.

De paso, dos políticas del canal web que venían de cuando `authenticated`
significaba "el SO": publicar precios al público y procesar el buzón dejaban
entrar a cualquiera con sesión. Ahora exigen `es_admin()`, que es lo que
`PERMISOS` decía desde la Fase 2 pero lo decía solo la interfaz.

El linter marca las cinco vistas como ERROR por ser `security definer`. Se deja
a sabiendas: esa propiedad es la que hace funcionar el diseño. La condición que
lo sostiene —que la lectura de esas tablas siga abierta para todo el equipo—
queda escrita en la migración, porque el día que alguna se restrinja por fila la
restricción hay que repetirla adentro de la vista.

### §4.4 — El enganche en la interfaz

El replicador de §4.2 y las políticas de §4.1 quedaron probados contra
Postgres, pero hasta acá no los llamaba nadie: no había pantalla para que
administración cargue el `email` y el `rol` de cada persona, y `sync.js` no lo
disparaba ni un botón.

**La identidad, del lado de la app.** `guardarTrabajadora()` acepta `email` y
`rol`, y valida los tres casos que importan: forma de mail, que no se repita
entre dos personas —case-insensitive, igual que el índice de Postgres— y que
el rol sea uno de los tres. Repetir ese chequeo en el cliente no es
redundante: el servidor lo rechazaría igual, pero recién cuando corra el
sync, horas después y lejos de quien se equivocó.

Dos cosas que no eran obvias:

- `undefined` es "no lo toques" y `''` es "borralo". Con default `''`,
  cualquier llamada que no conociera el campo le borraba el mail a la persona
  de refilón al guardar otra cosa, y la dejaba sin usuario del otro lado.
- el mail se normaliza a minúscula al guardar y no solo al comparar. El
  índice de Postgres es sobre `lower(email)`; guardarlo como lo tipearon deja
  dos verdades del mismo mail según de qué lado se mire.

De paso apareció una fuga de la regla 8: `state.recortarTrabajadora()` no
sacaba `email` ni `rol`, así que quedaban en `state.trabajadoras` para
cualquier rol. La pantalla los esconde detrás de `esAdmin()`, pero esconder al
renderizar no alcanza —es el mismo argumento que esa función ya usa para la
tarifa—: desde la consola una trabajadora veía el mail y el rol de sus
compañeras.

**El replicador, enganchado.** Sincroniza al abrir, al volver la señal y a
mano desde el menú. Las dos primeras son calladas, y es lo importante del
enganche: en la cocina del CIC estar sin internet es lo normal, no un error
que haya que gritarle a nadie. La app abre igual y al instante (regla 3) y el
fallo va a `console.warn`. La tercera sí habla, porque ahí lo pidieron a
propósito: el error va escrito en el modal y no en un toast, que un "Supabase
respondió 401" no se lee en dos segundos y medio.

Decisiones del enganche que tampoco eran obvias:

- el indicador se apaga si el dispositivo no tiene sesión. Sin sesión TODO
  está pendiente para siempre, y un número que nunca baja no informa, molesta.
  La explicación va al menú, que es donde se puede hacer algo.
- la vuelta callada solo re-renderiza si algo bajó. Refrescar la pantalla
  debajo de las manos de alguien que está cargando un pedido, para no mostrar
  nada nuevo, es peor que esperar.
- un flag global contra los tres disparadores: dos push simultáneos se pisan
  la cola.
- `sesion.js` nunca había entrado al `SHELL` del service worker —ya faltaba
  antes de esto—, y ahora `app.js` lo importa. Sin eso el primer arranque en
  modo avión se quedaba sin el módulo de sesión.

De paso, el aviso del backup decía "hasta que el sistema esté en la nube, es
la única copia que existe". Ya no es cierto, pero el backup sigue haciendo
falta por otro motivo y ahora lo dice: la nube es un espejo, no un respaldo.

---

## El deploy en Vercel

**https://manos-libres-app.vercel.app** sirve el SO en la raíz y el
catálogo público en `/catalogo/` — la misma URL que espera `nube.enlacePublico()`.

Ese nombre de proyecto ya existía en la cuenta, pero apuntaba a un prototipo
React/Vite abandonado de antes del pivot a vanilla (regla 2). Se reusó a
propósito en vez de crear uno nuevo: el historial de deploys viejo queda
disponible para rollback si hiciera falta, pero nadie lo necesitaba.

El proyecto en el dashboard de Vercel seguía configurado con el preset de
Vite, y este repo no tiene build. `vercel.json` en la raíz fuerza
`framework: null` con `buildCommand`/`installCommand` en `null`: sin eso el
deploy intenta correr `vite build` contra un `package.json` que no tiene ni
Vite ni un script `build`, y se rompe.

Sube el repo entero salvo lo que ignora `.gitignore` (`node_modules/`,
`backups/`) — `docs/`, `supabase/` y `test/` viajan también, sin costo real
en un sitio de este tamaño y sin nada sensible adentro (la anon key de
`catalogo/config.js` es pública por diseño, ver ese archivo).

Esto destraba lo que quedó colgado de las fases anteriores: la instalación
como PWA y el arranque con modo avión ahora se pueden verificar con HTTPS
real, y el catálogo público tiene dónde vivir para generar el QR. Esa
verificación —instalar y probar en modo avión desde un celular— sigue
pendiente y son los checkboxes abiertos en `docs/FASE-0.md` y
`docs/BRIEF-CODE.md`.
