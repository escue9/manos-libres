-- Fase 5 §3 — el costo lo pone el servidor.
--
-- Viene de la nota PENDIENTE de 20260803_esquema_so.sql: la regla 8 dice que
-- una trabajadora no ve costos, RLS filtra filas y no columnas, y el arreglo
-- (vistas sin las columnas de costo) chocaba con que la venta rápida que corre
-- ella misma escribe `pedido_item.costo_unitario` como snapshot. Quien no puede
-- leer un costo no lo puede calcular.
--
-- De las dos salidas — que el servidor llene el snapshot, o que la venta rápida
-- deje de andar sin conexión — se toma la primera. La segunda contradice la
-- regla 3: la cocina del CIC se queda sin internet y se vende igual.
--
-- Lo que hace este archivo:
--
--   1. traduce a SQL el costeo de js/calc.js (unidades, receta, costo efectivo)
--   2. llena del lado del servidor los tres snapshots que hoy calcula el
--      cliente: pedido_item.costo_unitario, produccion_item.costo_unitario_snapshot
--      y el costo de cierre de la orden
--   3. congela esos snapshots: una vez escritos no se reescriben (regla 4)
--
-- Lo que NO hace, y queda para cuando db.js hable Supabase: el `revoke` de las
-- columnas de costo. Ver la nota del final.
--
-- El criterio es siempre el mismo: si quien escribe ve costos, se respeta lo
-- que mandó; si no los ve, el número lo pone el servidor. Un cliente que no
-- puede leer costos manda 0, y un 0 nunca pisa un costo bueno.

-- ---------------------------------------------------------------------------
-- Unidades — espejo de js/calc.js §Unidades
-- ---------------------------------------------------------------------------
--
-- La base de masa es el gramo y la de volumen el mililitro, igual que allá.
-- La diferencia con el cliente es qué pasa cuando la conversión es imposible:
-- calc.js tira error, acá se devuelve null. Del lado del navegador un error
-- corta una pantalla; acá cortaría un sync, y un sync trabado no se destraba
-- solo. El null viaja hacia arriba como "no sé cuánto cuesta" y cada quien
-- decide qué hacer con eso.

create or replace function public.unidad_en_base(u text)
returns numeric
language sql immutable
set search_path = ''
as $$
  select case u
    when 'kg' then 1000 when 'g'  then 1
    when 'l'  then 1000 when 'ml' then 1
    when 'unidad' then 1
  end;
$$;

create or replace function public.familia_unidad(u text)
returns text
language sql immutable
set search_path = ''
as $$
  select case u
    when 'kg' then 'masa'    when 'g'  then 'masa'
    when 'l'  then 'volumen' when 'ml' then 'volumen'
    when 'unidad' then 'unidad'
  end;
$$;

/** Convierte entre unidades de la misma familia. null si no son compatibles. */
create or replace function public.convertir_unidad(cantidad numeric, desde text, hacia text)
returns numeric
language sql immutable
set search_path = ''
as $$
  select case
    when cantidad is null then null
    when desde is null or hacia is null or desde = hacia then cantidad
    when public.familia_unidad(desde) is distinct from public.familia_unidad(hacia) then null
    else cantidad * public.unidad_en_base(desde) / public.unidad_en_base(hacia)
  end;
$$;

-- ---------------------------------------------------------------------------
-- Costeo — espejo de js/calc.js §Costeo
-- ---------------------------------------------------------------------------
--
-- Estas funciones son `security definer` porque leen columnas de costo que
-- quien las dispara no tiene por qué poder leer. Es todo el punto del archivo.
-- Por eso también se les revoca el execute: si quedaran públicas, una
-- trabajadora las llamaría por RPC y tendría el costo de cada producto de a un
-- id por vez, que es exactamente lo que se está tapando. Las usan los triggers,
-- que corren con el permiso de su dueño y no necesitan el grant.

/**
 * Costo efectivo de un producto: el de receta si existe, si no el manual.
 * `nullif(x, 0)` reproduce el `||` de calc.costoEfectivo — un costo calculado
 * en 0 es una receta rota, no un producto gratis.
 */
