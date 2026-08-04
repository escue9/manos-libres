-- Fase 5 §4.1 — la identidad.
--
-- Hasta acá el RLS de 20260803_esquema_so.sql filtra por `auth.uid()` y por el
-- rol que viaja en `app_metadata`, pero no había forma de que eso existiera: el
-- login de la app es un PIN de cuatro dígitos hasheado contra IndexedDB y no
-- hay un solo usuario de Supabase en ningún lado. El motor nuevo de db.js, si
-- arranca así, entra como `anon`, y `anon` no toca NADA del SO.
--
-- DECISIÓN, y es de cómo trabaja la cocina más que de código: en el CIC cada
-- trabajadora usa su propio celular, no hay un aparato común que roten. Eso
-- habilita el modelo más simple que cumple la regla 8 de verdad:
--
--   - el PIN sigue siendo la puerta visible. Es lo que hace que la app se use:
--     entran apuradas, con las manos ocupadas, y cuatro dígitos son cuatro
--     dígitos. Nadie va a tipear un mail y una contraseña con las manos llenas
--     de harina.
--   - detrás, cada persona tiene su usuario de Supabase, creado por
--     administración. La sesión queda guardada en SU dispositivo.
--   - el PIN pasa a desbloquear esa sesión, no a ser la credencial.
--
-- Así la regla 8 la garantiza el servidor y no la pantalla, que era todo el
-- punto de la fase.
--
-- Lo que falta para que eso cierre son dos cosas que este archivo agrega: de
-- dónde sale el rol de cada persona, y cómo se entera el JWT.

-- ---------------------------------------------------------------------------
-- La tabla trabajadora pasa a ser la lista de personas del sistema
-- ---------------------------------------------------------------------------
--
-- Se le agregan dos columnas que el PDR §3 no tenía, y conviene decir por qué:
--
--   `email` — Supabase necesita un identificador para crear el usuario. No es
--   para mandar mails: es la llave con la que se aparea la persona del SO con
--   la de `auth.users`. Si alguna no tiene mail propio, administración le pone
--   uno cualquiera que controle; nadie lo tipea nunca en la app.
--
--   `rol` — hasta hoy el rol salía de contra qué PIN matcheaba: el de config
--   era admin y el de la fila era trabajadora. Con usuarios de verdad tiene que
--   estar escrito en algún lado, y la fila de la persona es el lugar obvio. La
--   comisión (`dirigente`) entra como una fila más: la tabla dejó de ser "las
--   que cocinan" para ser "las que entran al sistema". El nombre le queda
--   grande, pero renombrarla arrastra las 18 tablas, los módulos y el backup de
--   quien ya lo esté usando, y eso cuesta más de lo que aclara.

alter table public.trabajadora add column if not exists email text;

alter table public.trabajadora add column if not exists rol text not null default 'trabajadora';

do $$
begin
  alter table public.trabajadora
    add constraint trabajadora_rol_valido
    check (rol in ('admin', 'trabajadora', 'dirigente'));
exception when duplicate_object then null;
end $$;

