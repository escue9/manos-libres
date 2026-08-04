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

// Ana trabaja 5 días con tarifa distinta; María 2
for (const f of ['2026-07-20','2026-07-21','2026-07-22','2026-07-23','2026-07-24'])
  await eq.marcarJornada(ana.id, f);
for (const f of ['2026-07-20','2026-07-21'])
  await eq.marcarJornada(maria.id, f);
await eq.guardarTrabajadora({ id: ana.id, nombre:'Ana', tarifaDia: 12345 });
await state.cargar();

const v = document.getElementById('v');

console.log('── vista ADMIN');
auth.rol='admin'; auth.trabajadoraId=null;
await eq.render(v);
const htmlAdmin = v.innerHTML;
console.log('  ve a Ana:  ', htmlAdmin.includes('Ana'));
console.log('  ve a María:', htmlAdmin.includes('María'));
console.log('  ve tarifas:', /12\.345|12345/.test(htmlAdmin));
console.log('  ve el rol:  ', /Trabajadora/.test(htmlAdmin));

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

console.log('\n════ FUGAS ════');
fugas.length ? fugas.forEach(f=>console.log('  ⚠', f)) : console.log('  ninguna ✓');
process.exit(fugas.length?1:0);
