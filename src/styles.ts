/**
 * The one stylesheet, served at `/assets/app.css`.
 *
 * Pages had no stylesheet at all until now -- a single inline `style`
 * attribute on `<body>` and system fonts everywhere -- so the new stack
 * carried none of the group's visual identity
 * (los-verdes/card-losverd-es#97). This is the smaller half of closing that
 * gap, and deliberately separate from the question of whether to adopt a
 * component framework: replicating the legacy look is a CSS problem, and no
 * framework would have written this file.
 *
 * Two thirds of the identity were already in the repository. The verde is the
 * colour the pass and card image already use, and Bungee is the display face
 * already bundled for the card image, so it costs one more route rather than
 * a new dependency. The missing third is houschka-rounded, the legacy body
 * face, which is licensed through Adobe Fonts and cannot be self-hosted --
 * body text therefore stays on the system stack, which also renders instantly
 * and matches the phone it is being read on.
 *
 * Kept as a string rather than a `.css` file because a Worker has no static
 * file serving: everything is either bundled or fetched from R2, and a string
 * is the honest version of "bundled".
 *
 * The pages honour a dark device (#141) by restating the custom properties
 * below under `prefers-color-scheme`, so a page's own rules never mention a
 * colour twice. Two things deliberately sit outside that: the card image and
 * the Wallet passes, which are artwork with fixed colours and look wrong
 * inverted, and the emailed card (`src/email/card.tsx`), because mail clients
 * neither load this stylesheet nor support the query reliably -- its colours
 * stay inline and light on purpose.
 */

/** Bright Verde, matching the pass and the card image. Artwork only on a
 * light page: at 2.85:1 on white it clears no WCAG threshold, so anything
 * that has to be read uses VERDE_INK instead (#143). */
export const VERDE = "#00B140";

/**
 * The verde that carries text and controls on a light page: headings,
 * links, button fills, the outlines of the member's actions. The same hue
 * as Bright Verde, darkened until it reads -- 6.78:1 on white -- and not a
 * new colour: it is the border the card image already draws around Bright
 * Verde (`BORDER_VERDE` in src/cardimage/template.ts), so the pair has been
 * seen together on every card. On a dark page Bright Verde itself reads
 * (6.24:1), so the token falls back to it there.
 */
export const VERDE_INK = "#046a29";

