---
name: "manos-libres-design"
description: "Diseño gráfico de Manos Libres: flyers y piezas SVG con la identidad de marca (fondo negro, paleta multicolor, Fredoka One + Nunito, logo). Activar cuando pida material visual de Manos Libres: \"flyer de Manos Libres\", \"menú de la semana\", \"promo para WhatsApp/Instagram\", \"publicación\". Si pide un flyer sin nombrar la marca, preguntar para cuál organización antes de asumir. Para diseño de Tregar usar tregar-design."
---

# Skill: Manos Libres — Diseño Gráfico

## Contexto del negocio

**Manos Libres** es un emprendimiento de comida casera (empanadas, tartas) en Tandil, Argentina.
Opera desde el CIC en Barrio Movediza, vinculado a Mirmidones y U.P. N°37 (programa de reinserción social).
Tono de comunicación: **cálido, comunitario, vibrante**. No corporativo. Cercano.

**Productos típicos:**
- Empanadas de carne, jamón y queso, verdura
- Docena mixta
- Tartas de verdura y carne
- Precios: empanadas ~$800–900 c/u, docena ~$8.500–9.500, tartas ~$3.500–4.500

**Canal principal de difusión:** WhatsApp (grupos, estados), Instagram secundario.


## Identidad visual — RESPETAR SIEMPRE

### Logo
- Manos de colores formando un círculo (rosa, naranja, amarillo, verde, azul, violeta)
- Texto "MANOS" en rosa/magenta, "LIBRES" en naranja/amarillo
- Logo en archivo: `/mnt/user-data/uploads/logo_s-fondo.jpg`
- Embeber siempre como base64 en el SVG: `python3 -c "import base64; print(base64.b64encode(open('/mnt/user-data/uploads/logo_s-fondo.jpg','rb').read()).decode())"`

### Paleta de colores
```
Fondo principal:   #0e0e10  (negro profundo)
Fondo secundario:  #16161a  (negro suave)
Rosa:              #e8185a
Naranja:           #f55b1e
Amarillo:          #f5b800
Verde:             #1ec84a
Azul claro:        #3db8f5
Violeta:           #9b3df5
Blanco texto:      #ffffff
Gris suave:        #888899
```

### Tipografías (Google Fonts — incluir siempre en SVG como foreignObject o usar approximaciones)
- **Fredoka One** → títulos, nombres de productos, destacados
- **Nunito 800** → subtítulos, precios, llamadas a la acción
- **Nunito 400/700** → cuerpo, descripciones

> En SVG puro usar `font-family="'Fredoka One', 'Arial Rounded MT Bold', sans-serif"` como fallback.

### Elementos de marca recurrentes
- Gradientes lineales usando los colores de la paleta (rosa→naranja→amarillo)
- Bordes con `stroke` de color vibrante, `stroke-width` fino
- Círculos y formas orgánicas como decoración
- Separadores con gradiente multicolor
- Siempre fondo oscuro — NUNCA fondo blanco


## Formatos de salida

### Formato principal: WhatsApp cuadrado (1:1)
```
viewBox: "0 0 1080 1080"
Archivo: /mnt/user-data/outputs/flyer-[tipo]-[descripcion].svg
```

### Formato secundario: Instagram Story (9:16)
```
viewBox: "0 0 1080 1920"
Archivo: /mnt/user-data/outputs/story-[tipo]-[descripcion].svg
```


## Templates por tipo

### Template A — Menú Semanal

**Estructura (de arriba a abajo):**
1. Header: logo + "MENÚ DE LA SEMANA" con gradiente
2. Separador decorativo multicolor
3. Lista de productos con precio — cada ítem con su color de la paleta
4. Franja central: día/período de la semana
5. Footer: "Pedidos por WhatsApp" + emoji + CTA

**Colores por sección del menú:**
- Empanadas → Rosa (#e8185a)
- Tartas → Naranja (#f55b1e)
- Especiales / combos → Amarillo (#f5b800)

**Layout SVG referencia:**
```svg
<!-- Fondo -->
<rect width="1080" height="1080" fill="#0e0e10"/>

<!-- Elemento decorativo superior: arco de círculos de colores -->
<!-- Logo centrado -->
<!-- Título con gradiente -->
<!-- Items de menú en cards con borde de color -->
<!-- Footer con CTA -->
```


### Template B — Promoción / Oferta

**Estructura:**
1. Badge "OFERTA" o "ESPECIAL HOY" en destaque (color llamativo, rotado ~-5°)
2. Producto destacado (nombre grande, Fredoka One)
3. Precio con énfasis visual: precio tachado (si aplica) + precio nuevo grande
4. Logo + info de contacto abajo

**Recursos visuales:**
- Starburst / explosión detrás del precio
- Texto con `filter: drop-shadow` de color
- Diagonal o forma geométrica cortando el fondo


## Proceso de generación

### Paso 1 — Leer el logo
```python
import base64
logo_b64 = base64.b64encode(open('/mnt/user-data/uploads/logo_s-fondo.jpg','rb').read()).decode()
logo_data_uri = f"data:image/jpeg;base64,{logo_b64}"
```

### Paso 2 — Construir el SVG
- Usar el template correspondiente al tipo pedido
- Completar con el contenido específico que da Juan Martín (productos, precios, texto)
- Si no da precios concretos, usar los típicos del negocio como placeholder
- Si no especifica tipo, asumir **Menú Semanal**

### Paso 3 — Guardar y presentar
```
Ruta de salida: /mnt/user-data/outputs/flyer-[tipo]-ML.svg
Presentar con: present_files
```


## Instrucciones de diseño — reglas irrompibles

1. **Nunca fondo blanco o claro** — siempre dark
2. **Logo siempre presente** — generalmente en header o footer
3. **Mínimo 2 colores de la paleta** por pieza
4. **Texto legible a tamaño celular** — tamaños mínimos: título 80px, cuerpo 40px (en viewBox 1080×1080)
5. **Consistencia de marca** — que se vea que es Manos Libres sin leer el nombre
6. **Vibrant, no recargado** — máximo 4 elementos visuales decorativos por pieza
7. **CTA siempre presente** — "Pedí por WhatsApp", "Encargá el tuyo", etc.


## Ejemplos de pedidos y cómo interpretarlos

| Juan Martín dice | Interpretar como |
|---|---|
| "haceme el menú de esta semana" | Template A, pedir productos o usar catálogo típico |
| "flyer para la promo de docenas" | Template B, producto: Docena mixta |
| "algo para compartir por el estado" | WhatsApp 1:1, Template B o A según contexto |
| "promo del fin de semana" | Template B con urgencia/tiempo limitado |
| "story para Instagram" | Formato 9:16, mismo template pero adaptado |


## Notas de implementación SVG

- Incluir `<defs>` con gradientes lineales reutilizables al inicio
- Usar `<clipPath>` para formas recortadas (logos en círculo, etc.)
- Para texto multicolor usar `<tspan>` con `fill` individual
- `font-family` siempre con fallbacks seguros
- El SVG debe ser autónomo (standalone) — todos los recursos embebidos como base64
