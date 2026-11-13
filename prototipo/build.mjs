// Une core/session.js dentro del HTML (así funciona abriéndolo con doble clic, sin servidor).
// Uso: node prototipo/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const core = readFileSync(join(here, '../core/session.js'), 'utf8').replace(/^export /gm, '');
const src = readFileSync(join(here, 'index.src.html'), 'utf8');
if (!src.includes('/*CORE*/')) throw new Error('Falta el marcador /*CORE*/');
const lottie = readFileSync(join(here, 'assets/lottie_light.min.js'), 'utf8');
const phones = readFileSync(join(here, 'assets/phones.json'), 'utf8').trim();
const photo = readFileSync(join(here, 'assets/sug_photo.jpg')).toString('base64');
let out = src.replace('/*SUG_PHOTO*/', () => photo).replace('/*CORE*/', () => core).replace('/*LOTTIE*/', () => lottie).replace('/*PHONES_JSON*/null', () => phones);
writeFileSync(join(here, 'index.html'), out);
// Versión solo con el flujo principal (transferir con monto primero): sin selector de flujos ni pedir dinero.
const solo = out.replace('<body>', '<body class="solo">').replace('<title>', '<title>Flujo principal · ').replace('<h1>Transferencia por cercanía</h1>', '<h1>Transferencia por cercanía · flujo principal</h1>');
writeFileSync(join(here, 'principal.html'), solo);
console.log('prototipo/principal.html generado');
console.log('prototipo/index.html generado');
