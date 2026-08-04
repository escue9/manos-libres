-- Fase 5 §4.3 — los costos dejan de estar a la vista.
--
-- La mitad que quedó pendiente desde 20260803_esquema_so.sql. Ahí el problema
-- era que RLS filtra filas y no columnas, y que esconder las columnas rompía la
-- venta rápida porque la trabajadora escribe el snapshot de costo. Eso lo
-- resolvió 20260804_costos_servidor.sql: ahora el snapshot lo pone el servidor.
-- Con eso destrabado, acá se cierra el agujero que quedaba medido y anotado —
-- una trabajadora leyendo `insumo.costo_unitario` derecho de la columna.
--
-- POR QUÉ VISTAS Y NO SOLO UN REVOKE. En Supabase todo el mundo entra con el
-- mismo rol de Postgres (`authenticated`): admin, comisión y cocina son la
-- misma cuenta de base de datos, distinguidas por un claim del JWT. Los
-- permisos de columna no leen claims, así que revocar la columna se la saca
-- también a la administración. Las vistas son la forma de que el mismo `select`
-- devuelva el costo o no según quién pregunta.
--
-- Son `security definer` (el default de una vista): corren con el permiso del
-- dueño, que es el único que puede leer la columna revocada. Eso implica que
-- salteán el RLS de la tabla de abajo — acá no cambia nada porque la política
-- de lectura de estas cinco tablas es `using (true)` para todo el equipo, pero
-- si mañana alguna se restringe por fila, la restricción hay que repetirla
-- adentro de la vista o se pierde.
--
-- El linter de Supabase marca las cinco como ERROR por ese mismo motivo
-- (`security_definer_view`). Se deja así a sabiendas: es la propiedad que hace
-- funcionar el diseño, no un descuido. Lo que hay que sostener es la condición
-- de arriba — que la lectura de estas tablas siga siendo abierta para el
-- equipo—, y por eso queda escrita acá y no en la cabeza de nadie.

-- ---------------------------------------------------------------------------
-- Primero: que no puedan borrar lo que no pueden ver
-- ---------------------------------------------------------------------------
--
-- Esto va ANTES del revoke y es lo que lo hace seguro. El dispositivo de una
-- trabajadora va a bajar el insumo con el costo en null —la vista se lo
-- esconde— y cuando cambie el stock va a devolver la fila entera, con ese null
-- adentro. Sin esta guarda, contar el stock de la harina borraría su costo para
-- toda la cocina.
--
-- Es la misma regla del §3 con otra cara: un dato que el que escribe no puede
-- ver, no lo puede pisar.

create or replace function public.insumo_costo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.costo_unitario is distinct from old.costo_unitario
     and not public.puede_fijar_costos() then
    new.costo_unitario := old.costo_unitario;
  end if;
  return new;
end;
$$;

drop trigger if exists insumo_costo on public.insumo;
create trigger insumo_costo
  before update on public.insumo
  for each row execute function public.insumo_costo();

create or replace function public.producto_costo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.puede_fijar_costos() then
    new.costo_calculado := old.costo_calculado;
    new.costo_manual    := old.costo_manual;
  end if;
  return new;
end;
$$;

drop trigger if exists producto_costo on public.producto;
create trigger producto_costo
  before update on public.producto
  for each row execute function public.producto_costo();

revoke execute on function public.insumo_costo(), public.producto_costo()
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Las vistas por las que lee el SO
-- ---------------------------------------------------------------------------
--
-- Devuelven la fila completa; lo único que cambia es que la columna de costo
-- viene en null para quien no puede verla. El cliente no necesita saber cuáles
-- son: pide `select=*` como siempre, contra la vista en vez de contra la tabla.
-- Escribir sigue yendo derecho a la tabla — revocamos el SELECT de la columna,
-- no el UPDATE.

create or replace view public.insumo_v as
  select id, unidad_negocio_id, nombre, categoria, unidad_medida,
         case when public.ve_numeros() then costo_unitario end as costo_unitario,
         stock_actual, stock_minimo, proveedor_habitual, activo, created_at, updated_at
    from public.insumo;

create or replace view public.producto_v as
  select id, unidad_negocio_id, nombre, categoria, unidad_venta, precio_venta,
         case when public.ve_numeros() then costo_calculado end as costo_calculado,
         case when public.ve_numeros() then costo_manual    end as costo_manual,
         stock_actual, stock_minimo, rinde_por_lote, activo, created_at, updated_at
    from public.producto;

