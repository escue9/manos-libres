-- Se cobra también por venta.
--
-- Octubre de 2026. La ganancia bruta de cada producto (precio menos insumos)
-- se reparte: 60% para quien lo produce, 20% para quien genera la venta y la
-- entrega, 20% para la reinversión de Manos Libres. El 60% ya estaba
-- (20261008_pago_produccion.sql). Esto agrega el 20% de la venta.
--
-- El pago por venta se COBRA cuando el cliente paga: cada cobro de un pedido
-- entregado genera la parte proporcional para quien lo vendió.
--
-- Lo que hace este archivo:
--
--   1. producto.pago_venta: cuánto se paga por unidad vendida. Legible para
--      todo el equipo —es lo que cobran— y modificable solo por administración
--   2. pedido.vendido_por y pedido.pago_venta_total: quién vendió y entregó, y
--      cuánto le toca por ese pedido, congelado al entregar (regla 4)
--   3. la tabla pago_venta: una fila por cobro, con lo que le corresponde a
--      quien vendió. Se protege como pago_produccion: cada una ve lo suyo
--
-- No toca el costo: el pago por venta no entra en el snapshot de pedido_item.
-- El cierre lo resta en su propia línea. Espejo de js/db.js v6 y
-- js/modules/pedidos.js §generarPagosVenta.

-- ---------------------------------------------------------------------------
-- 1 · Cuánto se paga por unidad vendida
-- ---------------------------------------------------------------------------

alter table public.producto
  add column if not exists pago_venta numeric check (pago_venta >= 0);

create or replace view public.producto_v as
  select id, unidad_negocio_id, nombre, categoria, unidad_venta, precio_venta,
         case when public.ve_numeros() then costo_calculado end as costo_calculado,
         case when public.ve_numeros() then costo_manual    end as costo_manual,
         stock_actual, stock_minimo, rinde_por_lote, activo, created_at, updated_at,
         pago_produccion, pago_venta
    from public.producto;

grant select (pago_venta) on public.producto to authenticated;

-- Misma guarda que la paga de producción: quien no es administración no la
-- mueve, aunque la reenvíe en el eco del sync. Es la versión de
-- 20261010_producto_precio.sql con pago_venta sumado.
create or replace function public.producto_costo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  -- Sin JWT es el SQL editor o una migración: pasa como administración
  admin boolean := coalesce(current_setting('request.jwt.claims', true), '') = ''
                   or public.es_admin();
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.producto where id = new.id) then
      -- Upsert de una fila existente: el UPDATE de abajo pone las guardas
      return new;
    end if;
    if not admin then
      raise exception 'El alta de productos es de la administración'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if not public.puede_fijar_costos() then
    new.costo_calculado := old.costo_calculado;
    new.costo_manual    := old.costo_manual;
  end if;
  if not admin then
    new.pago_produccion := old.pago_produccion;
    new.pago_venta      := old.pago_venta;
    new.precio_venta    := old.precio_venta;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2 · Quién vendió cada pedido y cuánto le toca
-- ---------------------------------------------------------------------------

alter table public.pedido
  add column if not exists vendido_por uuid references public.trabajadora(id) on delete restrict,
  add column if not exists pago_venta_total numeric check (pago_venta_total >= 0);

-- Una trabajadora entrega pedidos, así que escribe `pedido`. Lo que no puede
-- es acreditarle la venta a otra persona ni cambiar lo que ya quedó congelado:
-- eso lo hace administración.
create or replace function public.pedido_venta()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_propia uuid;
begin
  if coalesce(current_setting('request.jwt.claims', true), '') = '' or public.es_admin() then
    return new;
  end if;

  -- Un upsert de una fila que ya existe lo resuelve el UPDATE (mismo criterio
  -- que producto_costo): el sync empuja todo con on_conflict
  if tg_op = 'INSERT' and exists (select 1 from public.pedido where id = new.id) then
    return new;
  end if;

  select id into v_propia from public.trabajadora where auth_user_id = auth.uid();

  if tg_op = 'UPDATE' then
    if old.vendido_por is not null and new.vendido_por is distinct from old.vendido_por then
      new.vendido_por := old.vendido_por;
    end if;
    if old.pago_venta_total is not null then
      new.pago_venta_total := old.pago_venta_total;
    end if;
  end if;

  if new.vendido_por is not null and new.vendido_por is distinct from v_propia
     and (tg_op = 'INSERT' or old.vendido_por is null) then
    new.vendido_por := null;
  end if;

  return new;
end;
$$;

drop trigger if exists pedido_venta on public.pedido;
create trigger pedido_venta
  before insert or update on public.pedido
  for each row execute function public.pedido_venta();

-- ---------------------------------------------------------------------------
-- 3 · Lo que cobra quien vendió
-- ---------------------------------------------------------------------------

create table if not exists public.pago_venta (
  id             uuid primary key default gen_random_uuid(),
  trabajadora_id uuid not null references public.trabajadora(id) on delete restrict,
  pedido_id      uuid not null references public.pedido(id) on delete cascade,
  cobro_id       uuid not null references public.cobro(id) on delete cascade,
  fecha          date not null,
  monto          numeric not null check (monto >= 0),
  estado_pago    text not null default 'pendiente'
                 check (estado_pago in ('pendiente', 'pagada')),
  fecha_pago     date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Un cobro genera un solo pago: el sync puede reintentar y no duplica
  constraint pago_venta_un_pago_por_cobro unique (cobro_id)
);

create index if not exists pago_venta_trabajadora_idx on public.pago_venta (trabajadora_id, fecha);
create index if not exists pago_venta_pedido_idx      on public.pago_venta (pedido_id);

drop trigger if exists pago_venta_updated_at on public.pago_venta;
create trigger pago_venta_updated_at
  before update on public.pago_venta
  for each row execute function public.tocar_updated_at();

alter table public.pago_venta enable row level security;
revoke all on public.pago_venta from anon, authenticated;
grant select, insert, update, delete on public.pago_venta to authenticated;

-- Regla 8: lo que cobró otra no se ve nunca.
drop policy if exists "lo vendido propio" on public.pago_venta;
create policy "lo vendido propio"
  on public.pago_venta for select to authenticated
  using (
    public.ve_numeros()
    or trabajadora_id in (select id from public.trabajadora where auth_user_id = auth.uid())
  );

-- Quien registra el cobro genera el pago, y puede ser otra persona que la que
-- vendió: Rocío cobra un pedido que vendió Juan Martín. Por eso no alcanza con
-- "solo lo propio". Lo que se exige es que el pago vaya a quien figura como
-- vendedor del pedido, que nazca pendiente y que no supere lo congelado.
drop policy if exists "el pago va a quien vendio" on public.pago_venta;
create policy "el pago va a quien vendio"
  on public.pago_venta for insert to authenticated
  with check (
    public.es_admin()
    or (
      estado_pago = 'pendiente'
      and exists (
        select 1 from public.pedido p
         where p.id = pedido_id
           and p.vendido_por = trabajadora_id
           and monto <= coalesce(p.pago_venta_total, 0)
      )
    )
  );

drop policy if exists "solo administracion paga la venta" on public.pago_venta;
create policy "solo administracion paga la venta"
  on public.pago_venta for update to authenticated
  using (public.es_admin()) with check (public.es_admin());

drop policy if exists "solo administracion borra pagos de venta" on public.pago_venta;
create policy "solo administracion borra pagos de venta"
  on public.pago_venta for delete to authenticated
  using (public.es_admin());

revoke execute on function public.pedido_venta() from public, anon, authenticated;
