-- Fase 5 — las 18 tablas del SO en Postgres.
--
-- Traducción directa del modelo de docs/PDR.md §3, que se diseñó relacional
-- justamente para que esta migración fuera mecánica. Los enum van como check
-- constraints y no como tipos enum: agregar un valor a un check es un ALTER de
-- un segundo, y a un tipo enum es una migración con downtime.
--
-- IndexedDB SIGUE SIENDO la fuente de verdad en el cliente (regla 3). Esto es
-- el espejo remoto contra el que sincroniza, no el reemplazo.
--
-- La identidad es por trabajadora: `trabajadora.auth_user_id` apunta a
-- auth.users y las políticas filtran por ahí. Sin eso la regla 8 sería una
-- convención de la interfaz y no una garantía del servidor.

-- ---------------------------------------------------------------------------
-- Quién es quien pregunta
-- ---------------------------------------------------------------------------
--
-- El rol viaja en el JWT, en app_metadata. Lo pone la administración al dar de
-- alta al usuario y el cliente NO puede modificarlo — user_metadata sí sería
-- editable por el propio usuario, y ahí cualquiera se haría admin.

create or replace function public.rol_actual()
returns text
language sql stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'rol', ''),
    'trabajadora'
  );
$$;

create or replace function public.es_admin()
returns boolean
language sql stable
set search_path = ''
as $$
  select public.rol_actual() = 'admin';
$$;

/** Puede ver plata: costos, márgenes, caja. Admin y comisión. */
create or replace function public.ve_numeros()
returns boolean
language sql stable
set search_path = ''
as $$
  select public.rol_actual() in ('admin', 'dirigente');
$$;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------

