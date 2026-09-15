// Ambient module declarations for the non-JS static assets this spike bundles
// directly into the Worker via Wrangler's build-time bundler (see wrangler.toml
// `[[rules]]`). None of these are resolved at runtime — Wrangler/esbuild inlines
// the bytes at build time, which is required on Workers since dynamic WASM
// compilation is blocked (see render.ts for the `@resvg/resvg-wasm` import).

declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

declare module '*.woff' {
  const fontData: ArrayBuffer;
  export default fontData;
}

declare module '*.png' {
  const imageData: ArrayBuffer;
  export default imageData;
}
