// Re-authored card layout, inspired by the old Python app's
// `member_card/templates/card_image.html.j2` + `macros.html.j2` (`membership_card`
// macro) and `member_card/static/scss/style.scss`. This is a re-implementation
// against Satori's supported CSS subset (flexbox only -- no CSS grid, no
// arbitrary selectors, no `calc()`/viewport units), not a port: the original
// uses a 12-column `mdl-grid`, `calc(Npx + Nvh)` responsive font sizing, and a
// tiled background-pattern image, none of which Satori can express directly.
//
// Visual elements carried over: green card face with a darker green border and
// rounded corners, a circular crest/logo badge in the top-left, a bold white
// display-font title in the top-right, the member's name + tier + "good
// through" date in the bottom-left, and (new for this spike, replacing the
// pass-only QR code) a QR/barcode placeholder in the bottom-right so the card
// image itself doubles as a scannable membership card.

export const CARD_WIDTH = 1050;
export const CARD_HEIGHT = 660;

const BRIGHT_VERDE = '#00b140';
const BORDER_VERDE = '#046a29';
const WHITE = '#ffffff';

export interface MembershipCardData {
  memberName: string;
  membershipTier: string;
  serialNumber: string;
  /** Pre-formatted, e.g. "Good through Dec 31, 2026" -- mirrors `aux_info_text` in the old template. */
  expirationLabel: string;
}

export interface CardImages {
  /** `data:image/png;base64,...` placeholder crest logo. */
  logoDataUrl: string;
  /** `data:image/svg+xml;base64,...` QR code. */
  qrDataUrl: string;
  /** QR image is always square; this is both width and height in px. */
  qrSize: number;
}

/**
 * A loose structural type for the plain-object element tree Satori expects
 * (it accepts anything shaped like a React element, but this project has no
 * React/JSX dependency -- see render.ts for why `as never` is used at the
 * `satori()` call site instead of pulling in `@types/react` just for this).
 */
export interface SatoriElement {
  type: string;
  props: {
    style?: Record<string, string | number>;
    children?: SatoriElement | string | Array<SatoriElement | string>;
    [key: string]: unknown;
  };
}

function textNode(text: string, style: Record<string, string | number>): SatoriElement {
  return { type: 'div', props: { style, children: text } };
}

export function buildCardTree(data: MembershipCardData, images: CardImages): SatoriElement {
  const logo: SatoriElement = {
    type: 'img',
    props: {
      src: images.logoDataUrl,
      width: 150,
      height: 150,
      style: { borderRadius: 999 },
    },
  };

  const titleBlock: SatoriElement = {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
      children: [
        textNode('LOS VERDES', { fontSize: 56, lineHeight: 1.05, color: WHITE }),
        textNode('MEMBERSHIP CARD', { fontSize: 36, lineHeight: 1.15, color: WHITE }),
      ],
    },
  };

  const topRow: SatoriElement = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        width: '100%',
      },
      children: [logo, titleBlock],
    },
  };

  const memberInfoBlock: SatoriElement = {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', maxWidth: 680 },
      children: [
        textNode(data.memberName, { fontSize: 46, color: WHITE }),
        textNode(data.membershipTier, { fontSize: 26, color: '#e7fbef', marginTop: 10 }),
        textNode(data.expirationLabel, { fontSize: 20, color: '#d8f5e4', marginTop: 8 }),
      ],
    },
  };

  const qrBlock: SatoriElement = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        backgroundColor: WHITE,
        padding: 16,
        borderRadius: 20,
      },
      children: [
        { type: 'img', props: { src: images.qrDataUrl, width: images.qrSize, height: images.qrSize } },
        textNode(data.serialNumber, { fontSize: 14, color: BRIGHT_VERDE, marginTop: 8 }),
      ],
    },
  };

  const bottomRow: SatoriElement = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        width: '100%',
      },
      children: [memberInfoBlock, qrBlock],
    },
  };

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        padding: 56,
        backgroundColor: BRIGHT_VERDE,
        borderRadius: 48,
        border: `14px solid ${BORDER_VERDE}`,
        fontFamily: 'Bungee',
      },
      children: [topRow, bottomRow],
    },
  };
}
