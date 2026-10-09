-- Se cobra por producción, no por día.
--
-- Octubre de 2026: Rocío arranca y cobra por lo que produce. Cada producto
-- tiene un pago por unidad (`producto.pago_produccion`) y quien lo produce lo
-- cobra. La tarifa por día deja de existir para todas: las jornadas quedan como
-- registro de asistencia, con tarifa cero. Lo ya pagado por día queda en el
-- histórico tal como está.
--
-- Lo que hace este archivo:
--
--   1. producto.pago_produccion, legible para todo el equipo (es lo que cobran
--      y es igual para todas) y modificable solo por la administración
--   2. la tabla pago_produccion: una fila por productora y por línea de orden,
--      con el monto por unidad congelado (regla 4). Se protege como `jornada`:
--      cada una ve solo lo suyo (regla 8)
--   3. el pago entra al costo: costo efectivo = materiales + pago por unidad.
--      Se ajustan las funciones de 20260804_costos_servidor.sql para que el
--      snapshot que pone el servidor diga lo mismo que calc.costoEfectivo
--   4. la mano de obra de la orden pasa a ser la suma de lo que se paga por lo
--      producido
--
-- Espejo de js/db.js v5, js/calc.js §costoEfectivo y js/modules/produccion.js
-- §cerrarOrden.

-- ---------------------------------------------------------------------------
-- 1 · Cuánto se paga por unidad
-- ---------------------------------------------------------------------------

alter table public.producto
  add column if not exists pago_produccion numeric check (pago_produccion >= 0);

-- null es "nadie lo definió", que no es lo mismo que cero: con null la orden
-- no cierra (produccion.js §cerrarOrden), con 0 cierra y no paga nada.

-- La vista suma la columna al final —`create or replace view` solo deja
-- agregar columnas ahí— y sin case: no es un costo oculto, es la paga.
create or replace view public.producto_v as
  select id, unidad_negocio_id, nombre, categoria, unidad_venta, precio_venta,
         case when public.ve_numeros() then costo_calculado end as costo_calculado,
         case when public.ve_numeros() then costo_manual    end as costo_manual,
         stock_actual, stock_minimo, rinde_por_lote, activo, created_at, updated_at,
         pago_produccion
    from public.producto;

-- 20260806_costos_ocultos.sql sacó el SELECT de tabla y lo volvió a dar por
-- columnas: una columna nueva nace invisible si no se la nombra acá.
grant select (pago_produccion) on public.producto to authenticated;

-- Toda la cocina puede escribir `producto` (descuenta stock al vender), así
-- que la guarda va en el trigger: quien no es administración no mueve la paga.
-- Mismo criterio que el costo en producto_costo(): un dato que no le toca, no
-- lo pisa, aunque lo reenvíe en el eco del sync.
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
  if not (coalesce(current_setting('request.jwt.claims', true), '') = '' or public.es_admin()) then
    new.pago_produccion := old.pago_produccion;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2 · Lo que cobra cada una
-- ---------------------------------------------------------------------------

