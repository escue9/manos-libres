/**
 * actualizacion.js — avisar que hay una versión nueva y aplicarla cuando lo pidan.
 *
 * EL PROBLEMA QUE RESUELVE. El service worker sirve el shell desde el cache, así
 * que la app abre sin internet (regla 3). El costo es que después de un deploy
 * la copia vieja sigue andando: arreglás un bug y la trabajadora lo sigue
 * teniendo, porque su celular tiene la app instalada y no la cierra en toda la
 * semana. Eso ya pasó una vez —la pantalla de Caja mostrando "Fase 4", que era
 * el placeholder de la Fase 0— y con la app en Vercel va a pasar seguido.
 *
 * POR QUÉ NO ALCANZA CON `skipWaiting()` AUTOMÁTICO. Era lo que había, y hace
 * que el worker nuevo tome el control en el medio de la sesión: la pantalla
 * sigue con los módulos viejos que ya cargó, pero lo que pida de ahí en más lo
 * atiende el cache nuevo. Media app de cada versión, y nadie se entera.
 *
 * ASÍ QUE: el worker nuevo se instala y espera. La app avisa, y recién cuando
 * la persona toca "Actualizar" se le da paso y se recarga. La recarga va atada
 * a `controllerchange`, no a un setTimeout: se recarga cuando el worker nuevo
 * está realmente al mando, no cuando calculamos que ya debería estarlo.
 *
 * El aviso NO interrumpe. Aparece abajo, se puede ignorar, y no se lo lleva
 * puesto un toast que dura 2,8 segundos. Alguien anotando seis ventas con las
 * manos ocupadas no quiere un modal preguntándole por una actualización.
 */

let avisando = false;

/** Que el worker que está esperando tome el control. */
function aplicar(esperando) {
  // La recarga la dispara controllerchange, no esto.
  esperando.postMessage({ tipo: 'actualizar' });
}

function avisar(esperando) {
  if (avisando) return;
  avisando = true;

  const caja = document.createElement('div');
  caja.className = 'aviso-version';
  caja.setAttribute('role', 'status');
  caja.innerHTML = `
    <span>Hay una versión nueva.</span>
    <button class="btn btn--primary" data-accent="caja" data-actualizar>Actualizar</button>
    <button class="aviso-version__x" data-cerrar aria-label="Ahora no">✕</button>`;

  caja.querySelector('[data-actualizar]').addEventListener('click', () => {
    caja.querySelector('span').textContent = 'Actualizando…';
    caja.querySelector('[data-actualizar]').disabled = true;
    aplicar(esperando);
  });

  // "Ahora no" es una respuesta válida: puede estar cobrando. Vuelve a
  // aparecer sola en la próxima apertura, porque el worker sigue esperando.
  caja.querySelector('[data-cerrar]').addEventListener('click', () => {
    caja.remove();
    avisando = false;
  });

  document.body.appendChild(caja);
}

export function vigilarActualizaciones() {
  if (!('serviceWorker' in navigator)) return;

  // Una sola recarga, cuando el worker nuevo toma el mando de verdad.
  let recargando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (recargando) return;
    recargando = true;
    location.reload();
  });

  addEventListener('load', async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register('sw.js');
    } catch {
      return;   // sin service worker la app anda igual, solo sin caché
    }

    // Ya había uno esperando de una sesión anterior.
    if (reg.waiting && navigator.serviceWorker.controller) avisar(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const nuevo = reg.installing;
      if (!nuevo) return;
      nuevo.addEventListener('statechange', () => {
        // `controller` distingue una actualización de la primera instalación:
        // sin él, la primerísima visita mostraría "hay una versión nueva" de
        // una app que la persona acaba de abrir por primera vez.
        if (nuevo.state === 'installed' && navigator.serviceWorker.controller) avisar(nuevo);
      });
    });

    // El navegador busca actualizaciones al navegar, y una PWA instalada puede
    // pasar días sin navegar a ningún lado. Un chequeo al volver a la app cubre
    // el caso de la trabajadora que la deja abierta toda la semana.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  });
}
