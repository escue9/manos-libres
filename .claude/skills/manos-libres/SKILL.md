---
name: "manos-libres"
description: "App de gestión del negocio Manos Libres (producción y venta de alimentos). Activar SOLO para operar los números: cargar pedidos, controlar stock, alta de productos, clientes, días trabajados por trabajadora, costos semanales, ganancia y rentabilidad. Frases-ejemplo: \"cuánto vendimos esta semana\", \"me quedó stock de empanadas\", \"cargá un pedido\", \"cuánto ganamos\". Para flyers usar manos-libres-design; para el rol social/comunitario usar mirmidones."
---

# Skill: Manos Libres — App de Gestión

## Contexto del negocio

**Manos Libres** es un emprendimiento de producción y venta de alimentos (empanadas, tartas y otros).
- **Productos**: catálogo ampliable, categorizado (ej: Empanadas, Tartas), con subproductos por gusto/tipo
- **Unidades**: unidad, docena, kg — según producto
- **Pedidos**: por cliente, con historial para detectar clientes frecuentes y fieles
- **Trabajadoras**: cobran por día trabajado (tarifa diaria fija)
- **Costos**: costo variable por producto + costo de trabajadoras (sin otros costos fijos)
- **Rol**: administradora principal; posible acceso futuro para trabajadoras (solo carga, no gestión)


## Identidad visual (IMPORTANTE — respetar siempre)

El logo de Manos Libres tiene fondo negro con manos de colores formando un círculo (rosa, naranja, amarillo, verde, azul claro). El diseño de la app debe reflejar esta identidad:

- **Fondo**: oscuro casi negro (`#0e0e10`, `#16161a`)
- **Paleta multicolor**: cada sección tiene su color propio:
  - Catálogo → Rosa (`#e8185a`)
  - Pedidos → Naranja (`#f55b1e`)
  - Clientes → Amarillo (`#f5b800`)
  - Trabajadoras → Verde (`#1ec84a`)
  - Análisis → Azul claro (`#3db8f5`)
- **Tipografías**: Fredoka One (títulos), Nunito (cuerpo, 700/800), JetBrains Mono (datos)
- **Estilo**: dark mode, bordes sutiles, border-radius generoso (10-14px)
- **Logo**: embebido como base64 en el sidebar (`/mnt/user-data/uploads/logo.jpg`)


## Estructura de la app

Una **app HTML de una sola página** con sidebar fija + área de contenido scrolleable.

### Sidebar
- Logo embebido (base64) + nombre con gradiente rosa→naranja→amarillo
- Navegación con puntos de color por sección + badge con cantidad
- Footer con fechas de semana actual

### Secciones (tabs)

#### Catálogo & Stock (rosa)
- Productos agrupados por categoría
- Tabla: nombre, unidad, precio, costo, stock con barra visual de nivel
- Badge estado: OK / BAJO / CRÍTICO
- Modales: nuevo producto, editar, actualizar stock

#### Pedidos (naranja)
- Stats semana: total vendido, cantidad, ticket promedio
- Tabla de pedidos con cliente y total
- Modal nuevo pedido: cliente (existente o nuevo), productos con cantidad
- Descuenta stock automáticamente al confirmar, valida stock suficiente

#### Clientes (amarillo)
- Lista por cantidad de pedidos. Badge: Fiel (≥5), Frecuente (≥2), Nuevo
- Modal historial con pedidos y total gastado

#### Trabajadoras (verde)
- Selector visual de días: botones 1-7, se activan en verde al hacer click (toggle)
- Costo total automático. Modal agregar/editar trabajadora

#### Análisis Semanal (azul)
- Hero con ganancia neta (verde/rojo/amarillo según resultado)
- 4 stat cards: total vendido, costo mercadería, costo laboral, margen %
- Tabla desglose completo + detalle laboral por trabajadora


## Stack técnico

- **HTML + CSS + JS vanilla** — un solo archivo `.html`
- **Google Fonts**: Fredoka+One, Nunito, JetBrains+Mono
- **Persistencia**: `window.storage` — clave `ml3_state`
- **Logo**: leer `/mnt/user-data/uploads/logo.jpg`, convertir a base64 con Python y embeber
- **Sin localStorage**, sin frameworks, sin librerías externas


## Datos iniciales (seed)

```js
productos: [
  {id:1, nombre:"Empanada de carne",      cat:"Empanadas", un:"unidad", pv:800,  co:350,  st:50, stMin:10},
  {id:2, nombre:"Empanada jamón y queso", cat:"Empanadas", un:"unidad", pv:800,  co:320,  st:30, stMin:10},
  {id:3, nombre:"Empanada de verdura",    cat:"Empanadas", un:"unidad", pv:750,  co:280,  st:20, stMin:10},
  {id:4, nombre:"Docena mixta",           cat:"Empanadas", un:"docena", pv:8500, co:3600, st:5,  stMin:2},
  {id:5, nombre:"Tarta de verdura",       cat:"Tartas",    un:"unidad", pv:3500, co:1200, st:8,  stMin:2},
  {id:6, nombre:"Tarta de carne",         cat:"Tartas",    un:"unidad", pv:4000, co:1500, st:4,  stMin:2},
]
trabajadoras: [
  {id:1, nombre:"Ana",   tarifa:5000},
  {id:2, nombre:"María", tarifa:5000},
]
```


## Proceso de generación

1. Leer logo: `base64.b64encode(open('/mnt/user-data/uploads/logo.jpg','rb').read()).decode()`
2. Construir HTML completo con logo embebido como `data:image/jpeg;base64,...`
3. Escribir en `/mnt/user-data/outputs/manos-libres.html`
4. Presentar con `present_files`

**No usar `visualize:show_widget`** — la app se genera como archivo HTML descargable.
