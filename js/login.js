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
      if (modo === 'ingreso') return { t: 'Ingresá tu PIN', s: 'Cocina CIC · Manos Libres' };
      if (!primerPin)          return { t: 'Creá tu PIN', s: 'Cuatro dígitos para entrar a la app' };
      return { t: 'Repetilo', s: 'Para confirmar que no te equivocaste' };
    }

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

          <div class="login__msg${error ? ' err' : ''}">${error ? 'PIN incorrecto' : '&nbsp;'}</div>

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

    function fallar() {
      vibrar(60);
      pintar(true);
      pin = '';
      setTimeout(() => pintar(false), 700);
    }

    async function confirmar() {
      if (modo === 'alta') {
        if (!primerPin) { primerPin = pin; pin = ''; return pintar(); }
        if (primerPin !== pin) { primerPin = null; return fallar(); }
        await auth.crearPinAdmin(pin);
        await auth.ingresar(pin);
        return cerrar();
      }

      const ok = await auth.ingresar(pin);
      if (!ok) return fallar();
      cerrar();
    }

    function cerrar() {
      root.classList.add('hidden');
      root.innerHTML = '';
      document.body.classList.remove('con-login');
      resolve(auth.rol);
    }

    /* Teclado físico, para desarrollo en desktop */
    const onKey = (e) => {
      if (root.classList.contains('hidden')) return document.removeEventListener('keydown', onKey);
      if (/^\d$/.test(e.key)) tecla(e.key);
      else if (e.key === 'Backspace') borrar();
    };
    document.addEventListener('keydown', onKey);
  });
}
