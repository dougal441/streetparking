// Assemble a self-contained static bundle in web/dist/ for dropping into dougalhanson.com/streetparking/.
// No bundler: copies web/, src/, rules/ and rewrites the two relative paths.
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node scripts/build-web.js [outDir]   (default web/dist; the Worker uses worker/public/streetparking)
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('web/dist');
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const f of ['index.html', 'style.css']) await cp(`web/${f}`, path.join(out, f));
await cp('src', path.join(out, 'src'), { recursive: true });
await cp('rules', path.join(out, 'rules'), { recursive: true, filter: (p) => !p.includes('/sources/') });
let app = await readFile('web/app.js', 'utf8');
app = app.replaceAll("'../src/", "'./src/").replaceAll("'../rules/'", "'./rules/'");
await writeFile(path.join(out, 'app.js'), app);
// src/index.js lazy-imports use relative paths inside src/, so they keep working.
const idx = await readFile(path.join(out, 'index.html'), 'utf8');
await writeFile(path.join(out, 'index.html'), idx.replace('<!doctype html>', '<!doctype html>\n<!-- built by scripts/build-web.js -->'));
console.log(`built ${out}/`);
