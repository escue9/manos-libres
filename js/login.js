/**
 * login.js — pantalla de PIN.
 *
 * Teclado numérico propio, no el del sistema: el teclado nativo tapa media
 * pantalla, tarda en aparecer y en Android a veces arranca en modo texto.
 * Con botones propios el ingreso es de cuatro taps y siempre igual.
 *
 * Modos:
 *   'quien'   primer arranque — ¿quién usa este celular?
 *   'equipo'  alta de alguien del equipo: mail y contraseña, una sola vez
 *   'alta'    se crea el PIN (se pide dos veces): el de administración en una
 *             instalación desde cero, o el de la persona que se acaba de vincular
 *   'ingreso' uso normal — se valida contra admin, el dispositivo y trabajadoras
 */

import { auth } from './auth.js';
import { db } from './db.js';
import { ui } from './ui.js';
import * as sync from './sync.js';

const N = auth.LARGO_PIN;

/**
 * El hash del PIN usa crypto.subtle, que el navegador SOLO expone en contextos
 * seguros: HTTPS o localhost. Entrando por IP de red local sobre HTTP no existe,
 * y sin este aviso el PIN fallaría en silencio.
 *
 * El service worker tiene la misma restricción: sin contexto seguro tampoco se
 * instala la PWA ni funciona el modo offline.
 */
function avisarContextoInseguro(root, resolve) {
  root.innerHTML = `
    <div class="login__box">
      <img class="login__logo" src="assets/logo-mark.png" alt="">
      <h1 class="login__titulo">Conexión no segura</h1>
      <p class="login__sub" style="margin-bottom:var(--sp-4)">
        Estás entrando por <b>${location.protocol}//${location.host}</b>.
      </p>
      <p class="login__sub" style="text-align:left">
        El navegador bloquea el cifrado del PIN y la instalación de la app
        cuando la dirección no es <b>https://</b> ni <b>localhost</b>.
      </p>
      <p class="login__sub" style="text-align:left">
        Para probar en el celular hay que publicarla con HTTPS. En la compu,
        entrá por <b>http://localhost:8000</b>.
      </p>
    </div>`;
}

