# Sistema Operativo — Cocina CIC

PWA de gestión para la cocina comunitaria de **Manos Libres** en el CIC Barrio Movediza, Tandil.
Proyecto de Mirmidones Asociación Civil.

## Correr en local

El service worker necesita `http://`, no `file://`:

```bash
python -m http.server 8000
```

Después abrir http://localhost:8000 y probar **siempre en vista mobile**.

## Documentación

- `CLAUDE.md` — las 8 reglas no negociables. Leer primero
- `docs/PDR.md` — modelo de datos, flujos, fórmulas, roadmap
- `docs/BRIEF-CODE.md` — **handoff para seguir el desarrollo**
- `docs/FASE-0.md` · `docs/VENTA-RAPIDA.md` — qué se construyó y por qué
- `docs/BRIEF-DESIGN.md` — briefs para diseñar pantallas nuevas

## Tests

```bash
npm install fake-indexeddb   # una sola vez, solo para testing
node test/fase-0.test.mjs        # 42 pruebas
node test/venta-rapida.test.mjs  # 20 pruebas
```

## Estado

- ✅ Fase 0 — fundación, login por PIN, permisos por rol
- ✅ Venta rápida — la pantalla del mostrador
- ⏳ Fases 1, 3, 4 y 5 — ver `docs/BRIEF-CODE.md`

## Backup

Mientras no haya nube (fases 0–4), exportar semanalmente desde la consola:

```js
await db.exportAll()
```
