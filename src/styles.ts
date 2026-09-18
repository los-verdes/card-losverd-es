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
 */

/** The group's green, matching the pass and the card image. */
export const VERDE = "#00B140";

export const APP_CSS = `:root {
  --verde: ${VERDE};
  --ink: #14181f;
  --muted: #555;
  --rule: #d8e8dd;
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
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.5;
}

/* The member's own pages: one narrow centred column, which is the shape that
   works on a phone held at a gate. */
body.member {
  max-width: 28rem;
  text-align: center;
}

/* Admin pages are tables, and tables want room. */
body.admin {
  max-width: 72rem;
  margin: 1.5rem auto;
}

h1, h2, h3 {
  font-family: "Bungee", system-ui, sans-serif;
  color: var(--verde);
  line-height: 1.2;
}

body.member h1 {
  font-size: 1.6rem;
}

a {
  color: var(--verde);
}

button {
  font: inherit;
  color: #fff;
  background: var(--verde);
  border: 0;
  border-radius: 0.5rem;
  padding: 0.6rem 1.2rem;
  cursor: pointer;
}

/* The member's actions -- wallet passes, emailing a card. Outlined rather
   than filled: there are several in a row, and a column of solid green
   blocks reads as a warning rather than as a menu. */
.action {
  display: block;
  margin: 0.75rem 0;
  padding: 0.75rem;
  border: 1px solid var(--verde);
  border-radius: 0.5rem;
  color: inherit;
  text-decoration: none;
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

nav.admin-nav {
  margin-bottom: 1rem;
}
`;
