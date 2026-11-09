// Builds cadetflow.css, the site's Tailwind classes, from the classes used in index.html, and
// stamps its version on the <link> in index.html (so a new push is never shown with an old copy).
//   npm run build:css            build it
//   node tools/build_css.mjs --out <file>   build to another file (the tests compare it)
// Run it after adding or changing Tailwind classes in index.html; the tests fail if it is stale.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--out');
const out = i > 0 ? process.argv[i + 1] : join(root, 'cadetflow.css');
execFileSync(process.execPath, [join(root, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
  '-c', join(root, 'tools', 'tailwind.config.cjs'), '-i', join(root, 'tools', 'tailwind.in.css'), '-o', out, '--minify'], { stdio: ['ignore', 'ignore', 'pipe'] });
export const cssVersion = css => createHash('sha256').update(css).digest('hex').slice(0, 10);
if (i < 0) {
  const v = cssVersion(readFileSync(out));
  const page = join(root, 'index.html'), html = readFileSync(page, 'utf8');
  const next = html.replace(/<link rel="stylesheet" href="cadetflow\.css(\?v=[0-9a-f]*)?">/, `<link rel="stylesheet" href="cadetflow.css?v=${v}">`);
  if (next === html && !html.includes(`cadetflow.css?v=${v}`)) throw new Error('index.html has no <link rel="stylesheet" href="cadetflow.css">');
  writeFileSync(page, next);
  console.log(`cadetflow.css built (${readFileSync(out).length} bytes, version ${v})`);
}