create or replace function public.costo_efectivo_producto(p_producto uuid)
returns numeric
language sql stable security definer
set search_path = ''
as $$
  select coalesce(nullif(costo_calculado, 0), nullif(costo_manual, 0), 0)
  from public.producto where id = p_producto;
$$;

/**
 * Costo unitario a partir de la receta, con merma. null si no hay receta, si
 * no rinde, o si algún insumo no tiene costo cargado: un insumo sin costo no
 * vale cero, vale "todavía no sabemos" (calc.js §costoProducto).
 * La mano de obra NO entra acá — PDR §5.2.
 */
create or replace function public.costo_receta_producto(p_producto uuid)
returns numeric
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_rinde integer;
  v_costo numeric := 0;
  v_cant  numeric;
  r       record;
begin
  select rinde_por_lote into v_rinde from public.producto where id = p_producto;
  if coalesce(v_rinde, 0) = 0 then return null; end if;

  if not exists (select 1 from public.receta_item where producto_id = p_producto) then
    return null;
  end if;

  for r in
    select ri.cantidad, ri.unidad_medida, ri.merma_pct,
           i.unidad_medida as insumo_unidad, i.costo_unitario
      from public.receta_item ri
      join public.insumo i on i.id = ri.insumo_id
     where ri.producto_id = p_producto
  loop
    if coalesce(r.costo_unitario, 0) <= 0 then return null; end if;

    v_cant := public.convertir_unidad(
      r.cantidad, coalesce(r.unidad_medida, r.insumo_unidad), r.insumo_unidad);
    if v_cant is null then return null; end if;

    v_costo := v_costo + v_cant * (1 + coalesce(r.merma_pct, 0) / 100) * r.costo_unitario;
  end loop;

  return v_costo / v_rinde;
end;
$$;

/**
 * Costo de insumos de una orden, para el cierre.
 *
 * El insumo se descuenta por lo PLANIFICADO y no por lo que salió: si se
 * planificaron 48 empanadas y salieron 36, la harina de las 48 se usó igual.
 * Mismo criterio que produccion.js §cerrarOrden.
 *
 * Diferencia deliberada con el cliente: un insumo sin costo entra acá como 0,
 * mientras que allá la orden directamente no cierra. Cuando esto corre, la
 * orden ya se cerró en la cocina y está llegando por sync; plantarse dejaría
 * el sync trabado para siempre por una compra que falta cargar.
 */
create or replace function public.costo_insumos_orden(p_orden uuid)
returns numeric
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_total numeric := 0;
  v_cant  numeric;
  r       record;
begin
  for r in
    select ri.cantidad as receta_cantidad, ri.unidad_medida, ri.merma_pct,
           i.unidad_medida as insumo_unidad, coalesce(i.costo_unitario, 0) as costo_unitario,
           greatest(coalesce(pi.cantidad_real, pi.cantidad_planificada, 0),
                    coalesce(pi.cantidad_planificada, 0)) as producidas,
           coalesce(nullif(p.rinde_por_lote, 0), 1) as rinde
      from public.produccion_item pi
      join public.producto p     on p.id  = pi.producto_id
      join public.receta_item ri on ri.producto_id = pi.producto_id
      join public.insumo i       on i.id  = ri.insumo_id
     where pi.orden_produccion_id = p_orden
  loop
    v_cant := public.convertir_unidad(
      r.receta_cantidad, coalesce(r.unidad_medida, r.insumo_unidad), r.insumo_unidad);
    if v_cant is null then continue; end if;

    -- `producidas::numeric` y no a secas: los dos son integer y 36/24 daría 1
    -- lote en vez de 1,5 — la división entera de Postgres trunca.
    v_total := v_total
      + v_cant * (r.producidas::numeric / r.rinde)
        * (1 + coalesce(r.merma_pct, 0) / 100) * r.costo_unitario;
  end loop;

  return v_total;
end;
$$;

