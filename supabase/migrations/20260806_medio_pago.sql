-- Medio de pago del canal online — transferencia (con comprobante) o efectivo.
-- Ver docs/BRIEF-CANAL-ONLINE.md. No hay pasarela de pago automática: nadie
-- puede confirmar una transferencia ni un pago en efectivo sin que una
-- persona lo mire, así que el pedido sigue entrando al buzón como antes.
-- Lo único que cambia es que ahora llega con el medio de pago y, si es
-- transferencia, el comprobante adjunto — quien lo revise no tiene que
-- perseguir nada aparte por WhatsApp.

alter table public.pedido_web
  add column if not exists medio_pago text,
  add column if not exists comprobante_path text;

alter table public.pedido_web
  add constraint pedido_web_medio_pago_valido
    check (medio_pago in ('transferencia', 'efectivo'));

alter table public.pedido_web
  add constraint pedido_web_comprobante_si_transferencia
    check (medio_pago <> 'transferencia' or comprobante_path is not null);

-- El grant de columnas de antes no incluía estas dos: sin actualizarlo, un
-- insert de anon que las mande se rechaza entero.
grant insert (id, nombre, telefono, modo_entrega, direccion,
              fecha_deseada, notas, items, total, medio_pago, comprobante_path)
  on public.pedido_web to anon;

-- ---------------------------------------------------------------------------
-- Storage — comprobantes de transferencia
-- ---------------------------------------------------------------------------
--
-- Bucket privado: anon puede SUBIR (insert), no puede LISTAR ni LEER. Mismo
-- modelo de amenaza que pedido_web — es un buzón, no una carpeta pública.
-- El SO (authenticated) lee para poder verificar el pago antes de aceptar el
-- pedido.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comprobantes', 'comprobantes', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "comprobantes: anon sube" on storage.objects;
create policy "comprobantes: anon sube"
  on storage.objects for insert to anon
  with check (bucket_id = 'comprobantes');

drop policy if exists "comprobantes: el SO lee" on storage.objects;
create policy "comprobantes: el SO lee"
  on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes');

-- Nadie borra. Un comprobante es un registro de que alguien pagó — igual que
-- pedido_web, se queda aunque el pedido se descarte.
