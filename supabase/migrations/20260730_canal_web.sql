-- Canal de venta online — las dos tablas que hacen de buzón entre el catálogo
-- público y el SO. Ver docs/BRIEF-CANAL-ONLINE.md.
--
-- Esto NO es la migración de la Fase 5. Producción, stock, jornadas y caja
-- siguen viviendo en IndexedDB. Acá solo está lo que necesita ser compartido
-- entre el celular de un cliente y la cocina.
--
-- El modelo de amenaza es simple: el link es público y la anon key viaja en el
-- cliente. La seguridad la da RLS, no esconder la key. Todo lo que sigue parte
-- de asumir que cualquiera puede mandar cualquier cosa a este endpoint.

-- ---------------------------------------------------------------------------
-- catalogo_item — lo que se publica
-- ---------------------------------------------------------------------------

create table if not exists public.catalogo_item (
  id            uuid primary key default gen_random_uuid(),
  -- id del producto en el SO. No es FK: el SO es otra base. Sirve para mapear
  -- el ítem al importar el pedido sin tener que adivinar por nombre.
  producto_id   uuid,
  nombre        text        not null,
  descripcion   text,
  categoria     text,
  precio        numeric     not null,
  unidad_venta  text,
  foto_url      text,
  orden         int         not null default 0,
  activo        boolean     not null default true,
  updated_at    timestamptz not null default now(),

  constraint catalogo_nombre_razonable
    check (char_length(nombre) between 1 and 120),
  constraint catalogo_precio_no_negativo
    check (precio >= 0),
  constraint catalogo_descripcion_acotada
    check (descripcion is null or char_length(descripcion) <= 300),
  constraint catalogo_unidad_valida
    check (unidad_venta is null or unidad_venta in ('unidad', 'docena', 'kg', 'combo'))
);

-- La consulta del catálogo público es siempre la misma: lo activo, ordenado.
create index if not exists catalogo_item_publicado_idx
  on public.catalogo_item (categoria, orden)
  where activo;

-- Un producto del SO se publica una sola vez: sin esto, tocar "publicar" dos
-- veces deja el mismo producto duplicado en el catálogo.
create unique index if not exists catalogo_item_producto_idx
  on public.catalogo_item (producto_id)
  where producto_id is not null;

create or replace function public.tocar_updated_at()
returns trigger
language plpgsql
-- search_path vacío a propósito: una función sin él puede ser secuestrada
-- creando un objeto con el mismo nombre en un esquema que venga antes.
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists catalogo_item_updated_at on public.catalogo_item;
create trigger catalogo_item_updated_at
  before update on public.catalogo_item
  for each row execute function public.tocar_updated_at();

-- ---------------------------------------------------------------------------
-- pedido_web — buzón de entrada
-- ---------------------------------------------------------------------------
--
-- El pedido web NO es un pedido. Es una solicitud que alguien de administración
-- tiene que leer antes de que exista en el SO. Por eso vive suelto acá y no
-- toca stock ni caja.

create table if not exists public.pedido_web (
  id             uuid primary key default gen_random_uuid(),
  creado_at      timestamptz not null default now(),
  nombre         text        not null,
  telefono       text        not null,
  modo_entrega   text        not null,
  direccion      text,
  fecha_deseada  date,
  notas          text,
  -- [{ catalogo_item_id, producto_id, nombre, cantidad, precio }]
  items          jsonb       not null,
  total          numeric     not null,
  estado         text        not null default 'nuevo',
  -- id del pedido del SO una vez importado. Tampoco es FK, por lo mismo.
  pedido_id      uuid,
  procesado_at   timestamptz,
  motivo_descarte text,

  constraint pedido_web_modo_valido
    check (modo_entrega in ('retira_cic', 'domicilio')),
  constraint pedido_web_estado_valido
    check (estado in ('nuevo', 'importado', 'descartado')),

  -- Validaciones de la base. Son la última línea, no la primera: el formulario
  -- valida antes y mejor. Estas existen porque el endpoint es público y nadie
  -- está obligado a usar el formulario.
  constraint pedido_web_nombre_razonable
    check (char_length(btrim(nombre)) between 2 and 80),
  -- 10 dígitos sin 0 ni 15: así lo normaliza el SO (soloDigitos en pedidos.js)
  constraint pedido_web_telefono_valido
    check (telefono ~ '^[0-9]{10}$'),
  constraint pedido_web_total_razonable
    check (total >= 0 and total <= 10000000),
  constraint pedido_web_items_razonables
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 50),
  constraint pedido_web_direccion_si_domicilio
    check (modo_entrega <> 'domicilio'
           or (direccion is not null and char_length(btrim(direccion)) >= 5)),
  constraint pedido_web_direccion_acotada
    check (direccion is null or char_length(direccion) <= 200),
  constraint pedido_web_notas_acotadas
    check (notas is null or char_length(notas) <= 500),

  -- Un pedido importado tiene que decir a qué pedido del SO fue a parar, y uno
  -- nuevo no puede tener uno. Sin esto, un bug de importación deja el buzón
  -- diciendo "importado" sin que exista el pedido, y nadie lo cocina.
  constraint pedido_web_procesado_coherente
    check (
      (estado = 'nuevo'      and pedido_id is null and procesado_at is null)
      or (estado = 'importado'  and pedido_id is not null and procesado_at is not null)
      or (estado = 'descartado' and pedido_id is null and procesado_at is not null)
    )
);

