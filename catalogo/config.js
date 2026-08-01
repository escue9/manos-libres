/**
 * Configuración del catálogo público.
 *
 * La anon key va acá y viaja al navegador de cualquiera que abra el link.
 * Es pública por diseño: lo único que puede hacer es leer los ítems activos e
 * insertar en `pedido_web`. La seguridad la dan las políticas de RLS, no
 * esconder la key. Ver supabase/migrations/20260730_canal_web.sql.
 *
 * NUNCA pongas acá la service_role key. Esa sí abre todo.
 */

export const CONFIG = {
  /** https://<ref>.supabase.co */
  SUPABASE_URL: 'https://xkvkzuivyqunduavejla.supabase.co',

  /** La anon / publishable key del proyecto. */
  SUPABASE_ANON_KEY: 'sb_publishable_sVfuvpEY5bI469kaLact7g_iwEjYX5S',

  /**
   * WhatsApp de la cocina, en formato internacional y solo dígitos.
   * Argentina: 54 + 9 + característica sin 0 + número sin 15.
   * Ej: para el (2494) 15-55-1234 va '5492494551234'.
   *
   * Si queda vacío, la página sigue funcionando pero sin los botones de
   * WhatsApp: no inventes un número, se pierde el pedido.
   */
  WHATSAPP: '',
};