/** Jornadas confirmadas de la orden. La trabajadora no ve las de las demás. */
create or replace function public.costo_mano_obra_orden(p_orden uuid)
returns numeric
language sql stable security definer
set search_path = ''
as $$
  select coalesce(sum(tarifa_aplicada), 0)
  from public.jornada
  where orden_produccion_id = p_orden and confirmada;
$$;

revoke execute on function
  public.costo_efectivo_producto(uuid),
  public.costo_receta_producto(uuid),
  public.costo_insumos_orden(uuid),
  public.costo_mano_obra_orden(uuid)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Quién puede fijar un costo a mano
-- ---------------------------------------------------------------------------
--
-- Ve costos (admin, dirigente) o no viene de la API: una sesión directa —el
-- editor SQL, una migración, un backfill— no tiene claims de JWT. Sin esa
-- segunda mitad, arreglar un histórico a mano sería imposible: el trigger lo
-- revertiría en silencio.
--
-- El default de rol_actual() es 'trabajadora', así que una request sin rol en
-- el token cae del lado seguro: el costo lo pone el servidor.

create or replace function public.puede_fijar_costos()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(current_setting('request.jwt.claims', true), '') = ''
      or public.ve_numeros();
$$;

-- ---------------------------------------------------------------------------
-- pedido_item — el snapshot de la venta
-- ---------------------------------------------------------------------------
--
-- Al insertar: si quien vende no ve costos, o mandó 0, el costo lo pone el
-- servidor con el mismo criterio que calc.costoEfectivo.
--
-- Hay un desfase conocido y aceptado: un pedido cargado sin conexión y
-- sincronizado tres días después congela el costo del día en que llegó, no el
-- del día en que se vendió. Se elige eso antes que dejar el snapshot en 0, que
-- sería un margen del 100% en el histórico. El desfase está acotado por cuánto
-- tarda el celular en volver a tener señal, y solo aplica a quien no ve costos:
-- lo que carga la administración viaja con el costo del momento.
--
-- Al actualizar: no se toca más (regla 4). Un cliente sin costos reenvía la
-- fila con 0 y eso se ignora en silencio, porque es eco de sync y no una
-- decisión de nadie. Un cambio deliberado, en cambio, corta: el margen
-- histórico no se reescribe.
--
-- El precio no tiene ni siquiera la salida del `puede_fijar_costos()`: corregir
-- a mano el precio de algo ya vendido exige desactivar el trigger a propósito.
-- Está bien que cueste — es la fila que sostiene el margen de esa semana.

create or replace function public.pedido_item_costo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not public.puede_fijar_costos() or coalesce(new.costo_unitario, 0) = 0 then
      new.costo_unitario := coalesce(public.costo_efectivo_producto(new.producto_id), 0);
    end if;
    return new;
  end if;

  if new.producto_id is distinct from old.producto_id then
    raise exception 'pedido_item: el producto de una línea vendida no se cambia (regla 4)';
  end if;

  if new.precio_unitario is distinct from old.precio_unitario then
    raise exception 'pedido_item.precio_unitario se congela al vender (regla 4)';
  end if;

  if new.costo_unitario is distinct from old.costo_unitario then
    if coalesce(new.costo_unitario, 0) = 0 or not public.puede_fijar_costos() then
      new.costo_unitario := old.costo_unitario;
    else
      raise exception 'pedido_item.costo_unitario se congela al vender (regla 4)';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists pedido_item_costo on public.pedido_item;
create trigger pedido_item_costo
  before insert or update on public.pedido_item
  for each row execute function public.pedido_item_costo();

-- ---------------------------------------------------------------------------
-- produccion_item — el snapshot de la producción
-- ---------------------------------------------------------------------------
--
-- Nace en null y se congela cuando la orden registra producción real, que es
-- justo lo que hace el cierre. El orden de preferencia es el mismo del cliente:
-- receta primero, costo efectivo si la receta no alcanza.

