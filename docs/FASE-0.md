# Fase 0 — Fundación ✅

La app abre, se instala como PWA, pide PIN y navega entre las cinco secciones.
Sin lógica de negocio todavía: eso son las fases 1 a 4.

---

## Qué quedó construido

### Login por PIN — `js/login.js`

Teclado numérico propio, no el del sistema. El nativo tapa media pantalla, tarda
en aparecer y en Android a veces arranca en modo texto. Con botones propios el
ingreso son cuatro taps y siempre igual.

- **Primer arranque:** pide crear el PIN de administración, dos veces para confirmar
- **Uso normal:** valida contra el admin y contra cada trabajadora activa
- PIN incorrecto: los puntos se ponen rojos, el cuadro tiembla y vibra el teléfono
- Funciona también con teclado físico, para desarrollar en la compu

### Seguridad del PIN — `js/auth.js`

- SHA-256 vía SubtleCrypto, con **salt aleatorio por instalación**. Sin salt, cuatro
  dígitos se rompen con una tabla precalculada en segundos
- El salt se genera solo la primera vez y vive en la tabla `config`
- Sesión en `sessionStorage`: se cierra al cerrar el navegador

### Permisos por rol

El nav oculta las tabs que el rol no puede ver y reparte el ancho entre las que
quedan. Una trabajadora no ve Caja ni Clientes; entra directo a Producción.

`auth.filtrarPropio()` es la función que sostiene la regla de privacidad: filtra
cualquier listado para que una trabajadora vea solo lo suyo.

### Estados vacíos

Cada vista con su color, su ícono y un texto que anticipa para qué va a servir esa
sección. Sirven de recordatorio de hacia dónde va el sistema.

### Backup — menú `···` del header

`db.exportAll()` baja un `.json` con todo, nombrado por fecha. Hasta la Fase 5 es
la única copia que existe. Hacelo cada semana.

### Tabla `config`

Nueva, no estaba en el PDR: almacén clave/valor para el hash del admin y el salt.
`DB_VERSION` subió a 2.

---

## Checklist de aceptación

**Automático** — `node test/fase-0.test.mjs` · 42 pruebas, todas pasan

- [x] Sintaxis de los 11 módulos
- [x] Ningún módulo usa `indexedDB` directo — todo pasa por `db.js`
- [x] Sin `localStorage` en ningún lado
- [x] Todos los imports resuelven
- [x] Los archivos del `SHELL` del service worker existen
- [x] Manifest válido, los tres íconos existen
- [x] Todos los `getElementById` tienen su id en el HTML
- [x] El PIN no queda en texto plano y hay salt
- [x] Una trabajadora no ve caja, ni costos, ni márgenes
- [x] El cierre semanal ignora pedidos no entregados y jornadas sin confirmar

**Manual, con el celular en la mano** — te toca a vos:

- [ ] Abre en `http://localhost:8000` y se ve bien a 390px
- [ ] Pide PIN y no deja pasar sin él
- [ ] El botón de backup baja un `.json` con datos adentro
- [ ] Cerrar y reabrir conserva los datos

### ⚠️ Pendiente — requiere HTTPS

- [ ] **Se instala como app desde el navegador del celular**
- [ ] **Con modo avión activado, abre igual y no muestra error**

No se puede verificar en desarrollo local: el navegador registra service workers
y expone `crypto.subtle` **solo en contextos seguros** (HTTPS o `localhost`).
Desde el celular por IP de red local sobre HTTP, ninguna de las dos cosas existe.

Ya está publicado en `https://manos-libres-app.vercel.app` (Fase 5), así que
esto ya se puede probar — falta hacerlo. `js/login.js` ya detecta el caso y
avisa en pantalla en vez de fallar en silencio.

Si al probarlo falla, el sospechoso es el `SHELL` de `sw.js`: que falte un archivo
o que `CACHE_VERSION` haya quedado vieja.

---

## Cómo probar

```bash
cd "S O Manos Libres"
python -m http.server 8000
```

Abrir `http://localhost:8000`, activar la vista mobile del navegador (390px) y
crear el PIN.

**Para probar la vista de trabajadora**, en la consola:

```js
const t = await db.from('trabajadora').select().eq('nombre','Ana').single();
await auth.cambiarPinTrabajadora(t.id, '1111');
```

Cerrar sesión desde el menú `···` y entrar con `1111`. Ahí se ve el nav recortado.

**Para empezar de cero:** `await db.reset()` y recargar. Borra también el PIN.

---

## Lo que sigue

Fase 1 (Producción) o venta rápida, según lo que decidas. La venta rápida ya tiene
el mockup listo en `docs/mockups/venta-rapida.html`.