create table if not exists public.pago_produccion (
  id                  uuid primary key default gen_random_uuid(),
  trabajadora_id      uuid not null references public.trabajadora(id) on delete restrict,
  orden_produccion_id uuid not null references public.orden_produccion(id) on delete cascade,
  produccion_item_id  uuid not null references public.produccion_item(id) on delete cascade,
  producto_id         uuid not null references public.producto(id) on delete restrict,
  fecha               date not null,
  cantidad            numeric not null check (cantidad > 0),
  -- Congelado al cerrar la orden: subir el pago mañana no cambia lo de hoy
  pago_unitario       numeric not null default 0 check (pago_unitario >= 0),
  total               numeric not null default 0 check (total >= 0),
  origen_carga        text not null default 'admin'
                      check (origen_carga in ('admin', 'autoreporte')),
  confirmada          boolean not null default false,
  estado_pago         text not null default 'pendiente'
                      check (estado_pago in ('pendiente', 'pagada')),
  fecha_pago          date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists pago_produccion_trabajadora_idx on public.pago_produccion (trabajadora_id, fecha);
create index if not exists pago_produccion_orden_idx       on public.pago_produccion (orden_produccion_id);

drop trigger if exists pago_produccion_updated_at on public.pago_produccion;
create trigger pago_produccion_updated_at
  before update on public.pago_produccion
  for each row execute function public.tocar_updated_at();

alter table public.pago_produccion enable row level security;
revoke all on public.pago_produccion from anon, authenticated;
grant select, insert, update, delete on public.pago_produccion to authenticated;

-- Regla 8: lo que cobró otra no se ve nunca. La administración y la comisión
-- ven todo.
drop policy if exists "lo producido propio" on public.pago_produccion;
create policy "lo producido propio"
  on public.pago_produccion for select to authenticated
  using (
    public.ve_numeros()
    or trabajadora_id in (select id from public.trabajadora where auth_user_id = auth.uid())
  );

-- Una trabajadora que cierra una orden carga SU producción, y entra sin
-- confirmar: es plata que sale de la caja y la aprueba la administración.
-- No puede cargar a nombre de otra; el cliente ya lo corta antes
-- (produccion.js §repartir), esto es para quien lo intente desde la consola.
drop policy if exists "carga de la propia produccion" on public.pago_produccion;
create policy "carga de la propia produccion"
  on public.pago_produccion for insert to authenticated
  with check (
    public.es_admin()
    or (
      trabajadora_id in (select id from public.trabajadora where auth_user_id = auth.uid())
      and origen_carga = 'autoreporte'
      and confirmada = false
      and estado_pago = 'pendiente'
    )
  );

drop policy if exists "solo administracion confirma y paga la produccion" on public.pago_produccion;
create policy "solo administracion confirma y paga la produccion"
  on public.pago_produccion for update to authenticated
  using (public.es_admin()) with check (public.es_admin());

drop policy if exists "solo administracion borra produccion" on public.pago_produccion;
create policy "solo administracion borra produccion"
  on public.pago_produccion for delete to authenticated
  using (public.es_admin());

-- El monto lo pone el servidor cuando carga alguien que no fija costos, con
-- el mismo criterio que el snapshot de la venta: quien cobra no se fija su
-- propia paga. Y una vez escrito no se mueve (regla 4).
create or replace function public.pago_produccion_monto()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not public.puede_fijar_costos() then
      select coalesce(pago_produccion, 0) into new.pago_unitario
        from public.producto where id = new.producto_id;
      new.pago_unitario := coalesce(new.pago_unitario, 0);
    end if;
    new.total := new.cantidad * new.pago_unitario;
    return new;
  end if;

  if new.cantidad is distinct from old.cantidad
     or new.pago_unitario is distinct from old.pago_unitario
     or new.total is distinct from old.total
     or new.trabajadora_id is distinct from old.trabajadora_id then
    raise exception 'pago_produccion: lo producido y su monto se congelan al cerrar la orden (regla 4)';
  end if;
  return new;
end;
$$;

drop trigger if exists pago_produccion_monto on public.pago_produccion;
create trigger pago_produccion_monto
  before insert or update on public.pago_produccion
  for each row execute function public.pago_produccion_monto();

-- ---------------------------------------------------------------------------
-- 3 · El pago entra al costo
-- ---------------------------------------------------------------------------

/** Materiales: receta o manual. Es lo que antes se llamaba costo efectivo. */
create or replace function public.costo_base_producto(p_producto uuid)
returns numeric
language sql stable security definer
set search_path = ''
as $$
  select coalesce(nullif(costo_calculado, 0), nullif(costo_manual, 0), 0)
  from public.producto where id = p_producto;
$$;

/** Materiales más lo que cobra quien lo produce — calc.costoEfectivo. */
create or replace function public.costo_efectivo_producto(p_producto uuid)
returns numeric
language sql stable security definer
set search_path = ''
as $$
  select coalesce(nullif(costo_calculado, 0), nullif(costo_manual, 0), 0)
       + coalesce(pago_produccion, 0)
  from public.producto where id = p_producto;
$$;

-- El snapshot de producción: receta (o materiales) + pago por unidad. Antes
-- era `coalesce(receta, efectivo)`; con el pago adentro de efectivo eso lo
-- sumaba dos veces cuando no había receta.
create or replace function public.produccion_item_costo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.costo_unitario_snapshot is not null then
      if new.costo_unitario_snapshot is distinct from old.costo_unitario_snapshot then
        if new.costo_unitario_snapshot is null or not public.puede_fijar_costos() then
          new.costo_unitario_snapshot := old.costo_unitario_snapshot;
        else
          raise exception 'produccion_item.costo_unitario_snapshot se congela al cerrar la orden (regla 4)';
        end if;
      end if;
      return new;
    end if;
  end if;

  if new.cantidad_real is not null
     and (new.costo_unitario_snapshot is null or not public.puede_fijar_costos()) then
    new.costo_unitario_snapshot :=
      coalesce(public.costo_receta_producto(new.producto_id),
               public.costo_base_producto(new.producto_id))
      + coalesce((select pago_produccion from public.producto where id = new.producto_id), 0);
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4 · La mano de obra de la orden
-- ---------------------------------------------------------------------------

/**
 * Lo que se paga por lo producido en la orden, más las jornadas con tarifa
 * que hayan quedado de antes del cambio.
 */
create or replace function public.costo_mano_obra_orden(p_orden uuid)
returns numeric
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select sum(total) from public.pago_produccion
                    where orden_produccion_id = p_orden), 0)
       + coalesce((select sum(tarifa_aplicada) from public.jornada
                    where orden_produccion_id = p_orden and confirmada), 0);
$$;

-- El sync sube orden_produccion ANTES que pago_produccion (claves foráneas),
-- así que cuando el trigger de la orden calcula la mano de obra, las filas
-- de pago todavía no llegaron. Cada pago que entra recalcula la de su orden.
create or replace function public.pago_produccion_a_la_orden()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.orden_produccion
     set costo_mano_obra = public.costo_mano_obra_orden(new.orden_produccion_id)
   where id = new.orden_produccion_id and estado = 'cerrada';
  return null;
end;
$$;

drop trigger if exists pago_produccion_a_la_orden on public.pago_produccion;
create trigger pago_produccion_a_la_orden
  after insert on public.pago_produccion
  for each row execute function public.pago_produccion_a_la_orden();

-- Las funciones de costeo no son API (ver 20260804_costos_servidor.sql).
revoke execute on function
  public.costo_base_producto(uuid),
  public.costo_efectivo_producto(uuid),
  public.costo_mano_obra_orden(uuid),
  public.producto_costo(),
  public.pago_produccion_monto(),
  public.pago_produccion_a_la_orden(),
  public.produccion_item_costo()
from public, anon, authenticated;
