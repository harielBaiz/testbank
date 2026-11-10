// Une core/session.js dentro del HTML (así funciona abriéndolo con doble clic, sin servidor).
// Uso: node prototipo/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const core = readFileSync(join(here, '../core/session.js'), 'utf8').replace(/^export /gm, '');
const src = readFileSync(join(here, 'index.src.html'), 'utf8');
if (!src.includes('/*CORE*/')) throw new Error('Falta el marcador /*CORE*/');
writeFileSync(join(here, 'index.html'), src.replace('/*CORE*/', () => core));
console.log('prototipo/index.html generado');
