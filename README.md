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
- `docs/FASE-0.md` · `docs/VENTA-RAPIDA.md` · `docs/FASE-1.md` · `docs/FASE-3.md` — qué se construyó y por qué
- `docs/REVISION-FASES-2-3.md` — los 16 bugs que encontró la revisión profunda y cómo se arreglaron
- `docs/BRIEF-DESIGN.md` — briefs para diseñar pantallas nuevas

## Tests

```bash
npm install   # una sola vez, solo para testing
npm test      # 226 pruebas
```

## Estado

- ✅ Fase 0 — fundación, login por PIN, permisos por rol
- ✅ Venta rápida — la pantalla del mostrador
- ✅ Fase 1 — insumos, compras, recetas, costeo, órdenes de producción, stock
- ⏳ Fases 2, 3, 4 y 5 — ver `docs/BRIEF-CODE.md`

## Backup

Mientras no haya nube (fases 0–4), exportar semanalmente desde la consola:

```js
await db.exportAll()
```
