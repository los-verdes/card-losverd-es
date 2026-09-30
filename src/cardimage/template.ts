// Production card layout, promoted from the Phase 1.0.2 risk spike
// (src/spikes/card-rendering/template.ts) -- re-authored against Satori's
// supported CSS subset (flexbox only -- no CSS grid, no arbitrary
// selectors, no `calc()`/viewport units), inspired by the old Python app's
// `member_card/templates/card_image.html.j2` + `macros.html.j2`
// (`membership_card` macro) rather than a direct port. See that spike's own
// comments for the fuller rationale; this file only documents what changed
// on promotion to production.
//
// What changed from the spike: real member fields (matching the D1
// `members` schema shape used elsewhere, e.g. `passkit/generator.ts`)
// instead of a loose pre-formatted-string shape, and the crest logo is
// supplied by the caller rather than a bundled synthetic placeholder -- see
// render.ts.

import { CLASSIC_THEME, type CardThemeColors } from '../themes/cardTheme';

/**
 * Bump when a change here or in render.ts alters how a card is drawn: its
 * layout, text, sizes or anything else a member would see. Drawn cards are
 * cached in R2 (`renderCardImage()` in src/member/artifacts.ts) and redrawn
 * only when the member, their theme or this changes, so a change to the
 * drawing that leaves this alone would reach nobody whose card is cached. The
 * same discipline as `PASS_CONTENT_VERSION`.
 */
export const CARD_IMAGE_VERSION = "2026-09-30.1";

export const CARD_WIDTH = 1050;
export const CARD_HEIGHT = 660;

/**
 * The crest's rendered size, in px. It was 120, which left it small against a
 * mostly empty top-left of the card; 240 fills that space, still clears the
 * QR code, and stays just under the crest image's own 256x256
 * (`templates/card/crest.png`) -- larger than that and it would be scaled up
 * past its pixels and blur.
 */
export const CREST_SIZE = 240;

// The QR code's box stays white whatever the theme: a scanner needs the
// contrast, and it is not the theme's to change.
const QR_BOX = '#ffffff';

/** Characters of card number that fit on one line under the QR code. */
const CARD_NUMBER_LINE_LENGTH = 21;

/** Space kept between the name and the QR code's box, in px. */
const NAME_QR_GAP = 24;

/**
 * The name's font size, in px: full size for most names, smaller for long
 * ones, so that even the longest a card allows (`MAX_DISPLAY_NAME_LENGTH`,
 * 64 characters) stays within three lines beside the QR code and clear of
 * the crest above. The name shares the bottom row with the QR code's box,
 * which keeps its own width; the name takes the rest, about 680px, and wraps
 * within it. Bungee is wide -- about 0.69em a character, more for M and W --
 * so at 46px that is roughly 21 characters a line, at 38px 26, at 32px 31.
 */
export function nameFontSize(name: string): number {
  const length = [...name].length;
  if (length <= 40) return 46;
  if (length <= 52) return 38;
  return 32;
}

/**
 * The card number, as the lines it is printed on under the QR code: split at
 * the hyphen nearest its middle, so the box is no wider than the code. On one
 * line, an `LV-` number is nearly twice the code's width, which took that
 * space from the name. A number short enough to fit the box's width on one
 * line, or with no hyphen to split at, stays on one line.
 */
export function cardNumberLines(memberId: string): string[] {
  if (memberId.length <= CARD_NUMBER_LINE_LENGTH) return [memberId];
  const middle = memberId.length / 2;
  let best = -1;
  for (let i = memberId.indexOf("-"); i !== -1; i = memberId.indexOf("-", i + 1)) {
    if (best === -1 || Math.abs(i - middle) < Math.abs(best - middle)) best = i;
  }
  return best <= 0 ? [memberId] : [memberId.slice(0, best + 1), memberId.slice(best + 1)];
}

