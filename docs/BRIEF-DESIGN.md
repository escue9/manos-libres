# Brief para Claude Design — Cocina CIC

Tres pantallas, una por vez. Pegá el **bloque base** + **una sola pantalla** en cada conversación de Claude Design. Si le pedís las tres juntas, sale todo mediocre.

Orden sugerido: Venta rápida → Cierre semanal → Registro de jornadas.

---

# BLOQUE BASE — pegar siempre primero

````
Necesito que diseñes una pantalla de una PWA de gestión para una cocina comunitaria
en Tandil, Argentina. Es un proyecto social: emplea a mujeres en situación de
vulnerabilidad.

## Restricciones técnicas — no negociables

- HTML + CSS vanilla. NADA de React, NADA de Tailwind, NADA de librerías externas.
- Un solo archivo .html con el CSS en un <style> y datos mockeados hardcodeados en JS.
- El resultado se copia a un proyecto vanilla existente, así que el CSS tiene que
  usar las variables que te paso abajo, no colores hardcodeados.
- Mobile-first real: diseñá para 390px de ancho. El desktop es secundario.
- Las usuarias cargan desde el celular, apuradas, con las manos ocupadas y a veces
  sucias. Botones grandes (mínimo 48px de alto), mínimo de taps, cero scroll
  horizontal, todo alcanzable con una sola mano.

## Sistema de diseño — usalo tal cual

```css
:root {
  --bg:          #0e0e10;
  --surface:     #16161a;
  --surface-2:   #1e1e24;
  --border:      #2a2a32;

  --text:        #f2f2f5;
  --text-dim:    #9a9aa8;
  --text-faint:  #6a6a78;

  --produccion:  #e8185a;   /* rosa */
  --pedidos:     #f55b1e;   /* naranja */
  --clientes:    #f5b800;   /* amarillo */
  --equipo:      #1ec84a;   /* verde */
  --caja:        #3db8f5;   /* azul */

  --ok: #1ec84a;  --warn: #f5b800;  --danger: #e8185a;

  --r-sm: 10px;  --r-md: 14px;  --r-lg: 20px;
  --tap: 48px;
}
```

**Tipografías** (Google Fonts, importalas):
- Títulos: `Fredoka One` — redonda, amigable, con carácter
- Cuerpo: `Nunito` 700/800 — nunca menos de 700, la marca es de peso alto
- Números: `JetBrains Mono` con `font-variant-numeric: tabular-nums` — TODA cifra
  de plata va en mono para que las columnas alineen solas

**Tono visual:** dark mode nativo, fondo casi negro, superficies apenas más claras,
bordes sutiles. El color aparece en acentos, no en fondos grandes. La identidad
viene del logo de la marca: manos de colores sobre fondo negro. Cálido y con
energía, no corporativo ni frío. Es un emprendimiento de barrio, no un banco.

**Formato de plata:** pesos argentinos sin decimales — `$ 192.500` (punto como
separador de miles).

## Qué espero de vuelta

El archivo .html completo y funcional con los datos mockeados que te paso.
Los taps y toggles tienen que responder de verdad (JS vanilla mínimo), no ser
una maqueta muerta.
````

---

# PANTALLA 1 — Venta rápida

**Color del módulo:** naranja `--pedidos`
**Quién la usa:** las trabajadoras, en el mostrador del CIC y en la cancha del Club Uncas
**Por qué importa:** es la pantalla más usada del sistema. Si tiene fricción, no la usan y vuelven al cuaderno.

````
## Pantalla: Venta rápida

Venta de mostrador, sin datos de cliente. La trabajadora tapea productos, ve el
total en vivo y cobra. Objetivo: cerrar una venta en menos de 5 segundos.

### Estructura

1. Header compacto: "Venta rápida" + total de ventas del día en chico
2. Grilla de productos — 2 columnas en mobile. Cada tarjeta:
   - Nombre del producto
   - Precio en JetBrains Mono
   - Al tapear: suma 1 unidad, la tarjeta se marca con borde naranja y aparece
     un badge circular con la cantidad en la esquina
   - Tap largo o un botón "−" chico: resta 1
