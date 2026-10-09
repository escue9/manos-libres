import "fake-indexeddb/auto";   // npm install fake-indexeddb jsdom
import { JSDOM } from 'jsdom';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis,"crypto",{value:webcrypto});

const dom = new JSDOM('<!doctype html><body><section class="view" id="v"></section></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});

const { db, seed } = await import('../js/db.js');
const { state } = await import('../js/state.js');
const { auth }  = await import('../js/auth.js');
const eq        = await import('../js/modules/trabajadoras.js');

await seed(); await state.cargar();
auth.rol='admin';

const ana   = state.trabajadoras.find(x=>x.nombre==='Ana');
const maria = state.trabajadoras.find(x=>x.nombre==='María');

// La semana que se muestra es la de hoy
const { ui } = await import('../js/ui.js');
const lunes = ui.hoyISO(ui.inicioSemana());

// Ana viene 2 días y produce mucho, con un número que se reconoce; María 1
await eq.marcarJornada(ana.id, lunes);
await eq.marcarJornada(maria.id, lunes);
const fila = (trabajadora_id, cantidad, total, confirmada = true) => ({
  trabajadora_id, orden_produccion_id: 'o1', produccion_item_id: 'i1',
  producto_id: state.productos[0].id, fecha: lunes, cantidad, pago_unitario: total / cantidad, total,
  origen_carga: confirmada ? 'admin' : 'autoreporte', confirmada, estado_pago: 'pendiente', fecha_pago: null,
});
await db.from('pago_produccion').insert([fila(ana.id, 777, 12345), fila(maria.id, 3, 900), fila(maria.id, 2, 600, false)]);

// Histórico: una liquidación por producción ya pagada y otra vieja, por día,
// de antes del cambio. Los montos de Ana se reconocen: 4.444 y 3.333
const PAGO_PROD = '2026-09-30', PAGO_DIA = '2026-07-25';
const pagada = (x) => ({ ...x, fecha: '2026-09-28', estado_pago: 'pagada', fecha_pago: PAGO_PROD });
await db.from('pago_produccion').insert([pagada(fila(ana.id, 44, 4444)), pagada(fila(maria.id, 10, 1000))]);
const jornal = (trabajadora_id, tarifa_aplicada) => ({
  trabajadora_id, fecha: '2026-07-21', orden_produccion_id: null, tarifa_aplicada,
  origen_carga: 'admin', confirmada: true, estado_pago: 'pagada', fecha_pago: PAGO_DIA,
});
await db.from('jornada').insert([jornal(ana.id, 3333), jornal(maria.id, 2000)]);
await state.cargar();

const v = document.getElementById('v');

console.log('── vista ADMIN');
auth.rol='admin'; auth.trabajadoraId=null;
await eq.render(v);
const htmlAdmin = v.innerHTML;
console.log('  ve a Ana:  ', htmlAdmin.includes('Ana'));
console.log('  ve a María:', htmlAdmin.includes('María'));
console.log('  ve lo de Ana:', /12\.345|12345/.test(htmlAdmin));
console.log('  ve el botón de confirmar:', htmlAdmin.includes('data-confirmar-pago'));
console.log('  ve el rol:  ', /Trabajadora/.test(htmlAdmin));
console.log('  ve el histórico:', htmlAdmin.includes('Liquidaciones pagadas'));

console.log('\n── vista TRABAJADORA (María)');
auth.rol='trabajadora'; auth.trabajadoraId=maria.id;
await eq.render(v);
const h = v.innerHTML;

const fugas = [];
if (h.includes('Ana'))            fugas.push('aparece el nombre de otra trabajadora');
if (h.includes(ana.id))           fugas.push('aparece el id de otra trabajadora');
if (/12\.345|12345/.test(h))      fugas.push('aparece lo que cobra otra');
if (/777/.test(h))                fugas.push('aparece lo que produjo otra');
if (h.includes('data-confirmar-pago')) fugas.push('puede confirmar producción');
if (h.includes('Liquidar'))       fugas.push('ve el botón de liquidar');
if (h.includes('Total de la semana')) fugas.push('ve el total del equipo');
if (h.includes('Editar'))         fugas.push('ve el botón de editar');
if (/por día/.test(h))            fugas.push('ve una tarifa diaria');
if (/Administración|Comisión|Trabajadora/.test(h)) fugas.push('ve el rol de alguien');
if (/sin mail|@/.test(h))         fugas.push('ve datos de la cuenta de alguien');

const tarjetas = v.querySelectorAll('.card').length;
console.log('  tarjetas visibles:', tarjetas, '(la suya + su total)');
console.log('  ve su propio nombre:', h.includes('María'));
console.log('  ve su total:', h.includes('Tu total de la semana'));
// Contra el texto y no el HTML: el formato de plata usa un espacio duro, que
// innerHTML escribe como &nbsp;
if (!/\$\s?900/.test(v.textContent)) fugas.push('no ve su propio total confirmado');
if (!/\$\s?600/.test(v.textContent)) fugas.push('no ve lo suyo que espera confirmación');
console.log('  botones de día:', v.querySelectorAll('[data-dia]').length, '(7 = solo su fila) ' + (v.querySelectorAll('[data-dia]').length===7?'✓':'⚠'));

const ajenos = [...v.querySelectorAll('[data-trab]')].filter(b=>b.dataset.trab!==maria.id);
if (ajenos.length) fugas.push(`hay ${ajenos.length} botones que apuntan a otra trabajadora`);

/* ── lo que cobró en semanas anteriores ── */
console.log('  ve lo que cobró:', h.includes('Lo que cobraste'));
if (!h.includes('Lo que cobraste')) fugas.push('no ve su propio histórico de cobros');
if (/4\.444|4444|3\.333|3333/.test(h)) fugas.push('aparece lo que cobró otra');
if (h.includes('Liquidaciones pagadas')) fugas.push('ve el histórico del equipo');
if (!/\$\s?1\.000/.test(v.textContent)) fugas.push('no ve lo que cobró por producción');
if (!/\$\s?2\.000/.test(v.textContent)) fugas.push('no ve lo que cobró por día antes del cambio');

const comprobantes = [...v.querySelectorAll('[data-comprobante]')];
console.log('  comprobantes propios:', comprobantes.length, '(2 = producción + el viejo por día)');
if (comprobantes.length !== 2) fugas.push('no tiene sus dos comprobantes');
if (comprobantes.some(b=>b.dataset.comprobante!==maria.id))
  fugas.push('hay comprobantes que apuntan a otra trabajadora');

// El texto de WhatsApp viaja codificado en el href: se decodifica para mirarlo
const textosWa = [...v.querySelectorAll('a[href^="https://wa.me/"]')].map(a=>decodeURIComponent(a.getAttribute('href')));
if (textosWa.some(x=>x.includes('Ana') || /4\.444|3\.333/.test(x)))
  fugas.push('el texto de WhatsApp trae datos de otra');
if (textosWa.some(x=>!/^https:\/\/wa\.me\/\?/.test(x)))
  fugas.push('el link de WhatsApp lleva un número de teléfono');

/* ── el comprobante impreso: se intercepta la ventana de impresión ── */
let impreso = null;
window.open = () => ({
  document: { write: (x) => { impreso = (impreso || '') + x; }, close() {} },
  focus() {}, print() {}, close() {},
});
comprobantes.find(b=>b.dataset.fechaPago===PAGO_PROD)?.click();
for (let i = 0; i < 100 && impreso === null; i++) await new Promise(r=>setTimeout(r,20));
console.log('  imprime su comprobante:', impreso !== null);
if (impreso === null) fugas.push('el comprobante no se imprimió');
else {
  if (!impreso.includes('María'))  fugas.push('el comprobante no lleva su nombre');
  if (!impreso.includes('por producción')) fugas.push('el comprobante no dice que es por producción');
  if (impreso.includes('Ana') || /4\.444|3\.333/.test(impreso)) fugas.push('el comprobante trae datos de otra');
  if (!impreso.includes('Federación de Organizaciones Sociales «Mesa Solidaria Tandil»'))
    fugas.push('el pie no es de la Federación');
  if (/Mirmidones|sueldo|registrad|dependencia/i.test(impreso))
    fugas.push('el comprobante dice algo que no es');
}

// Y desde la consola, con el id de otra a mano
for (const fecha of [PAGO_PROD, PAGO_DIA]) {
  try { await eq.comprobanteLiquidacion(ana.id, fecha); fugas.push(`saca el comprobante de otra desde la consola (${fecha})`); }
  catch { /* tiene que tirar */ }
}
const histPropio = await eq.liquidacionesPagadas();
if (histPropio.some(l=>l.trabajadora_id!==maria.id)) fugas.push('el histórico trae liquidaciones ajenas');

console.log('\n════ FUGAS ════');
fugas.length ? fugas.forEach(f=>console.log('  ⚠', f)) : console.log('  ninguna ✓');
process.exit(fugas.length?1:0);
