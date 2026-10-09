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
const { ui }    = await import('../js/ui.js');
const eq        = await import('../js/modules/trabajadoras.js');

await seed(); await state.cargar();
auth.rol='admin';

const ana   = state.trabajadoras.find(x=>x.nombre==='Ana');
const maria = state.trabajadoras.find(x=>x.nombre==='María');

// Ana trabaja 5 días con tarifa distinta; María 2
for (const f of ['2026-07-20','2026-07-21','2026-07-22','2026-07-23','2026-07-24'])
  await eq.marcarJornada(ana.id, f);
for (const f of ['2026-07-20','2026-07-21'])
  await eq.marcarJornada(maria.id, f);
await eq.guardarTrabajadora({ id: ana.id, nombre:'Ana', tarifaDia: 12345 });
await state.cargar();

// Se liquida la semana: las dos quedan con una liquidación pagada en el histórico
await eq.liquidarSemana('2026-07-20','2026-07-26');
const HOY = ui.hoyISO();
const totalAna = (await eq.liquidacionesPagadas({ trabajadoraId: ana.id }))[0].total;

const v = document.getElementById('v');

console.log('── vista ADMIN');
auth.rol='admin'; auth.trabajadoraId=null;
await eq.render(v);
const htmlAdmin = v.innerHTML;
console.log('  ve a Ana:  ', htmlAdmin.includes('Ana'));
console.log('  ve a María:', htmlAdmin.includes('María'));
console.log('  ve tarifas:', /12\.345|12345/.test(htmlAdmin));
console.log('  ve el rol:  ', /Trabajadora/.test(htmlAdmin));
console.log('  ve el histórico:', htmlAdmin.includes('Liquidaciones pagadas'));

console.log('\n── vista TRABAJADORA (María)');
auth.rol='trabajadora'; auth.trabajadoraId=maria.id;
await eq.render(v);
const h = v.innerHTML;

const fugas = [];
if (h.includes('Ana'))            fugas.push('aparece el nombre de otra trabajadora');
if (h.includes(ana.id))           fugas.push('aparece el id de otra trabajadora');
if (/12\.345|12345/.test(h))      fugas.push('aparece la tarifa de otra');
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
console.log('  botones de día:', v.querySelectorAll('[data-dia]').length, '(7 = solo su fila) ' + (v.querySelectorAll('[data-dia]').length===7?'✓':'⚠'));

const ajenos = [...v.querySelectorAll('[data-trab]')].filter(b=>b.dataset.trab!==maria.id);
if (ajenos.length) fugas.push(`hay ${ajenos.length} botones que apuntan a otra trabajadora`);

/* ── lo que cobró en semanas anteriores ── */
console.log('  ve lo que cobró:', h.includes('Lo que cobraste'));
if (!h.includes('Lo que cobraste')) fugas.push('no ve su propio histórico de cobros');
if (h.includes(ui.money(totalAna))) fugas.push('aparece lo que cobró otra');
if (h.includes('Liquidaciones pagadas')) fugas.push('ve el histórico del equipo');

const comprobantes = [...v.querySelectorAll('[data-comprobante]')];
if (!comprobantes.length) fugas.push('no tiene botón para su comprobante');
if (comprobantes.some(b=>b.dataset.comprobante!==maria.id))
  fugas.push('hay comprobantes que apuntan a otra trabajadora');

// El texto de WhatsApp viaja codificado en el href: se decodifica para mirarlo
const textosWa = [...v.querySelectorAll('a[href^="https://wa.me/"]')].map(a=>decodeURIComponent(a.getAttribute('href')));
if (textosWa.some(x=>x.includes('Ana') || x.includes(ui.money(totalAna))))
  fugas.push('el texto de WhatsApp trae datos de otra');
if (textosWa.some(x=>!/^https:\/\/wa\.me\/\?/.test(x)))
  fugas.push('el link de WhatsApp lleva un número de teléfono');

/* ── el comprobante impreso: se intercepta la ventana de impresión ── */
let impreso = null;
window.open = () => ({
  document: { write: (x) => { impreso = (impreso || '') + x; }, close() {} },
  focus() {}, print() {}, close() {},
});
comprobantes[0]?.click();
for (let i = 0; i < 100 && impreso === null; i++) await new Promise(r=>setTimeout(r,20));
console.log('  imprime su comprobante:', impreso !== null);
if (impreso === null) fugas.push('el comprobante no se imprimió');
else {
  if (!impreso.includes('María'))  fugas.push('el comprobante no lleva su nombre');
  if (impreso.includes('Ana'))     fugas.push('el comprobante trae el nombre de otra');
  if (!impreso.includes('Federación de Organizaciones Sociales «Mesa Solidaria Tandil»'))
    fugas.push('el pie no es de la Federación');
  if (/Mirmidones|sueldo|registrad|dependencia/i.test(impreso))
    fugas.push('el comprobante dice algo que no es');
}

// Y desde la consola, con el id de otra a mano
try { await eq.comprobanteLiquidacion(ana.id, HOY); fugas.push('saca el comprobante de otra desde la consola'); }
catch { /* tiene que tirar */ }
const histPropio = await eq.liquidacionesPagadas();
if (histPropio.some(l=>l.trabajadora_id!==maria.id)) fugas.push('el histórico trae liquidaciones ajenas');

console.log('\n════ FUGAS ════');
fugas.length ? fugas.forEach(f=>console.log('  ⚠', f)) : console.log('  ninguna ✓');
process.exit(fugas.length?1:0);