export const APP_CSS = `:root {
  /* Every colour on the site is one of these, so honouring a dark device is
     a matter of restating them rather than hunting down declarations. Pages
     name them by meaning (--danger, not a particular red) for the same
     reason: a red legible on white is not the red legible on near-black. */
  --verde: ${VERDE};
  --verde-ink: ${VERDE_INK};
  --ink: #14181f;
  --bg: #fff;
  --muted: #555;
  --rule: #d8e8dd;
  --danger: #b00020;
  --success: #137333;
  --warn: #a15c00;

  /* Lets the browser dark-render what we don't control: form fields, the
     canvas behind a short page, scrollbars. Without it those stay white and
     the page comes apart at the edges. */
  color-scheme: light dark;
}

/* Honouring a dark device (#141). Only the tokens change; no rule below is
   restated, which is what keeps the two modes from drifting apart.

   Every value clears 4.5:1 against --bg, except --rule, which only has to be
   seen rather than read -- a hairline as bright as text turns the admin
   tables into stripes. The light palette's colours all fail when inverted
   (--muted 2.39:1, --danger 2.43, --success 2.99, --warn 3.43), so these are
   lighter, less saturated versions of the same hues rather than the same
   values reused.

   --verde stays as it is: #00B140 measures 6.24:1 here, better than the
   2.85 it manages on white, which is why --verde-ink can simply become it --
   the darker shade exists for the light page, and here it would be the one
   that fails (2.63:1). */
@media (prefers-color-scheme: dark) {
  :root {
    /* Near-black rather than #000: pure black behind light text haloes on
       OLED, and the page reads as harsher than the light one. */
    --bg: #14181f;
    --verde-ink: ${VERDE};
    --ink: #e7eaee;
    --muted: #a7b0bd;
    --rule: #2b323c;
    --danger: #ff9d9d;
    --success: #7fd69a;
    --warn: #e8bd76;
  }
}

/* Bungee is a display face: all caps, heavy, for headings only. Swap rather
   than block -- a heading in the system font for one frame beats a blank
   page on a slow connection at a stadium gate. */
@font-face {
  font-family: "Bungee";
  src: url("/assets/bungee.woff") format("woff");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

body {
  margin: 2rem auto;
  padding: 0 1rem;
  color: var(--ink);
  background: var(--bg);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.5;
}

/* The member's own pages: one narrow centred column, which is the shape that
   works on a phone held at a gate.
   The measure is on the column rather than the body so that anything outside
   it -- today only the admin nav, shown to admins on their own card -- can be
   as wide as it needs without widening the card for everyone else. */
body.member {
  text-align: center;
}

body.member main {
  max-width: 28rem;
  margin: 0 auto;
}

/* Admin pages are tables, and tables want room. */
body.admin {
  max-width: 72rem;
  margin: 1.5rem auto;
}

/* No image, whatever its intrinsic size, may be wider than what holds it.
   The card carries its own sizing inline as well; this is the net for
   anything added later that forgets. */
img {
  max-width: 100%;
}

h1, h2, h3 {
  font-family: "Bungee", system-ui, sans-serif;
  color: var(--verde-ink);
  line-height: 1.2;
}

body.member h1 {
  font-size: 1.6rem;
}

a {
  color: var(--verde-ink);
}

/* The label is the page background's colour rather than white: on a light
   page that is white on the darker verde, on a dark page near-black on
   Bright Verde -- the legacy site's own button -- and both read, where white
   on Bright Verde does not. */
button {
  font: inherit;
  color: var(--bg);
  background: var(--verde-ink);
  border: 0;
  border-radius: 0.5rem;
  padding: 0.6rem 1.2rem;
  cursor: pointer;
}

/* A submitted form's button, while the next page loads (src/formBusy.ts).
   Dimmed with a small spinner before the label; the spinner holds still for
   anyone who has asked for less motion, and the label change still says it. */
button[aria-disabled="true"] {
  cursor: progress;
  opacity: 0.75;
}

button[aria-disabled="true"]::before {
  content: "";
  display: inline-block;
  width: 0.8em;
  height: 0.8em;
  margin-right: 0.5em;
  vertical-align: -0.1em;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: busy-spin 0.8s linear infinite;
}

@keyframes busy-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  button[aria-disabled="true"]::before {
    animation: none;
  }
}

/* The member's actions -- wallet passes, emailing a card. Outlined rather
   than filled: there are several in a row, and a column of solid green
   blocks reads as a warning rather than as a menu. */
.action {
  display: block;
  margin: 0.75rem 0;
  padding: 0.75rem;
  border: 1px solid var(--verde-ink);
  border-radius: 0.5rem;
  color: inherit;
  text-decoration: none;
}

/* The membership card. The width and height attributes on the element give
   the browser its aspect ratio before the image exists, so the space is
   reserved and nothing below moves when it arrives; these rules make that
   reserved space look
   deliberate rather than like a gap. The tint is the card's own background,
   so what appears first is the right shape and roughly the right colour, and
   the image resolves into it. */
.card-image {
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--verde) 12%, var(--bg));
}

.order {
  margin: 0.75rem 0;
  padding: 0.75rem;
  border: 1px solid var(--rule);
  border-radius: 0.5rem;
  text-align: left;
}

.muted {
  margin: 0.25rem 0 0;
  color: var(--muted);
  font-size: 0.9rem;
}

/* The readiness page's manual steps. Ticking one is only a way of keeping
   your place while working down a long list on a second screen -- there is no
   JavaScript here and nothing is stored, so a reload starts over, which is
   the honest behaviour for a list whose real state lives in the world rather
   than in the page. Checked steps fade and strike through rather than
   disappearing, so the list keeps its shape and you can see what is left
   against what is done. */
ul.checklist {
  list-style: none;
  padding-left: 0;
}

ul.checklist label {
  display: flex;
  gap: 0.55rem;
  align-items: baseline;
  padding: 0.3rem 0;
  cursor: pointer;
}

ul.checklist input {
  accent-color: var(--verde-ink);
  flex: none;
}

ul.checklist input:checked + span {
  text-decoration: line-through;
  color: var(--muted);
}

/*
 * The admin navigation. Eleven links in one middot-separated run were
 * unreadable -- every destination looked equally important and finding one
 * meant reading all of them. Grouped instead, with the group's name carrying
 * the shared word so each link only has to say what makes it different:
 * "Active" under Reports rather than "Active memberships" among everything
 * else.
 *
 * Flex with wrapping rather than a fixed row, because the admin pages are
 * read on a phone at a match as often as at a desk, and a group is the right
 * unit to wrap at.
 */
nav.admin-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.4rem;
  align-items: baseline;
  margin-bottom: 1.25rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--rule);
}

nav.admin-nav .nav-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.6rem;
  align-items: baseline;
}

/*
 * Small and quiet: it labels the group rather than competing with the links
 * inside it, and it is not itself a destination.
 */
nav.admin-nav .nav-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

nav.admin-nav a {
  white-space: nowrap;
}

/* On a member page the nav is the one wide thing on a narrow page, and the
   only left-aligned one. */
body.member nav.admin-nav {
  max-width: 72rem;
  margin: 0 auto 1.25rem;
  text-align: left;
}

/* The page you are already on: still in its place in the nav, so the shape
   of the list doesn't change as you move around it, but not offering to take
   you where you are. */
nav.admin-nav .nav-here {
  color: var(--muted);
}

/* A report of things wanting action, with nothing in it: still a link, but
   one that steps back so the ones with something in them stand out. */
nav.admin-nav a.nav-quiet {
  color: var(--muted);
}

/* How many rows such a report has. Warn rather than danger: these are
   questions for a person, not failures. */
nav.admin-nav .nav-count {
  display: inline-block;
  min-width: 1.4em;
  padding: 0 0.4em;
  border-radius: 0.7em;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  color: var(--bg);
  background: var(--warn);
}
`;

