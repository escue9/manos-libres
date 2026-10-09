-- El alta de producto y el precio de venta, guardados también en el servidor.
--
-- Octubre de 2026: cargarSemana suma productos_nuevos y precios. En el SO,
-- crearProducto() y guardarPrecio() exigen `editarPrecios`, que solo tiene la
-- administración (js/auth.js). Hasta acá eso vivía solo en el cliente: la
-- política "la cocina opera" (20260803_esquema_so.sql) deja escribir
-- `producto` a administración y trabajadora, porque vender descuenta stock, y
-- el trigger producto_costo() cuidaba el costo y la paga pero no el precio.
--
-- Por qué en el trigger y no en una política de INSERT solo para admin: el
-- replicador (js/sync.js) empuja con upsert (`on_conflict=id`), y en un upsert
-- Postgres evalúa el INSERT aunque la fila ya exista. Una política así
-- rompería el sync del stock desde el celular de una trabajadora.
--
-- Lo que cambia:
--   1. UPDATE: quien no es administración no mueve precio_venta. Un eco del
--      sync con un precio viejo tampoco lo pisa
--   2. INSERT: si la fila ya existe es un upsert y lo resuelve el UPDATE. Si es
--      un alta de verdad y no la hace la administración, se rechaza. Y el
--      costo y la paga que traiga se descartan para quien no puede fijarlos
--
-- Espejo de js/modules/produccion.js §crearProducto y §guardarPrecio.

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
    new.precio_venta    := old.precio_venta;
  end if;
  return new;
end;
$$;

drop trigger if exists producto_costo on public.producto;
create trigger producto_costo
  before insert or update on public.producto
  for each row execute function public.producto_costo();

revoke execute on function public.producto_costo() from public, anon, authenticated;