create or replace view public.pedido_item_v as
  select id, pedido_id, producto_id, cantidad, precio_unitario,
         case when public.ve_numeros() then costo_unitario end as costo_unitario,
         created_at, updated_at
    from public.pedido_item;

create or replace view public.produccion_item_v as
  select id, orden_produccion_id, producto_id, cantidad_planificada, cantidad_real,
         case when public.ve_numeros() then costo_unitario_snapshot end as costo_unitario_snapshot,
         created_at, updated_at
    from public.produccion_item;

create or replace view public.orden_produccion_v as
  select id, unidad_negocio_id, fecha, estado,
         case when public.ve_numeros() then costo_insumos   end as costo_insumos,
         case when public.ve_numeros() then costo_mano_obra end as costo_mano_obra,
         notas, cerrada_at, created_at, updated_at
    from public.orden_produccion;

grant select on
  public.insumo_v, public.producto_v, public.pedido_item_v,
  public.produccion_item_v, public.orden_produccion_v
to authenticated;

-- ---------------------------------------------------------------------------
-- Y ahora sí: la columna deja de leerse
-- ---------------------------------------------------------------------------
--
-- Desde acá, `select *` sobre estas cinco tablas devuelve 42501 para TODO el
-- mundo, administración incluida. Es a propósito y es el punto: el que quiera
-- leer, que pase por la vista. Un `select` que se olvide queda roto de entrada
-- en vez de filtrar en silencio.
--
-- OJO CON CÓMO SE HACE, que la primera vez lo hice mal y no falla ruidosamente:
-- `revoke select (columna)` NO alcanza si sigue en pie el `grant select` de la
-- tabla entera que dio el esquema. El permiso de tabla cubre todas las columnas
-- y el revoke de columna no lo perfora — se aplica sin error, se ve prolijo en
-- la migración, y la columna se sigue leyendo igual. Hay que sacar el permiso
-- de tabla y volver a darlo enumerando las columnas que sí.
--
-- Esa enumeración es el precio del diseño: una columna nueva en estas cinco
-- tablas hay que agregarla acá y en su vista, o nace invisible.

revoke select on
  public.insumo, public.producto, public.pedido_item,
  public.produccion_item, public.orden_produccion
from authenticated, anon;

grant select (id, unidad_negocio_id, nombre, categoria, unidad_medida,
              stock_actual, stock_minimo, proveedor_habitual, activo,
              created_at, updated_at)
  on public.insumo to authenticated;

grant select (id, unidad_negocio_id, nombre, categoria, unidad_venta, precio_venta,
              stock_actual, stock_minimo, rinde_por_lote, activo,
              created_at, updated_at)
  on public.producto to authenticated;

grant select (id, pedido_id, producto_id, cantidad, precio_unitario,
              created_at, updated_at)
  on public.pedido_item to authenticated;

grant select (id, orden_produccion_id, producto_id, cantidad_planificada,
              cantidad_real, created_at, updated_at)
  on public.produccion_item to authenticated;

grant select (id, unidad_negocio_id, fecha, estado, notas, cerrada_at,
              created_at, updated_at)
  on public.orden_produccion to authenticated;

-- ---------------------------------------------------------------------------
-- De paso: el catálogo dejaba escribir a cualquiera con sesión
-- ---------------------------------------------------------------------------
--
-- Venía de la migración del canal web, cuando la única sesión que existía era
-- la de administración y `authenticated` significaba "el SO". Ahora que cada
-- trabajadora tiene la suya, esa política deja que cualquiera publique precios
-- al público — y publicar precios es de administración (PERMISOS.gestionarCanalWeb
-- lo dice desde la fase 2, pero lo decía solo la interfaz).

drop policy if exists "el SO administra el catalogo" on public.catalogo_item;
create policy "el SO administra el catalogo"
  on public.catalogo_item for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

-- El buzón lo procesa administración por la misma razón: marcar un pedido web
-- como importado es decidir que ya está atendido.
drop policy if exists "el SO procesa el buzon" on public.pedido_web;
create policy "el SO procesa el buzon"
  on public.pedido_web for update to authenticated
  using (public.es_admin()) with check (public.es_admin());