3. Barra inferior fija (sticky, sobre la nav): cantidad de items + TOTAL grande
   en mono + botón "Cobrar" naranja de ancho completo
4. Al tocar "Cobrar": modal desde abajo (bottom sheet) con
   - El total grande
   - Tres botones de medio de pago: Efectivo / Transferencia / MercadoPago
   - Botón "Confirmar venta"
5. Estado vacío: cuando no hay nada seleccionado, la barra inferior está apagada
   y el botón Cobrar deshabilitado

### Datos mockeados

Empanadas:
- Empanada de carne — $800
- Empanada jamón y queso — $800
- Empanada de verdura — $750
- Empanada de pollo — $800

Tartas:
- Tarta de verdura — $3.500
- Tarta de carne — $4.000

Combos:
- Combo bondiola 4 porciones — $18.000
- Combo bondiola 6 porciones — $26.000

Agrupá por categoría con un subtítulo chico arriba de cada grupo.
Ventas del día ya registradas: $47.300

### Detalles que importan

- Las tarjetas tienen que ser grandes: son el 80% de la pantalla y se tapean con
  el pulgar sin mirar mucho
- El total tiene que ser lo más legible de toda la pantalla
- No pidas confirmación para sumar unidades, solo para cobrar
- Nada de costos ni márgenes: las trabajadoras no ven esa información
````

---

# PANTALLA 2 — Cierre semanal

**Color del módulo:** azul `--caja`
**Quién la usa:** solo el admin
**Por qué importa:** es la pantalla que responde "¿esto se sostiene?". También es la base de la rendición de cuentas ante financiadores.

````
## Pantalla: Cierre semanal

Resultado económico de la semana. Solo la ve el administrador.

### Estructura

1. Selector de semana arriba: "‹ Semana 21/07 – 27/07 ›"

2. HERO — la ganancia neta, enorme, centrada, en JetBrains Mono.
   El color cambia según el resultado:
   - Verde (--ok) si hay ganancia sana
   - Amarillo (--warn) si el margen neto quedó abajo del 15%
   - Rojo (--danger) si hubo pérdida
   Abajo, en chico: el % sobre ventas y la comparación con la semana anterior
   con una flecha (↑ +23% vs. semana anterior)

3. DESGLOSE en cascada — cada línea suma o resta, tipo estado de resultados.
   Que se lea de arriba hacia abajo como una historia:

   Ventas totales              $ 436.500
   – Costo de mercadería       $ 176.400
   ─────────────────────────────────────
   = Margen bruto              $ 260.100   (59,6%)
   – Costo laboral             $  60.000
   – Gastos operativos         $  26.500
   ─────────────────────────────────────
   = GANANCIA NETA             $ 173.600   (39,8%)

   Las restas en --text-dim, los subtotales en --text y con más peso.

4. Cuatro stat cards en grilla 2×2: Ventas · Costo mercadería · Costo laboral · Margen %

5. TABLA "Rentabilidad por producto" con columnas:
   Producto · Unidades · Facturación · Margen % · Cuadrante

   El cuadrante es un badge con color:
   - ⭐ Estrella (verde) — mucho volumen y buen margen, hay que empujarlo
   - 💎 Oportunidad (amarillo) — buen margen pero se vende poco, hay que promocionarlo
   - ⚠️ Revisar (naranja) — se vende mucho pero deja poco, hay que revisar precio o costo
   - ❌ Discontinuar (rojo) — poco volumen y poco margen

   En mobile esta tabla se apila como tarjetas, no scroll horizontal.

6. Dos botones al pie: "Exportar rendición de cuentas" y "Exportar impacto social"

### Datos mockeados — semana 21/07 al 27/07

Ventas totales:        $ 436.500
Costo de mercadería:   $ 176.400
Margen bruto:          $ 260.100  (59,6%)
Costo laboral:         $  60.000
Gastos operativos:     $  26.500
GANANCIA NETA:         $ 173.600  (39,8%)  → verde

Semana anterior: ventas $389.200 · ganancia neta $141.300
(o sea: +12% en ventas, +23% en ganancia)

