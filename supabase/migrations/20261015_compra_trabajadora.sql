-- La trabajadora carga las compras — 15/10/2026.
--
-- Rocío sale con la plata, compra y vuelve con el ticket. Hasta acá
-- `compra_insumo` era solo de administración, porque una compra hace tres
-- cosas que ella no puede hacer desde su celular:
--
--   1. recalcular el costo del insumo por promedio ponderado — necesita el
--      costo que tenía, y ese número no lo ve (regla 8; insumo_v se lo trae
--      en null)
--   2. recalcular el costo de los productos que lo usan — mismo motivo
--   3. dejar el egreso en caja — la caja es de administración, y la regla 6
--      dice que ese egreso es automático, nunca a mano
--
-- Con el mismo criterio del §3 (20260804_costos_servidor.sql): si quien
-- escribe no ve costos, el número lo pone el servidor. Del celular sube la
-- parte de cantidades —la compra, el stock y su movimiento— y este trigger
-- hace el resto cuando la compra llega.
--
-- Lo que carga administración no cambia: su cliente sigue haciendo los tres
-- pasos y acá no se toca nada.

-- ---------------------------------------------------------------------------
-- 1 · Quién compró y con qué
-- ---------------------------------------------------------------------------

alter table public.compra_insumo
  add column if not exists comprado_por uuid references public.trabajadora(id) on delete restrict,
  add column if not exists medio text check (medio in ('efectivo', 'transferencia', 'mercadopago'));

-- ---------------------------------------------------------------------------
-- 2 · El servidor puede fijar costos adentro de este trigger
-- ---------------------------------------------------------------------------
--
-- Las guardas de insumo y producto (insumo_costo, producto_costo) miran
-- puede_fijar_costos(), y adentro de una request de la trabajadora el JWT sigue
-- siendo el de ella: el update del promedio se revertiría en silencio. Una
-- marca local a la transacción deja pasar solo lo que escribe este trigger. El
-- cliente no la puede poner: set_config no está expuesto por PostgREST.

create or replace function public.puede_fijar_costos()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(current_setting('request.jwt.claims', true), '') = ''
      or public.ve_numeros()
      or coalesce(current_setting('ml.costo_servidor', true), '') = 'on';
$$;

-- ---------------------------------------------------------------------------
-- 3 · La compra que sube sin costos
-- ---------------------------------------------------------------------------
--
-- AFTER INSERT y no BEFORE: el sync manda un upsert, y en un upsert que choca
-- los BEFORE INSERT corren igual. Un AFTER INSERT corre solo si la fila entró
-- de verdad, así que un reenvío no duplica el egreso.
--
-- El stock previo sale de restarle la compra al actual: sync.js sube `insumo`
-- antes que `compra_insumo` (ORDEN), así que cuando esto corre el stock ya la
-- incluye. Negativo cuenta como cero, igual que calc.costoPonderado.

create or replace function public.compra_de_la_cocina()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_insumo  public.insumo%rowtype;
  v_previo  numeric;
  v_unit    numeric;
  v_costo   numeric;
  v_receta  numeric;
  p         record;
begin
  if public.ve_numeros() or coalesce(current_setting('request.jwt.claims', true), '') = '' then
    return null;            -- administración ya hizo todo desde su cliente
  end if;

  select * into v_insumo from public.insumo where id = new.insumo_id for update;
  if not found then return null; end if;

  v_previo := greatest(coalesce(v_insumo.stock_actual, 0) - new.cantidad, 0);
  v_unit   := new.costo_total / new.cantidad;
  v_costo  := case when v_previo + new.cantidad <= 0 then v_unit
                   else (v_previo * coalesce(v_insumo.costo_unitario, 0) + new.cantidad * v_unit)
                        / (v_previo + new.cantidad) end;

  perform set_config('ml.costo_servidor', 'on', true);

  update public.insumo set costo_unitario = v_costo where id = new.insumo_id;

  -- Los productos que lo usan: mismo costeo que recalcularCostos. Una receta
  -- que no se puede costear deja el costo que tenía, no lo pisa con null.
  for p in
    select distinct ri.producto_id from public.receta_item ri where ri.insumo_id = new.insumo_id
  loop
    v_receta := public.costo_receta_producto(p.producto_id);
    if v_receta is not null then
      update public.producto set costo_calculado = v_receta where id = p.producto_id;
    end if;
  end loop;

  perform set_config('ml.costo_servidor', '', true);

  if new.costo_total > 0 then
    insert into public.movimiento_caja
      (unidad_negocio_id, fecha, tipo, origen, referencia_id, monto, descripcion, medio)
    values
      (v_insumo.unidad_negocio_id, new.fecha, 'egreso', 'compra_insumo', new.id,
       new.costo_total, 'Compra de ' || v_insumo.nombre, coalesce(new.medio, 'efectivo'));
  end if;

  return null;
end;
$$;

drop trigger if exists compra_de_la_cocina on public.compra_insumo;
create trigger compra_de_la_cocina
  after insert on public.compra_insumo
  for each row execute function public.compra_de_la_cocina();

-- Una compra ya movió la caja: lo que la trabajadora reenvíe en el eco del
-- sync no la cambia. Corregir una compra es de administración.
create or replace function public.compra_congelada()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.es_admin() and coalesce(current_setting('request.jwt.claims', true), '') <> '' then
    new.insumo_id    := old.insumo_id;
    new.cantidad     := old.cantidad;
    new.costo_total  := old.costo_total;
    new.fecha        := old.fecha;
    new.medio        := old.medio;
    new.comprado_por := old.comprado_por;
  end if;
  return new;
end;
$$;

drop trigger if exists compra_congelada on public.compra_insumo;
create trigger compra_congelada
  before update on public.compra_insumo
  for each row execute function public.compra_congelada();

revoke execute on function public.compra_de_la_cocina(), public.compra_congelada()
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4 · Políticas: lo suyo, a su nombre
-- ---------------------------------------------------------------------------
--
-- "solo administracion escribe" sigue en pie para administración. Esto suma:
-- la trabajadora inserta compras a su nombre y ve solo las suyas (regla 8:
-- lo que compró otra persona no es de ella). El upsert del sync además pide
-- poder actualizar la propia; los campos los congela el trigger de arriba.
-- Borrar, no: una compra borrada deja un egreso sin compra.

drop policy if exists "las compras propias" on public.compra_insumo;
create policy "las compras propias"
  on public.compra_insumo for select to authenticated
  using (
    public.rol_actual() = 'trabajadora'
    and comprado_por in (select id from public.trabajadora where auth_user_id = auth.uid())
  );

drop policy if exists "compra a su nombre" on public.compra_insumo;
create policy "compra a su nombre"
  on public.compra_insumo for insert to authenticated
  with check (
    public.rol_actual() = 'trabajadora'
    and comprado_por in (select id from public.trabajadora where auth_user_id = auth.uid())
  );

drop policy if exists "el eco de la compra propia" on public.compra_insumo;
create policy "el eco de la compra propia"
  on public.compra_insumo for update to authenticated
  using (
    public.rol_actual() = 'trabajadora'
    and comprado_por in (select id from public.trabajadora where auth_user_id = auth.uid())
  )
  with check (
    public.rol_actual() = 'trabajadora'
    and comprado_por in (select id from public.trabajadora where auth_user_id = auth.uid())
  );
