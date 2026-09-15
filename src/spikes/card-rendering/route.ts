// Phase 1.0.2 risk spike route. Not wired into any real member/pass data --
// this exists purely to prove out the Satori + @resvg/resvg-wasm rendering
// pipeline on Workers ahead of the real card-generation implementation.
import { Hono } from 'hono';
import { renderMembershipCardPng } from './render';
import type { MembershipCardData } from './template';

export const cardRenderingSpike = new Hono();

const SAMPLE_CARD: MembershipCardData = {
  memberName: 'Jane Fan',
  membershipTier: 'Adult Member',
  serialNumber: 'LV-10023',
  expirationLabel: 'Good through Dec 31, 2026',
};

cardRenderingSpike.get('/', async (c) => {
  const query = c.req.query();
  const data: MembershipCardData = {
    memberName: query.name ?? SAMPLE_CARD.memberName,
    membershipTier: query.tier ?? SAMPLE_CARD.membershipTier,
    serialNumber: query.serial ?? SAMPLE_CARD.serialNumber,
    expirationLabel: query.expires ?? SAMPLE_CARD.expirationLabel,
  };

  const png = await renderMembershipCardPng(data);

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    },
  });
});
