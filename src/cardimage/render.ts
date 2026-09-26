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
import { bytesToBase64 } from '../lib/base64';
import { formatMonthYear, formatShortDate } from '../lib/dateFormat';
import { buildQrCodeImage } from './qr';
import { CLASSIC_THEME, type CardThemeColors } from '../themes/cardTheme';
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

/**
 * Renders a member's membership card as a PNG, matching the visual design
 * validated in the Phase 1.0.2 risk spike (a sample render was reviewed
 * for sign-off -- see PR #4). `logoPngBytes` is the crest image bytes
 * (expected to be R2-sourced by the caller, not fetched here -- keeps this
 * function pure/testable without an R2 fixture per test, matching
 * `passkit/generator.ts#assemblePassBundle`'s pattern of accepting assets
 * as parameters).
 */
export async function renderMembershipCardPng(
  member: MembershipCardMember,
  logoPngBytes: Uint8Array,
  colors: CardThemeColors = CLASSIC_THEME.colors,
): Promise<Uint8Array> {
  await Promise.all([ensureResvgInitialized(), ensureYogaInitialized()]);

  // Embedded as a data URL, not handed to Satori as a URL to fetch. Satori's
  // own remote image fetching does not work in the Workers runtime and fails
  // *silently* -- the image is simply absent from the output, with no error
  // to notice. Anything referenced by the card template has to be fetched by
  // this code and inlined before Satori sees it. (Found in the Phase 1.0.2
  // spike; recorded here because this line is where it would be undone.)
  const logoDataUrl = `data:image/png;base64,${bytesToBase64(logoPngBytes)}`;
  const qr = buildQrCodeImage(member.verifyUrl);
  const memberSinceLabel = member.memberSince
    ? `Member since ${formatMonthYear(member.memberSince)}`
    : null;
  const expirationLabel = member.expirationDate
    ? `Good through ${formatShortDate(member.expirationDate)}`
    : null;

  const tree = buildCardTree(
    member,
    { memberSince: memberSinceLabel, expiration: expirationLabel },
    { logoDataUrl, qrDataUrl: qr.dataUrl, qrSize: qr.size },
    colors,
  );

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