export function mostrarLogin() {
  return new Promise((resolve) => {
    const root = document.getElementById('login');
    root.classList.remove('hidden');
    document.body.classList.add('con-login');

    if (!globalThis.crypto?.subtle) return avisarContextoInseguro(root, resolve);

    let modo = 'ingreso';
    let pin = '';
    let primerPin = null;      // solo en alta, para confirmar
    let vinculo = null;        // { rol, trabajadoraId, nombre } si viene de 'equipo'
    let avisoAlta = '';        // si los datos no bajaron, se dice en la pantalla del PIN

    (async () => {
      modo = (await auth.dispositivoListo()) ? 'ingreso' : 'quien';
      pintar();
    })();

    function textos() {
      if (modo === 'ingreso') return { t: 'Ingresá tu PIN', s: 'Manos Libres' };
      if (!primerPin) {
        if (!vinculo) return { t: 'Creá tu PIN', s: 'Cuatro dígitos para entrar a la app' };
        const nombre = (vinculo.nombre || '').split(' ')[0];
        return { t: nombre ? `Hola, ${nombre}` : 'Creá tu PIN', s: 'Elegí cuatro números: de acá en adelante entrás con ellos' };
      }
      return { t: 'Repetilo', s: 'Para confirmar que no te equivocaste' };
    }

    /**
     * Primer arranque. Antes un celular nuevo creaba un PIN de administración
     * sin preguntar: el de una trabajadora quedaba como administración de una
     * base vacía. Se pregunta una vez, y la opción del equipo va primero y
     * grande porque es la que se usa: instalar desde cero pasa una vez.
     */
    function pintarQuien() {
      root.innerHTML = `
        <div class="login__box">
          <img class="login__logo" src="assets/logo-mark.png" alt="">
          <h1 class="login__titulo">¿Quién usa este celular?</h1>
          <p class="login__sub">Se elige una sola vez</p>
          <div class="stack">
            <button class="btn btn--primary btn--block login__opcion" id="l-equipo">
              Soy del equipo
              <span>Entro con el mail y la contraseña que me dio administración</span>
            </button>
            <button class="btn btn--ghost btn--block" id="l-cero">Instalación nueva, desde cero</button>
          </div>
        </div>`;
      root.querySelector('#l-equipo').addEventListener('click', () => { modo = 'equipo'; pintar(); });
      root.querySelector('#l-cero').addEventListener('click', pintarCero);
    }

    /* La advertencia va en la misma pantalla: un modal quedaría debajo del login. */
    function pintarCero() {
      root.innerHTML = `
        <div class="login__box">
          <img class="login__logo" src="assets/logo-mark.png" alt="">
          <h1 class="login__titulo">¿Desde cero?</h1>
          <p class="login__sub" style="text-align:left">
            Esto arranca una cocina vacía, con este celular como administración.
            Si trabajás en Manos Libres, volvé y tocá <b>Soy del equipo</b>.
          </p>
          <div class="stack">
            <button class="btn btn--primary btn--block" id="l-volver">Volver</button>
            <button class="btn btn--danger btn--block" id="l-si">Arrancar de cero</button>
          </div>
        </div>`;
      root.querySelector('#l-volver').addEventListener('click', pintarQuien);
      root.querySelector('#l-si').addEventListener('click', () => { modo = 'alta'; pintar(); });
    }

    /**
     * El mail y la contraseña se tipean acá y nunca más: lo que queda guardado
     * es la sesión (sesion.js) y de ahí en adelante abre el PIN. Por eso acá sí
     * va el teclado del sistema.
     */
    function pintarEquipo(error = '', ocupado = '') {
      const email = root.querySelector('#l-email')?.value || '';
      const off = ocupado ? 'disabled' : '';
      root.innerHTML = `
        <div class="login__box">
          <img class="login__logo" src="assets/logo-mark.png" alt="">
          <h1 class="login__titulo">Entrá con tu cuenta</h1>
          <p class="login__sub">La que te dio administración. Se pide una sola vez.</p>
          <form class="stack login__form" id="l-form" novalidate>
            <div class="field">
              <label for="l-email">Mail</label>
              <input class="input" id="l-email" type="email" autocomplete="username"
                     autocapitalize="none" spellcheck="false" value="${ui.esc(email)}" ${off}>
            </div>
            <div class="field">
              <label for="l-pass">Contraseña</label>
              <input class="input" id="l-pass" type="password" autocomplete="current-password" ${off}>
            </div>
            <p class="login__msg${error ? ' err' : ' aviso'}">${ui.esc(error || ocupado) || '&nbsp;'}</p>
            <button class="btn btn--primary btn--block" type="submit" ${off}>${ocupado ? 'Un momento…' : 'Entrar'}</button>
            <button class="btn btn--ghost btn--block" type="button" id="l-volver" ${off}>Volver</button>
          </form>
        </div>`;

      root.querySelector('#l-volver').addEventListener('click', () => { modo = 'quien'; pintar(); });
      root.querySelector('#l-form').addEventListener('submit', (e) => { e.preventDefault(); vincular(); });
      if (!ocupado) root.querySelector(email ? '#l-pass' : '#l-email').focus();
    }

    async function vincular() {
      const email = root.querySelector('#l-email').value.trim();
      const password = root.querySelector('#l-pass').value;
      if (!email || !password) return pintarEquipo('Falta el mail o la contraseña.');

      pintarEquipo('', 'Entrando…');
      try {
        vinculo = await auth.vincularDispositivo({ email, password });
      } catch (e) {
        return pintarEquipo(enCriollo(e));
      }

      // La unidad de negocio que puso puestaEnMarcha() ya está en la nube con el
      // mismo id. Sin esto se intentaría subir, y una trabajadora no puede
      // escribirla: el primer paso del sync fallaría siempre y no subiría nada.
      const propias = await db._sync.pendientes('unidad_negocio');
      await db._sync.marcarSincronizadas('unidad_negocio', propias.map((f) => f.id));

      pintarEquipo('', 'Bajando tus datos…');
      try {
        await sync.sincronizar();
        avisoAlta = '';
      } catch (e) {
        // Sin los datos la app abre igual (regla 3): bajan en la próxima vuelta,
        // al abrirla o cuando vuelva la señal.
        console.warn('Primera sincronización:', e.message);
        avisoAlta = 'Tus datos todavía no bajaron: van a bajar solos cuando haya internet.';
      }

      modo = 'alta';
      pintar();
    }

    /** "Invalid login credentials" no lo tiene que traducir nadie en la cocina. */
    function enCriollo(e) {
      const msg = e?.message || '';
      if (/invalid login credentials|invalid_grant/i.test(msg)) return 'El mail o la contraseña no coinciden.';
      if (/email not confirmed/i.test(msg)) return 'La cuenta todavía no está confirmada. Avisale a administración.';
      if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'No hay internet. Esta primera vez hace falta conexión.';
      return msg || 'No se pudo entrar.';
    }

    /**
     * `error` puede ser `true` (PIN incorrecto) o el motivo real.
     * El PIN correcto en el celular de otra persona no es un PIN incorrecto, y
     * decirle eso a alguien que lo tipeó bien lo manda a probar tres veces más.
     */
    function pintar(error = false) {
      if (modo === 'quien') return pintarQuien();
      if (modo === 'equipo') return pintarEquipo();

      const { t, s } = textos();
      const aviso = !error && modo === 'alta' && avisoAlta;
      root.innerHTML = `
        <div class="login__box${error ? ' shake' : ''}">
          <img class="login__logo" src="assets/logo-mark.png" alt="">
          <h1 class="login__titulo">${t}</h1>
          <p class="login__sub">${s}</p>

          <div class="login__puntos" role="status" aria-live="polite">
            ${Array.from({ length: N }, (_, i) =>
              `<i class="${i < pin.length ? 'on' : ''}${error ? ' err' : ''}"></i>`).join('')}
          </div>

          <div class="login__msg${error ? ' err' : ''}${aviso ? ' aviso' : ''}">${
            error ? ui.esc(error === true ? 'PIN incorrecto' : error) : (aviso ? ui.esc(aviso) : '&nbsp;')}</div>

          <div class="numpad">
            ${[1,2,3,4,5,6,7,8,9].map((d) => `<button data-d="${d}">${d}</button>`).join('')}
            <button class="numpad__vacio" disabled aria-hidden="true"></button>
            <button data-d="0">0</button>
            <button data-borrar aria-label="Borrar">⌫</button>
          </div>
        </div>`;

      root.querySelectorAll('[data-d]').forEach((b) =>
        b.addEventListener('click', () => tecla(b.dataset.d)));
      root.querySelector('[data-borrar]').addEventListener('click', borrar);
    }

    function vibrar(ms = 12) { navigator.vibrate?.(ms); }

    function tecla(d) {
      if (pin.length >= N) return;
      pin += d;
      vibrar();
      pintar();
      if (pin.length === N) setTimeout(confirmar, 140);
    }

    function borrar() {
      pin = pin.slice(0, -1);
      vibrar();
      pintar();
    }

    function fallar(motivo = true) {
      vibrar(60);
      pintar(motivo);
      pin = '';
      // Un motivo hay que poder leerlo: dos segundos y medio, no setecientos.
      setTimeout(() => pintar(false), motivo === true ? 700 : 2500);
    }

    async function confirmar() {
      if (modo === 'alta') {
        if (!primerPin) { primerPin = pin; pin = ''; return pintar(); }
        if (primerPin !== pin) { primerPin = null; return fallar(); }
        try {
          if (vinculo) await auth.crearPinDispositivo(pin, vinculo);
          else await auth.crearPinAdmin(pin);
          await auth.ingresar(pin);
        } catch (e) {
          primerPin = null;
          return fallar(e.message);
        }
        return cerrar();
      }

      let ok;
      try {
        ok = await auth.ingresar(pin);
      } catch (e) {
        // El PIN estaba bien pero el dispositivo es de otra persona, o la
        // cuenta está dada de baja. Se dice cuál de las dos.
        return fallar(e.message);
      }
      if (!ok) return fallar();
      cerrar();
    }

    function cerrar() {
      root.classList.add('hidden');
      root.innerHTML = '';
      document.body.classList.remove('con-login');
      document.removeEventListener('keydown', onKey);
      resolve(auth.rol);
    }

    /* Teclado físico, para desarrollo en desktop.
       Se desregistra en cerrar(): antes solo se sacaba cuando llegaba una
       tecla con el login ya oculto, así que después de cerrar sesión quedaba
       vivo el de la sesión anterior y cada dígito contaba doble. */
    const onKey = (e) => {
      if (root.classList.contains('hidden')) return document.removeEventListener('keydown', onKey);
      if (modo === 'quien' || modo === 'equipo') return;   // ahí se tipea en los campos
      if (/^\d$/.test(e.key)) tecla(e.key);
      else if (e.key === 'Backspace') borrar();
    };
    document.addEventListener('keydown', onKey);
  });
}
