// Core render pipeline for the Phase 1.0.2 risk spike: Satori (element tree ->
// SVG) + @resvg/resvg-wasm (SVG -> PNG), replacing the old Python app's
// `html2image` headless-browser screenshot approach (member_card/image.py).
//
// Pinned to satori@0.32.0 (one minor behind latest) and imported from its
// `/standalone` entry point rather than plain `satori` -- see the long
// comment on `ensureYogaInitialized` below for why. Short version: satori's
// default build (and every 0.33.x+ release) transitively depends on
// `harfbuzzjs` for OpenType text shaping, and harfbuzzjs is *not* fixable
// with a static WASM import the way `@resvg/resvg-wasm` and satori's own
// Yoga layout engine are -- it synthesizes and compiles small JS-to-WASM
// trampoline modules at runtime (Emscripten's `addFunction` /
// `convertJsFunctionToWasm`), unconditionally, on every single render, and
// that's a dynamic `new WebAssembly.Module(bytes)` call with no static asset
// to substitute. Confirmed empirically under `@cloudflare/vitest-plugin`
// (which runs on the same workerd runtime as `wrangler dev`/production):
// "CompileError: WebAssembly.Module(): Wasm code generation disallowed by
// embedder". 0.32.0 is the last release before harfbuzzjs was added
// (0.33.0), so pinning below it sidesteps the problem entirely -- acceptable
// here since this card template only needs plain Latin text, not the
// ligatures/complex-script shaping harfbuzzjs was added for.
import satori, { init as initYoga } from 'satori/standalone';
// Satori's own Yoga (flexbox layout engine) WASM binary, statically imported
// for the same reason `@resvg/resvg-wasm`'s WASM is below: Cloudflare
// Workers blocks *dynamic* WASM compilation (`WebAssembly.compile`/
// `instantiate` from raw bytes at request time), so every .wasm dependency
// has to be something Wrangler's esbuild-based bundler resolves to a
// `WebAssembly.Module` at build time instead. The default `satori` entry
// point loads this internally (base64-decode + instantiate at runtime),
// which is exactly the pattern that breaks -- `satori/standalone` exists
// specifically so callers can supply it via a static import instead (see
// the "Standalone Build" section of satori's own README).
import YOGA_WASM from 'satori/yoga.wasm';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
// Same static-import requirement as Yoga above. Wrangler has built-in
// support for `**/*.wasm` imports (no custom `[[rules]]` entry needed,
// unlike the font/image assets below).
import RESVG_WASM from '@resvg/resvg-wasm/index_bg.wasm';
// Raw font bytes -- Satori has no system-font resolution, so fonts must be
// supplied as TTF/OTF/WOFF buffers. Bundled as a static asset (see
// `assets/bungee-latin-400-normal.woff`, copied from the `@fontsource/bungee`
// devDependency -- see that package's WOFF file for provenance/license; it's
// a devDependency rather than a runtime one because the Worker never imports
// it directly, only the copied .woff file it ships -- and the `[[rules]]`
// entry this needs in wrangler.toml) rather than fetched at request time:
// it's ~18KB, never changes, and bundling means the render path has zero
// runtime network dependencies (also sidesteps the plan's warning that
// Satori's own remote image fetching fails silently on Workers -- see qr.ts
// / this file's logo handling, which embed everything as data URLs up front
// instead).
import bungeeFontData from './assets/bungee-latin-400-normal.woff';
// Placeholder crest logo (see assets/placeholder-logo.png and
// scripts/generate-placeholder-logo.mjs for how it was produced) -- a stand-in
// for the real Los Verdes crest, not a final asset. Bundled the same way as
// the font, for the same reason: Satori's built-in remote image fetching does
// not work on Workers (fails silently, per the plan), so every image handed
// to Satori is embedded as a base64 data URL by application code before the
// element tree is built.
import placeholderLogoPng from './assets/placeholder-logo.png';
import { buildQrCodeImage } from './qr';
import { buildCardTree, CARD_WIDTH, CARD_HEIGHT, type MembershipCardData } from './template';

let resvgInitPromise: Promise<void> | null = null;
let yogaInitPromise: Promise<void> | null = null;

/** `initWasm` throws if called more than once per isolate; guard it. */
function ensureResvgInitialized(): Promise<void> {
  if (!resvgInitPromise) {
    resvgInitPromise = initWasm(RESVG_WASM as unknown as WebAssembly.Module);
  }
  return resvgInitPromise;
}

function ensureYogaInitialized(): Promise<void> {
  if (!yogaInitPromise) {
    yogaInitPromise = initYoga(YOGA_WASM as unknown as WebAssembly.Module);
  }
  return yogaInitPromise;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunk to avoid blowing the call stack on `String.fromCharCode(...bytes)`
  // for larger images; not strictly necessary at this placeholder's size, but
  // cheap insurance for whatever real logo replaces it later.
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function renderMembershipCardPng(data: MembershipCardData): Promise<Uint8Array> {
  await Promise.all([ensureResvgInitialized(), ensureYogaInitialized()]);

  const logoDataUrl = `data:image/png;base64,${arrayBufferToBase64(placeholderLogoPng)}`;
  const qr = buildQrCodeImage(data.serialNumber);

  const tree = buildCardTree(data, {
    logoDataUrl,
    qrDataUrl: qr.dataUrl,
    qrSize: qr.size,
  });

  const svg = await satori(tree as never, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: [{ name: 'Bungee', data: bungeeFontData, weight: 400, style: 'normal' }],
  });

  // Satori has already converted all text to vector paths in the returned
  // SVG string, so resvg needs no font configuration of its own here.
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } });
  const rendered = resvg.render();
  const png = rendered.asPng();
  rendered.free();
  return png;
}