create table if not exists public.unidad_negocio (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  tipo        text not null default 'alimentos'
              check (tipo in ('alimentos', 'carpinteria', 'herreria')),
  activa      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.trabajadora (
  id                uuid primary key default gen_random_uuid(),
  unidad_negocio_id uuid references public.unidad_negocio(id) on delete restrict,
  -- La identidad de Supabase. Nullable porque una trabajadora puede estar
  -- cargada antes de que se le cree el usuario.
  auth_user_id      uuid unique references auth.users(id) on delete set null,
  nombre            text not null,
  telefono          text,
  tarifa_dia        numeric not null default 0 check (tarifa_dia >= 0),
  fecha_ingreso     date,
  activa            boolean not null default true,
  pin_acceso        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.tarifa_historica (
  id             uuid primary key default gen_random_uuid(),
  trabajadora_id uuid not null references public.trabajadora(id) on delete cascade,
  tarifa_dia     numeric not null check (tarifa_dia >= 0),
  vigente_desde  date not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.insumo (
  id                 uuid primary key default gen_random_uuid(),
  unidad_negocio_id  uuid references public.unidad_negocio(id) on delete restrict,
  nombre             text not null,
  categoria          text,
  unidad_medida      text not null default 'unidad'
                     check (unidad_medida in ('kg', 'g', 'l', 'ml', 'unidad')),
  costo_unitario     numeric not null default 0 check (costo_unitario >= 0),
  stock_actual       numeric not null default 0,
  stock_minimo       numeric not null default 0,
  proveedor_habitual text,
  activo             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.producto (
  id                uuid primary key default gen_random_uuid(),
  unidad_negocio_id uuid references public.unidad_negocio(id) on delete restrict,
  nombre            text not null,
  categoria         text,
  unidad_venta      text not null default 'unidad'
                    check (unidad_venta in ('unidad', 'docena', 'kg', 'combo')),
  precio_venta      numeric not null default 0 check (precio_venta >= 0),
  costo_calculado   numeric check (costo_calculado >= 0),
  costo_manual      numeric check (costo_manual >= 0),
  stock_actual      integer not null default 0,
  stock_minimo      integer not null default 0,
  rinde_por_lote    integer not null default 1 check (rinde_por_lote > 0),
  activo            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.receta_item (
  id            uuid primary key default gen_random_uuid(),
  producto_id   uuid not null references public.producto(id) on delete cascade,
  insumo_id     uuid not null references public.insumo(id) on delete restrict,
  cantidad      numeric not null check (cantidad > 0),
  unidad_medida text not null check (unidad_medida in ('kg', 'g', 'l', 'ml', 'unidad')),
  merma_pct     numeric not null default 0 check (merma_pct >= 0 and merma_pct <= 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.compra_insumo (
  id          uuid primary key default gen_random_uuid(),
  insumo_id   uuid not null references public.insumo(id) on delete restrict,
  fecha       date not null,
  cantidad    numeric not null check (cantidad > 0),
  costo_total numeric not null check (costo_total >= 0),
  proveedor   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.orden_produccion (
  id                uuid primary key default gen_random_uuid(),
  unidad_negocio_id uuid references public.unidad_negocio(id) on delete restrict,
  fecha             date not null,
  estado            text not null default 'planificada'
                    check (estado in ('planificada', 'en_curso', 'cerrada', 'cancelada')),
  costo_insumos     numeric,
  costo_mano_obra   numeric,
  notas             text,
  cerrada_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.produccion_item (
  id                     uuid primary key default gen_random_uuid(),
  orden_produccion_id    uuid not null references public.orden_produccion(id) on delete cascade,
  producto_id            uuid not null references public.producto(id) on delete restrict,
  cantidad_planificada   integer not null default 0,
  cantidad_real          integer,
  -- Congelado al producir: si mañana sube la harina, el margen de hoy no cambia
  costo_unitario_snapshot numeric,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table if not exists public.cliente (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  telefono   text,
  direccion  text,
  tipo       text not null default 'particular'
             check (tipo in ('particular', 'club', 'institucion', 'revendedor')),
  notas      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pedido (
  id                uuid primary key default gen_random_uuid(),
  unidad_negocio_id uuid references public.unidad_negocio(id) on delete restrict,
  cliente_id        uuid references public.cliente(id) on delete set null,
  canal             text not null default 'otro'
                    check (canal in ('whatsapp', 'instagram', 'catalogo_web',
                                     'mostrador_cic', 'mostrador_uncas', 'otro')),
  modo_entrega      text not null default 'retira_cic'
                    check (modo_entrega in ('en_el_acto', 'retira_cic', 'domicilio')),
  direccion_entrega text,
  costo_envio       numeric not null default 0 check (costo_envio >= 0),
  origen_web_id     uuid references public.pedido_web(id) on delete set null,
  fecha_pedido      date not null,
  fecha_entrega     date,
  estado            text not null default 'pendiente'
                    check (estado in ('pendiente', 'confirmado', 'en_produccion',
                                      'listo', 'entregado', 'cancelado')),
  total             numeric not null default 0,
  descuento         numeric not null default 0 check (descuento >= 0),
  monto_cobrado     numeric not null default 0 check (monto_cobrado >= 0),
  estado_pago       text not null default 'impago'
                    check (estado_pago in ('impago', 'sena', 'pagado')),
  notas             text,
  es_mostrador      boolean not null default false,
  created_by        uuid references public.trabajadora(id) on delete set null,
  created_by_rol    text check (created_by_rol in ('admin', 'trabajadora', 'dirigente')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint pedido_domicilio_con_direccion
    check (modo_entrega <> 'domicilio' or direccion_entrega is not null)
);

-- Un pedido_web se importa una sola vez.
create unique index if not exists pedido_origen_web_idx
  on public.pedido (origen_web_id) where origen_web_id is not null;

create table if not exists public.pedido_item (
  id              uuid primary key default gen_random_uuid(),
  pedido_id       uuid not null references public.pedido(id) on delete cascade,
  producto_id     uuid not null references public.producto(id) on delete restrict,
  cantidad        numeric not null check (cantidad > 0),
  precio_unitario numeric not null check (precio_unitario >= 0),
  costo_unitario  numeric not null default 0 check (costo_unitario >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.cobro (
  id         uuid primary key default gen_random_uuid(),
  pedido_id  uuid not null references public.pedido(id) on delete cascade,
  fecha      date not null,
  monto      numeric not null check (monto > 0),
  medio      text not null default 'efectivo'
             check (medio in ('efectivo', 'transferencia', 'mercadopago', 'otro')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.jornada (
  id                  uuid primary key default gen_random_uuid(),
  trabajadora_id      uuid not null references public.trabajadora(id) on delete cascade,
  fecha               date not null,
  orden_produccion_id uuid references public.orden_produccion(id) on delete set null,
  tarifa_aplicada     numeric not null default 0 check (tarifa_aplicada >= 0),
  origen_carga        text not null default 'admin'
                      check (origen_carga in ('admin', 'autoreporte')),
  confirmada          boolean not null default true,
  estado_pago         text not null default 'pendiente'
                      check (estado_pago in ('pendiente', 'pagada')),
  fecha_pago          date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Una jornada por día por persona. Sin esto, dos taps desde dos dispositivos
  -- pagan el mismo día dos veces.
  constraint jornada_unica_por_dia unique (trabajadora_id, fecha)
);

create table if not exists public.movimiento_caja (
  id                uuid primary key default gen_random_uuid(),
  unidad_negocio_id uuid references public.unidad_negocio(id) on delete restrict,
  fecha             date not null,
  tipo              text not null check (tipo in ('ingreso', 'egreso')),
  origen            text not null
                    check (origen in ('cobro', 'compra_insumo', 'jornal',
                                      'gasto_operativo', 'aporte', 'retiro')),
  -- Polimórfico a propósito: apunta al cobro, la compra o la jornada que lo
  -- originó. Sin FK porque son tres tablas distintas.
  referencia_id     uuid,
  monto             numeric not null check (monto > 0),
  descripcion       text,
  categoria_gasto   text,
  medio             text check (medio in ('efectivo', 'transferencia', 'mercadopago')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint caja_rubro_solo_en_gastos
    check (categoria_gasto is null or origen = 'gasto_operativo')
);

create table if not exists public.movimiento_stock_insumo (
  id            uuid primary key default gen_random_uuid(),
  insumo_id     uuid not null references public.insumo(id) on delete cascade,
  fecha         timestamptz not null default now(),
  tipo          text not null check (tipo in ('compra', 'produccion', 'ajuste', 'merma')),
  cantidad      numeric not null,
  referencia_id uuid,
  motivo        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Regla 7: un ajuste a mano siempre dice por qué.
  constraint stock_insumo_ajuste_con_motivo
    check (tipo <> 'ajuste' or motivo is not null)
);

create table if not exists public.movimiento_stock_producto (
  id            uuid primary key default gen_random_uuid(),
  producto_id   uuid not null references public.producto(id) on delete cascade,
  fecha         timestamptz not null default now(),
  tipo          text not null check (tipo in ('produccion', 'venta', 'ajuste', 'merma')),
  cantidad      numeric not null,
  referencia_id uuid,
  motivo        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint stock_producto_ajuste_con_motivo
    check (tipo <> 'ajuste' or motivo is not null)
);

create table if not exists public.config (
  id         uuid primary key default gen_random_uuid(),
  clave      text not null unique,
  valor      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Índices — los mismos filtros que ya usa el cliente
-- ---------------------------------------------------------------------------

create index if not exists insumo_un_idx            on public.insumo (unidad_negocio_id, categoria);
create index if not exists producto_un_idx          on public.producto (unidad_negocio_id, categoria);
create index if not exists receta_producto_idx      on public.receta_item (producto_id);
create index if not exists compra_insumo_idx        on public.compra_insumo (insumo_id, fecha);
create index if not exists orden_fecha_idx          on public.orden_produccion (fecha, estado);
create index if not exists produccion_item_idx      on public.produccion_item (orden_produccion_id);
create index if not exists cliente_telefono_idx     on public.cliente (telefono);
create index if not exists pedido_estado_idx        on public.pedido (estado, fecha_entrega);
create index if not exists pedido_cliente_idx       on public.pedido (cliente_id);
create index if not exists pedido_item_pedido_idx   on public.pedido_item (pedido_id);
create index if not exists cobro_pedido_idx         on public.cobro (pedido_id);
create index if not exists jornada_trabajadora_idx  on public.jornada (trabajadora_id, fecha);
create index if not exists caja_fecha_idx           on public.movimiento_caja (fecha, origen);
create index if not exists stock_insumo_idx         on public.movimiento_stock_insumo (insumo_id, fecha);
create index if not exists stock_producto_idx       on public.movimiento_stock_producto (producto_id, fecha);

-- ---------------------------------------------------------------------------
-- updated_at automático — el sync se apoya en él para resolver conflictos
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'unidad_negocio','trabajadora','tarifa_historica','insumo','producto','receta_item',
    'compra_insumo','orden_produccion','produccion_item','cliente','pedido','pedido_item',
    'cobro','jornada','movimiento_caja','movimiento_stock_insumo','movimiento_stock_producto','config'
  ] loop
    execute format('drop trigger if exists %I_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_updated_at before update on public.%I
       for each row execute function public.tocar_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS — espeja PERMISOS de js/auth.js
-- ---------------------------------------------------------------------------
--
-- PENDIENTE, y hay que decidirlo antes de poner esto en producción: lo que
-- sigue protege a nivel de FILA. Las jornadas, las tarifas y la caja quedan
-- realmente cerradas. Los COSTOS no: `insumo.costo_unitario`,
-- `producto.costo_calculado/costo_manual` y `pedido_item.costo_unitario` viven
-- en tablas que la cocina necesita leer para trabajar, y RLS filtra filas, no
-- columnas.
--
-- La interfaz ya los esconde, así que el agujero es "una trabajadora que abre
-- la consola del navegador", no algo que pase sin querer. Pero la regla 8 dice
-- que no los ve, y hoy no es el servidor el que lo garantiza.
--
-- Se arregla con vistas sin las columnas de costo, y ahí aparecía el problema
-- de fondo: la venta rápida que corre una trabajadora escribe
-- `pedido_item.costo_unitario` como snapshot; si no puede leer costos, no lo
-- puede calcular. DECIDIDO en 20260804_costos_servidor.sql: el snapshot lo
-- llena el servidor. La venta rápida sigue andando sin conexión, que es la
-- regla 3, y la cocina ya no necesita leer un costo para vender.
--
-- Queda pendiente solo la otra mitad —el `revoke` de las columnas y las vistas
-- para la administración—, que va junto con el motor Supabase de db.js porque
-- rompe `select *`. Está explicado al final de ese archivo.

do $$
declare t text;
begin
  foreach t in array array[
    'unidad_negocio','trabajadora','tarifa_historica','insumo','producto','receta_item',
    'compra_insumo','orden_produccion','produccion_item','cliente','pedido','pedido_item',
    'cobro','jornada','movimiento_caja','movimiento_stock_insumo','movimiento_stock_producto','config'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    -- anon no toca NADA del SO. Lo único público es el catálogo.
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

/* --- Lo que todo el mundo autenticado puede leer y operar --- */
-- Producción y ventas son el trabajo diario de la cocina: una trabajadora
-- carga órdenes, vende, entrega y cobra. Eso incluye escribir stock.

do $$
declare t text;
begin
  foreach t in array array[
    'unidad_negocio','insumo','producto','receta_item','orden_produccion',
    'produccion_item','cliente','pedido','pedido_item','cobro',
    'movimiento_stock_insumo','movimiento_stock_producto','config'
  ] loop
    execute format('drop policy if exists "lectura del equipo" on public.%I', t);
    execute format(
      'create policy "lectura del equipo" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- Escribir: la cocina sí, la comisión no. "La comisión mira, no opera".
do $$
declare t text;
begin
  foreach t in array array[
    'insumo','producto','orden_produccion','produccion_item','cliente','pedido',
    'pedido_item','cobro','movimiento_stock_insumo','movimiento_stock_producto'
  ] loop
    execute format('drop policy if exists "la cocina opera" on public.%I', t);
    execute format(
      'create policy "la cocina opera" on public.%I for all to authenticated
       using (public.rol_actual() in (''admin'', ''trabajadora''))
       with check (public.rol_actual() in (''admin'', ''trabajadora''))', t);
  end loop;
end $$;

-- Recetas, compras y config: solo administración. Una receta define el costo.
do $$
declare t text;
begin
  foreach t in array array['receta_item','compra_insumo','unidad_negocio','config'] loop
    execute format('drop policy if exists "solo administracion escribe" on public.%I', t);
    execute format(
      'create policy "solo administracion escribe" on public.%I for all to authenticated
       using (public.es_admin()) with check (public.es_admin())', t);
  end loop;
end $$;

/* --- movimiento_caja: la trabajadora no ve la caja (regla 8) --- */

drop policy if exists "la caja es de administracion" on public.movimiento_caja;
create policy "la caja es de administracion"
  on public.movimiento_caja for select to authenticated
  using (public.ve_numeros());

drop policy if exists "solo administracion mueve la caja" on public.movimiento_caja;
create policy "solo administracion mueve la caja"
  on public.movimiento_caja for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

/* --- trabajadora y jornada: la parte delicada de la regla 8 --- */

-- Una trabajadora se ve a sí misma. No ve el nombre, la tarifa ni los días de
-- las demás. La administración y la comisión ven a todas.
drop policy if exists "cada una se ve a si misma" on public.trabajadora;
create policy "cada una se ve a si misma"
  on public.trabajadora for select to authenticated
  using (public.ve_numeros() or auth_user_id = auth.uid());

drop policy if exists "solo administracion gestiona el equipo" on public.trabajadora;
create policy "solo administracion gestiona el equipo"
  on public.trabajadora for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

drop policy if exists "las jornadas propias" on public.jornada;
create policy "las jornadas propias"
  on public.jornada for select to authenticated
  using (
    public.ve_numeros()
    or trabajadora_id in (select id from public.trabajadora where auth_user_id = auth.uid())
  );

-- Puede autorreportarse un día, pero entra sin confirmar y sin tarifa: quien
-- confirma y quien pone el precio del día es la administración.
drop policy if exists "autoreporte propio" on public.jornada;
create policy "autoreporte propio"
  on public.jornada for insert to authenticated
  with check (
    public.es_admin()
    or (
      trabajadora_id in (select id from public.trabajadora where auth_user_id = auth.uid())
      and origen_carga = 'autoreporte'
      and confirmada = false
      and estado_pago = 'pendiente'
    )
  );

-- Borrar el propio día sin confirmar es deshacer un tap. Una jornada
-- confirmada o pagada ya movió la caja: la toca la administración.
drop policy if exists "deshacer el propio autoreporte" on public.jornada;
create policy "deshacer el propio autoreporte"
  on public.jornada for delete to authenticated
  using (
    public.es_admin()
    or (
      trabajadora_id in (select id from public.trabajadora where auth_user_id = auth.uid())
      and confirmada = false
      and estado_pago = 'pendiente'
    )
  );

drop policy if exists "solo administracion confirma y paga" on public.jornada;
create policy "solo administracion confirma y paga"
  on public.jornada for update to authenticated
  using (public.es_admin()) with check (public.es_admin());

-- La tarifa de otra no se ve nunca.
drop policy if exists "la tarifa propia" on public.tarifa_historica;
create policy "la tarifa propia"
  on public.tarifa_historica for select to authenticated
  using (
    public.ve_numeros()
    or trabajadora_id in (select id from public.trabajadora where auth_user_id = auth.uid())
  );

drop policy if exists "solo administracion fija tarifas" on public.tarifa_historica;
create policy "solo administracion fija tarifas"
  on public.tarifa_historica for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
