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

export const CARD_WIDTH = 1050;
export const CARD_HEIGHT = 660;

const BRIGHT_VERDE = '#00b140';
const BORDER_VERDE = '#046a29';
const WHITE = '#ffffff';

export interface MembershipCardMember {
  firstName: string;
  lastName: string;
  membershipTier: string;
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
): SatoriElement {
  // The real crest (see render.ts) is already circular within its own
  // square canvas, so a further borderRadius mask is a no-op visually, not
  // a double-circle artifact -- kept anyway since a future logo swap isn't
  // guaranteed to already be circular.
  const logo: SatoriElement = {
    type: 'img',
    props: {
      src: images.logoDataUrl,
      width: 120,
      height: 120,
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

  const memberInfoChildren: (SatoriElement | string)[] = [
    textNode(`${member.firstName} ${member.lastName}`, { fontSize: 46, color: WHITE }),
    textNode(member.membershipTier, { fontSize: 26, color: '#e7fbef', marginTop: 10 }),
  ];
  for (const label of [labels.memberSince, labels.expiration]) {
    if (label) {
      memberInfoChildren.push(
        textNode(label, { fontSize: 20, color: '#d8f5e4', marginTop: 8 }),
      );
    }
  }

  const memberInfoBlock: SatoriElement = {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', maxWidth: 680 },
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
        backgroundColor: WHITE,
        padding: 16,
        borderRadius: 20,
      },
      children: [
        { type: 'img', props: { src: images.qrDataUrl, width: images.qrSize, height: images.qrSize } },
        textNode(member.memberId, { fontSize: 14, color: BRIGHT_VERDE, marginTop: 8 }),
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
