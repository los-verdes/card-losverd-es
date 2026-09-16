// Production render pipeline, promoted from the Phase 1.0.2 risk spike
// (src/spikes/card-rendering/render.ts): Satori (element tree -> SVG) +
// @resvg/resvg-wasm (SVG -> PNG), replacing the old Python app's
// `html2image` headless-browser screenshot approach (member_card/image.py).
// See that spike's own comments for the full rationale behind the WASM
// static-import requirements and the satori@0.32.0 pin (harfbuzzjs
// incompatibility) -- unchanged here, just promoted.
//
// What changed from the spike: the crest logo is a parameter (see
// `renderMembershipCardPng`'s `logoPngBytes`) instead of a bundled
// synthetic placeholder, so the caller supplies it -- expected to be the
// same real R2-hosted asset PassKit's routes already fetch
// (`templates/apple/icon.png` or `icon@2x.png`, Phase 3.1), keeping one
// crest image rather than a second copy specific to card images. The font
// stays bundled at build time, same as the spike: it's a fixed design
// asset, not something that needs R2's runtime-swappable flexibility the
// way branding images do.
import satori, { init as initYoga } from 'satori/standalone';
import YOGA_WASM from 'satori/yoga.wasm';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import RESVG_WASM from '@resvg/resvg-wasm/index_bg.wasm';
import bungeeFontData from './assets/bungee-latin-400-normal.woff';
import { formatShortDate } from '../lib/dateFormat';
import { buildQrCodeImage } from './qr';
import { buildCardTree, CARD_WIDTH, CARD_HEIGHT, type MembershipCardMember } from './template';

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunk to avoid blowing the call stack on `String.fromCharCode(...bytes)`
  // for larger images.
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Renders a member's membership card as a PNG, matching the visual design
 * validated in the Phase 1.0.2 risk spike (a sample render was sent to Jeff
 * for sign-off -- see PR #4). `logoPngBytes` is the crest image bytes
 * (expected to be R2-sourced by the caller, not fetched here -- keeps this
 * function pure/testable without an R2 fixture per test, matching
 * `passkit/generator.ts#assemblePassBundle`'s pattern of accepting assets
 * as parameters).
 */
export async function renderMembershipCardPng(
  member: MembershipCardMember,
  logoPngBytes: Uint8Array,
): Promise<Uint8Array> {
  await Promise.all([ensureResvgInitialized(), ensureYogaInitialized()]);

  const logoDataUrl = `data:image/png;base64,${bytesToBase64(logoPngBytes)}`;
  const qr = buildQrCodeImage(member.memberId);
  const expirationLabel = member.expirationDate
    ? `Good through ${formatShortDate(member.expirationDate)}`
    : null;

  const tree = buildCardTree(member, expirationLabel, {
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