/**
 * A short content hash of the stylesheet, and the path it is served at.
 *
 * The pages that link this are generated per request and never cached; the
 * stylesheet was cached for an hour. So for up to an hour after a deploy a
 * browser held new HTML and the previous stylesheet, and any rule the new
 * HTML depended on simply was not there. That is not hypothetical: moving
 * the card image's sizing into a class did exactly this, and the card
 * overflowed every phone that had the old file (#174).
 *
 * Naming the file after its contents removes the failure entirely. The HTML
 * asks for the stylesheet it was built against, so a browser either has that
 * exact file or fetches it -- there is no version of this in which the two
 * disagree. It can then be cached forever, which is also faster than the
 * hour-long compromise it replaces.
 *
 * The same reasoning as `PASS_CONTENT_VERSION` in src/passkit/generator.ts:
 * a cached thing needs to know which version of its source it came from.
 *
 * FNV-1a rather than SHA-256: this only has to change when the bytes change,
 * and a synchronous 32-bit hash does that without making module
 * initialisation asynchronous. A collision would serve a stale stylesheet,
 * which is the bug we already have, not a worse one.
 */
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Where a given stylesheet would be served. Exported so a test can show the path moves with the content. */
export function stylesheetPathFor(css: string): string {
  return `/assets/app.${contentHash(css)}.css`;
}

/** What every page links, and what `src/assets.ts` serves immutably. */
export const STYLESHEET_PATH = stylesheetPathFor(APP_CSS);
