// One-off script (not part of the Worker build) used to generate
// `../assets/placeholder-logo.png`. Run with `node` from the repo root:
//
//   node src/spikes/card-rendering/scripts/generate-placeholder-logo.mjs
//
// Uses @resvg/resvg-wasm (already a project dependency for the render
// pipeline itself) to rasterize a simple text-free vector badge -- a stand-in
// for the real Los Verdes crest logo, which this spike doesn't have rights/
// assets to embed. Text-free deliberately: resvg's Node build doesn't resolve
// system fonts here, so any <text> in this SVG silently fails to render.
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { readFile, writeFile } from 'node:fs/promises';

const wasmBytes = await readFile(
  new URL('../../../../node_modules/@resvg/resvg-wasm/index_bg.wasm', import.meta.url),
);
await initWasm(wasmBytes);

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <circle cx="120" cy="120" r="112" fill="#ffffff" />
  <circle cx="120" cy="120" r="112" fill="none" stroke="#00b140" stroke-width="10" />
  <circle cx="120" cy="120" r="88" fill="none" stroke="#00b140" stroke-width="4" />
  <circle cx="120" cy="120" r="38" fill="#00b140" />
  <g fill="#ffffff">
    <polygon points="120,96 130,116 152,116 134,129 141,150 120,137 99,150 106,129 88,116 110,116" />
  </g>
  <g stroke="#00b140" stroke-width="3">
    <line x1="120" y1="52" x2="120" y2="70" />
    <line x1="120" y1="170" x2="120" y2="188" />
    <line x1="52" y1="120" x2="70" y2="120" />
    <line x1="170" y1="120" x2="188" y2="120" />
  </g>
</svg>
`;

const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 240 } });
const png = resvg.render().asPng();
await writeFile(new URL('../assets/placeholder-logo.png', import.meta.url), png);
console.log('wrote', png.length, 'bytes to assets/placeholder-logo.png');