create or replace function public.produccion_item_costo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- El if anidado no es adorno: en un trigger de INSERT `old` no está
  -- asignado, y meterlo en el mismo `and` que el tg_op lo expone igual —
  -- Postgres no promete evaluar la condición de izquierda a derecha.
  if tg_op = 'UPDATE' then
    -- Ya congelado: no se vuelve a tocar (regla 4).
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
    new.costo_unitario_snapshot := coalesce(
      public.costo_receta_producto(new.producto_id),
      public.costo_efectivo_producto(new.producto_id));
  end if;

  return new;
end;
$$;

drop trigger if exists produccion_item_costo on public.produccion_item;
create trigger produccion_item_costo
  before insert or update on public.produccion_item
  for each row execute function public.produccion_item_costo();

-- ---------------------------------------------------------------------------
-- orden_produccion — el costo del cierre
-- ---------------------------------------------------------------------------
--
-- La mano de obra se recalcula siempre que la cierre alguien que no ve la
-- caja, no solo cuando viene vacía: una trabajadora ve sus propias jornadas y
-- ninguna otra, así que su cliente suma bien lo que ve y manda un número que
-- es correcto para ella y falso para la orden. Es el mismo agujero que el
-- costo, con otra cara.

create or replace function public.orden_produccion_costo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.estado <> 'cerrada' or old.estado = 'cerrada' then
    return new;
  end if;

  if coalesce(new.costo_insumos, 0) = 0 or not public.puede_fijar_costos() then
    new.costo_insumos := public.costo_insumos_orden(new.id);
  end if;

  if coalesce(new.costo_mano_obra, 0) = 0 or not public.puede_fijar_costos() then
    new.costo_mano_obra := public.costo_mano_obra_orden(new.id);
  end if;

  return new;
end;
$$;

drop trigger if exists orden_produccion_costo on public.orden_produccion;
create trigger orden_produccion_costo
  before update on public.orden_produccion
  for each row execute function public.orden_produccion_costo();

-- ---------------------------------------------------------------------------
-- Las funciones de trigger tampoco son API
-- ---------------------------------------------------------------------------
--
-- Sin esto quedan publicadas en /rest/v1/rpc. Llamarlas sueltas ya moría con
-- "trigger functions can only be called as triggers", así que no tapa un
-- agujero: saca la advertencia del linter de Supabase y deja dicho que no son
-- un endpoint. Postgres chequea el execute al CREAR el trigger y no cada vez
-- que dispara — revocarlo no los apaga, y está probado que siguen andando
-- entrando como `authenticated`.

revoke execute on function
  public.pedido_item_costo(),
  public.produccion_item_costo(),
  public.orden_produccion_costo()
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Lo que falta para cerrar la regla 8 del lado del servidor
-- ---------------------------------------------------------------------------
--
-- Con los snapshots resueltos acá, esconder los costos ya no rompe la venta
-- rápida ni el cierre de orden. Lo que queda es una sola cosa:
--
--   revoke select (costo_unitario)                on public.insumo    from authenticated;
--   revoke select (costo_calculado, costo_manual) on public.producto  from authenticated;
--   revoke select (costo_unitario)                on public.pedido_item from authenticated;
--   ...y lo mismo en produccion_item y orden_produccion
--
-- No se aplica todavía porque el día que se aplique, `select *` sobre esas
-- tablas empieza a devolver 42501 para todo el mundo — también para la
-- administración, porque en Supabase todos los usuarios entran con el mismo
-- rol de Postgres (`authenticated`) y los permisos de columna no distinguen
-- entre ellos. La administración pasa entonces a leer los costos por vistas
-- `security definer` filtradas con ve_numeros(), y db.js —que hoy es
-- IndexedDB y todavía no hace ningún select contra Postgres— tiene que pedir
-- columnas explícitas en vez de `*`.
--
-- Es decir: el revoke y las vistas van con el motor Supabase de db.js, en la
-- misma migración, o rompen la app a mitad de camino. Hasta entonces el
-- agujero sigue siendo el que ya estaba documentado — la interfaz esconde los
-- costos y la consola del navegador los muestra — pero ya no hay nada de
-- diseño trabándolo.
