/**
 * login.js — pantalla de PIN.
 *
 * Teclado numérico propio, no el del sistema: el teclado nativo tapa media
 * pantalla, tarda en aparecer y en Android a veces arranca en modo texto.
 * Con botones propios el ingreso es de cuatro taps y siempre igual.
 *
 * Dos modos:
 *   'alta'    primer arranque — se crea el PIN de administración (se pide dos veces)
 *   'ingreso' uso normal — se valida contra admin y trabajadoras
 */

import { auth } from './auth.js';

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

    (async () => {
      modo = (await auth.hayAdmin()) ? 'ingreso' : 'alta';
      pintar();
    })();

    function textos() {
      if (modo === 'ingreso') return { t: 'Ingresá tu PIN', s: 'Manos Libres' };
      if (!primerPin)          return { t: 'Creá tu PIN', s: 'Cuatro dígitos para entrar a la app' };
      return { t: 'Repetilo', s: 'Para confirmar que no te equivocaste' };
    }

    /**
     * `error` puede ser `true` (PIN incorrecto) o el motivo real.
     * El PIN correcto en el celular de otra persona no es un PIN incorrecto, y
     * decirle eso a alguien que lo tipeó bien lo manda a probar tres veces más.
     */
    function pintar(error = false) {
      const { t, s } = textos();
      root.innerHTML = `
        <div class="login__box${error ? ' shake' : ''}">
          <img class="login__logo" src="assets/logo-mark.png" alt="">
          <h1 class="login__titulo">${t}</h1>
          <p class="login__sub">${s}</p>

          <div class="login__puntos" role="status" aria-live="polite">
            ${Array.from({ length: N }, (_, i) =>
              `<i class="${i < pin.length ? 'on' : ''}${error ? ' err' : ''}"></i>`).join('')}
          </div>

          <div class="login__msg${error ? ' err' : ''}">${
            error ? esc(error === true ? 'PIN incorrecto' : error) : '&nbsp;'}</div>

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
        await auth.crearPinAdmin(pin);
        await auth.ingresar(pin);
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
      if (/^\d$/.test(e.key)) tecla(e.key);
      else if (e.key === 'Backspace') borrar();
    };
    document.addEventListener('keydown', onKey);
  });
}
