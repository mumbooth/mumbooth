// Bundles @cloudflare/blindrsa-ts (pinned 0.4.6) for the browser: ES module, NOT minified. Output: ../web/js/vendor/blindrsa.js
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  stdin: { contents: "export { RSABSSA, BlindRSA, Params } from '@cloudflare/blindrsa-ts';", resolveDir: path.join(here, '..'), loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: false, legalComments: 'inline', sourcemap: false,
  banner: { js: '// @cloudflare/blindrsa-ts 0.4.6 (Apache-2.0), bundled unminified with esbuild by server/scripts/bundle-blindrsa.mjs. Exports: RSABSSA, BlindRSA, Params.' },
  outfile: path.join(here, '../../web/js/vendor/blindrsa.js'),
});
console.log('wrote web/js/vendor/blindrsa.js');