Rentabilidad por producto:
| Producto               | Unidades | Facturación | Margen % | Cuadrante     |
|------------------------|---------:|------------:|---------:|---------------|
| Empanada de carne      |      240 |   $ 192.000 |    56,3% | Revisar       |
| Empanada jamón y queso |      120 |   $  96.000 |    60,0% | Revisar       |
| Empanada de verdura    |       90 |   $  67.500 |    62,7% | Estrella      |
| Tarta de verdura       |       14 |   $  49.000 |    65,7% | Oportunidad   |
| Tarta de carne         |        8 |   $  32.000 |    62,5% | Oportunidad   |

### Detalles que importan

- El hero es lo primero que se ve y tiene que contestar la pregunta solo, sin leer
  el resto
- La cascada tiene que ser obvia visualmente: se ve de dónde sale cada número
- La empanada de carne es la más vendida pero la de peor margen — que el diseño
  haga saltar esa tensión, es exactamente el tipo de cosa que la pantalla existe
  para mostrar
````

---

# PANTALLA 3 — Registro de jornadas

**Color del módulo:** verde `--equipo`
**Quién la usa:** el admin ve todo el equipo; cada trabajadora ve solo lo suyo
**Por qué importa:** es la más delicada. Toca la plata de las trabajadoras y la privacidad entre ellas.

````
## Pantalla: Registro de jornadas y liquidación

Marcar qué días trabajó cada persona y liquidar la semana. Se paga por día
trabajado, con tarifa fija diaria.

Diseñá DOS VISTAS de la misma pantalla, una abajo de la otra en el mismo archivo,
con un switch arriba para alternar entre ellas.

### VISTA A — Admin

1. Header: "Equipo" + selector de semana
2. Por cada trabajadora, una tarjeta con:
   - Nombre + tarifa diaria en chico
   - Fila de 7 botones cuadrados: L M M J V S D
     Apagados = gris sobre --surface-2. Encendidos = verde --equipo con el
     texto oscuro. Se togglean al tapear.
   - A la derecha o abajo: "4 días · $ 20.000" en mono
3. Tarjeta de total abajo: "Total a liquidar: $ 60.000" + botón
   "Liquidar semana" verde de ancho completo
4. Si hay jornadas autoreportadas sin confirmar, se marcan con borde punteado
   y un badge "Sin confirmar" — no cuentan para el total hasta que el admin
   las confirme

### VISTA B — Trabajadora

La misma semana pero desde el celular de Ana. Ve SOLO lo suyo:
- Su nombre, sus 7 días, su total
- Cero referencia a las otras: ni nombres, ni cantidad de gente, ni total del equipo
- No ve tarifas ajenas ni costos ni ganancias
- Puede marcar sus propios días, pero quedan con el badge "Pendiente de confirmar"
- Un texto chico abajo: "Tus días quedan pendientes hasta que Juan Martín los confirme"

### Datos mockeados — semana 21/07 al 27/07

Tarifa diaria: $5.000 para las tres.

Ana    — L M M J V trabajados (5 días) — $ 25.000
María  — L M J V trabajados   (4 días) — $ 20.000
Rocío  — M J V trabajados     (3 días) — $ 15.000, el viernes sin confirmar

Total a liquidar: $ 60.000

Para la Vista B usá a Ana.

### Detalles que importan

- Los botones de día tienen que ser cómodos de tapear con el pulgar, no chiquitos
- El toggle tiene que dar feedback inmediato y satisfactorio: es la interacción
  que más se repite
- La privacidad entre trabajadoras no es un detalle de permisos, es una decisión
  de diseño: en la Vista B no puede haber NINGÚN rastro de que existen otras
  personas en el equipo
````

---

## Después de cada pantalla

Cuando Design te devuelva el `.html`:

1. Guardalo en `docs/mockups/` (ej. `venta-rapida.html`)
2. En Claude Code: *"tomá `docs/mockups/venta-rapida.html` y portalo a `js/modules/pedidos.js` + `css/components.css`, respetando las reglas de CLAUDE.md"*
3. Los estilos reutilizables van a `components.css`, no al módulo

Si el mockup trae CSS que ya existe en `components.css` (`.card`, `.btn`, `.badge`, `.days`, `.modal`), se descarta el del mockup y se usa el del repo. El mockup manda en lo visual nuevo, el repo manda en lo que ya está resuelto.