-- La pantalla de revisión pide siempre lo mismo: los nuevos, más viejo primero.
create index if not exists pedido_web_pendientes_idx
  on public.pedido_web (creado_at)
  where estado = 'nuevo';

-- Para no importar dos veces el mismo pedido_web contra dos pedidos distintos.
create unique index if not exists pedido_web_pedido_idx
  on public.pedido_web (pedido_id)
  where pedido_id is not null;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.catalogo_item enable row level security;
alter table public.pedido_web    enable row level security;

-- Supabase le da permisos amplios a anon y authenticated por defecto sobre lo
-- que se cree en public. Se los sacamos y se devuelve solo lo necesario.
revoke all on public.catalogo_item from anon, authenticated;
revoke all on public.pedido_web    from anon, authenticated;

-- --- catalogo_item ---

grant select on public.catalogo_item to anon;

drop policy if exists "catalogo publico: solo lo activo" on public.catalogo_item;
create policy "catalogo publico: solo lo activo"
  on public.catalogo_item for select to anon
  using (activo);

grant select, insert, update, delete on public.catalogo_item to authenticated;

drop policy if exists "el SO administra el catalogo" on public.catalogo_item;
create policy "el SO administra el catalogo"
  on public.catalogo_item for all to authenticated
  using (true) with check (true);

-- --- pedido_web ---
--
-- anon INSERT y nada más. Si anon pudiera leer, cualquiera con el link vería
-- los pedidos, los teléfonos y las direcciones de todos los clientes.
--
-- El grant es por columna a propósito: `estado`, `pedido_id`, `procesado_at` y
-- `creado_at` no están en la lista, así que un cliente no puede mandar un
-- pedido ya marcado como importado para que nadie lo revise, ni falsear la
-- fecha. Toman su default sí o sí.

grant insert (id, nombre, telefono, modo_entrega, direccion,
              fecha_deseada, notas, items, total)
  on public.pedido_web to anon;

drop policy if exists "buzon: anon solo deposita" on public.pedido_web;
create policy "buzon: anon solo deposita"
  on public.pedido_web for insert to anon
  with check (estado = 'nuevo' and pedido_id is null and procesado_at is null);

-- Sin política de SELECT para anon: PostgREST va a rechazar cualquier lectura.
-- Por eso el insert del catálogo manda `Prefer: return=minimal` y el id lo
-- genera el cliente, para poder mostrar el número de pedido sin leer nada.

grant select, update on public.pedido_web to authenticated;

drop policy if exists "el SO lee el buzon" on public.pedido_web;
create policy "el SO lee el buzon"
  on public.pedido_web for select to authenticated
  using (true);

drop policy if exists "el SO procesa el buzon" on public.pedido_web;
create policy "el SO procesa el buzon"
  on public.pedido_web for update to authenticated
  using (true) with check (true);

-- Nadie tiene DELETE sobre pedido_web, ni siquiera el SO. Un pedido descartado
-- se marca, no se borra: si mañana el cliente reclama, tiene que estar.