-- Case-insensitive: `Maria@` y `maria@` son la misma persona, y Supabase
-- guarda el mail en minúscula. Sin esto, apareaba a veces sí y a veces no.
create unique index if not exists trabajadora_email_idx
  on public.trabajadora (lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- El rol viaja al JWT
-- ---------------------------------------------------------------------------
--
-- Va en `app_metadata` y no en `user_metadata`. La diferencia no es cosmética:
-- `user_metadata` lo edita el propio usuario con su anon key, así que cualquiera
-- se haría admin desde la consola del navegador y toda la fase sería teatro.
-- `app_metadata` solo lo escribe el servidor — esta función, que es
-- `security definer`.
--
-- El claim no se refresca solo: entra al token cuando se emite uno nuevo. Un
-- cambio de rol se hace efectivo al renovar (una hora como mucho), o antes si
-- la persona vuelve a entrar. Para una cocina de cinco personas donde los roles
-- cambian una vez por año, es un precio razonable frente a mantener una tabla
-- de sesiones a mano.

create or replace function public.grabar_claim_rol(p_user uuid, p_rol text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_user is null then return; end if;

  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                             || jsonb_build_object('rol', p_rol)
   where id = p_user;
end;
$$;

revoke execute on function public.grabar_claim_rol(uuid, text)
from public, anon, authenticated;

/**
 * Qué rol le corresponde a una fila de trabajadora.
 * Una persona dada de baja no pierde el usuario, pierde el rol: `inactiva` no
 * existe en ninguna política, así que no puede escribir nada. Cerrarle la
 * puerta del todo es borrar el usuario, y eso es una decisión de administración
 * y no un efecto secundario de destildar una casilla.
 */
create or replace function public.rol_efectivo(p_rol text, p_activa boolean)
returns text
language sql immutable
set search_path = ''
as $$
  select case when coalesce(p_activa, false) then coalesce(p_rol, 'trabajadora') else 'inactiva' end;
$$;

-- ---------------------------------------------------------------------------
-- El apareo, por los dos lados
-- ---------------------------------------------------------------------------
--
-- La persona puede existir antes que el usuario o después, según si
-- administración carga primero el equipo o primero las cuentas. Los dos
-- caminos tienen que terminar igual, así que hay un trigger de cada lado.

/**
 * Alta de usuario: si su mail está en el equipo, se aparean solos.
 *
 * Va `after insert` y no `before`: `trabajadora.auth_user_id` tiene FK contra
 * `auth.users`, y en un `before` la fila del usuario todavía no existe, así que
 * apuntarle sería violar la clave foránea. Escribir el `auth_user_id` dispara
 * el trigger de más abajo, que es el que graba el claim.
 */
create or replace function public.aparear_usuario_nuevo()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.trabajadora
     set auth_user_id = new.id
   where lower(email) = lower(new.email)
     and auth_user_id is distinct from new.id;

  return null;
exception when others then
  -- Un error acá tumbaría el alta de usuarios de todo el proyecto. Que quede
  -- sin aparear y se arregle desde el SO es mucho mejor que no poder crear
  -- una cuenta.
  return null;
end;
$$;

drop trigger if exists aparear_usuario_nuevo on auth.users;
create trigger aparear_usuario_nuevo
  after insert on auth.users
  for each row execute function public.aparear_usuario_nuevo();

/** Alta o cambio en el equipo: se busca el usuario y se le graba el rol. */
create or replace function public.aparear_trabajadora()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := new.auth_user_id;
begin
  if v_uid is null and new.email is not null then
    select id into v_uid from auth.users where lower(email) = lower(new.email) limit 1;
    new.auth_user_id := v_uid;
  end if;

  return new;
end;
$$;

drop trigger if exists aparear_trabajadora on public.trabajadora;
create trigger aparear_trabajadora
  before insert or update of email on public.trabajadora
  for each row execute function public.aparear_trabajadora();

/**
 * El claim se graba DESPUÉS de que la fila quedó escrita.
 * Separado del trigger de arriba a propósito: aquel corre `before` para poder
 * completar `auth_user_id` en la misma escritura, y este necesita el valor ya
 * confirmado.
 */
create or replace function public.grabar_rol_de_trabajadora()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.auth_user_id is not null then
    perform public.grabar_claim_rol(
      new.auth_user_id, public.rol_efectivo(new.rol, new.activa));
  end if;
  return null;
end;
$$;

drop trigger if exists grabar_rol_de_trabajadora on public.trabajadora;
create trigger grabar_rol_de_trabajadora
  after insert or update of rol, activa, auth_user_id on public.trabajadora
  for each row execute function public.grabar_rol_de_trabajadora();

-- ---------------------------------------------------------------------------
-- Quién soy, para el cliente
-- ---------------------------------------------------------------------------
--
-- El cliente necesita saber a qué persona corresponde la sesión que tiene
-- guardada, para poder comparar contra el PIN que acaban de tipear. La política
-- "cada una se ve a si misma" ya deja leer la fila propia, pero esto lo hace en
-- una llamada y sin depender de que el rol pueda listar la tabla.

create or replace function public.quien_soy()
returns table (trabajadora_id uuid, nombre text, rol text)
language sql stable security definer
set search_path = ''
as $$
  select t.id, t.nombre, public.rol_efectivo(t.rol, t.activa)
  from public.trabajadora t
  where t.auth_user_id = auth.uid();
$$;

-- `quien_soy()` es de las pocas funciones que SÍ se exponen: es la única forma
-- que tiene el cliente de saber de quién es la sesión que tiene guardada, y
-- solo devuelve la fila del que pregunta.
grant execute on function public.quien_soy() to authenticated;
revoke execute on function public.quien_soy() from public, anon;

-- Las de trigger, en cambio, no son API. Llamarlas sueltas ya moría con
-- "trigger functions can only be called as triggers", pero no tienen por qué
-- estar publicadas en /rest/v1/rpc.
revoke execute on function
  public.aparear_usuario_nuevo(),
  public.aparear_trabajadora(),
  public.grabar_rol_de_trabajadora()
from public, anon, authenticated;