export interface MembershipCardMember {
  firstName: string;
  lastName: string;
  /** == the pass's serialNumber; shown under the QR code. */
  memberId: string;
  /** Signed `/verify-pass` URL encoded in the QR code (`buildVerifyPassUrl`). */
  verifyUrl: string;
  /** ISO8601 `YYYY-MM-DD`, or `null` for a membership with no expiry on record. */
  expirationDate: string | null;
  /** ISO8601 `YYYY-MM-DD`, or `null` when neither an order nor an override supplies one. */
  memberSince: string | null;
}

export interface CardImages {
  /** `data:image/png;base64,...` crest logo. */
  logoDataUrl: string;
  /** `data:image/svg+xml;base64,...` QR code. */
  qrDataUrl: string;
  /** QR image is always square; this is both width and height in px. */
  qrSize: number;
  /** `data:image/png;base64,...` background art, or absent for a plain background. */
  backgroundDataUrl?: string;
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

/** Pre-formatted date lines, in the order they appear; `null` leaves a line off entirely. */
export interface CardLabels {
  memberSince: string | null;
  expiration: string | null;
}

export function buildCardTree(
  member: MembershipCardMember,
  labels: CardLabels,
  images: CardImages,
  colors: CardThemeColors = CLASSIC_THEME.colors,
): SatoriElement {
  // The real crest (see render.ts) is already circular within its own
  // square canvas, so a further borderRadius mask is a no-op visually, not
  // a double-circle artifact -- kept anyway since a future logo swap isn't
  // guaranteed to already be circular.
  const logo: SatoriElement = {
    type: 'img',
    props: {
      src: images.logoDataUrl,
      width: CREST_SIZE,
      height: CREST_SIZE,
      style: { borderRadius: 999 },
    },
  };

  const titleBlock: SatoriElement = {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
      children: [
        textNode('LOS VERDES', { fontSize: 56, lineHeight: 1.05, color: colors.text }),
        textNode('MEMBERSHIP CARD', { fontSize: 36, lineHeight: 1.15, color: colors.text }),
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

  const name = `${member.firstName} ${member.lastName}`.trim();
  const memberInfoChildren: (SatoriElement | string)[] = [
    // `break-word` breaks a single word only when it would not otherwise fit
    // a line, rather than letting it run off the edge.
    textNode(name, { fontSize: nameFontSize(name), lineHeight: 1.15, color: colors.text, wordBreak: 'break-word' }),
  ];
  for (const label of [labels.memberSince, labels.expiration]) {
    if (label) {
      memberInfoChildren.push(
        textNode(label, { fontSize: 20, color: colors.secondaryText, marginTop: 8 }),
      );
    }
  }

  const memberInfoBlock: SatoriElement = {
    type: 'div',
    props: {
      // Whatever the QR code's box leaves: growing to fill it, and shrinking
      // below its content's width (`minWidth: 0`) so a long name wraps
      // instead of pushing the box off the card.
      style: { display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
      children: memberInfoChildren,
    },
  };

  const qrBlock: SatoriElement = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        backgroundColor: QR_BOX,
        padding: 16,
        borderRadius: 20,
        flexShrink: 0,
      },
      children: [
        { type: 'img', props: { src: images.qrDataUrl, width: images.qrSize, height: images.qrSize } },
        ...cardNumberLines(member.memberId).map((line, i) =>
          textNode(line, { fontSize: 14, lineHeight: 1.3, color: colors.qrLabel, marginTop: i === 0 ? 8 : 0 }),
        ),
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
        gap: NAME_QR_GAP,
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
        backgroundColor: colors.background,
        // Art is drawn over the background colour and under the border, and
        // stretched to the card's full size (ARTWORK_SIZES.cardBackground).
        ...(images.backgroundDataUrl
          ? {
              backgroundImage: `url(${images.backgroundDataUrl})`,
              backgroundSize: `${CARD_WIDTH}px ${CARD_HEIGHT}px`,
              backgroundRepeat: 'no-repeat',
            }
          : {}),
        borderRadius: 48,
        border: `14px solid ${colors.border}`,
        fontFamily: 'Bungee',
      },
      children: [topRow, bottomRow],
    },
  };
}
