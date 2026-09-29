# Year theme artwork

Each year's card theme (`YEAR_THEMES` in `src/themes/cardTheme.ts`) takes its
artwork from that year's membership scarf. The scarf designs themselves are
kept in the shared Los Verdes Google Drive, or with the Merch Team, and are
not committed here; only what is cut from them is.

Every year has the same files, at the sizes in `ARTWORK_SIZES`:

| File | Size | Where it shows |
| --- | --- | --- |
| `card-background.png` | 1050 x 660 | Under everything on the card image |
| `apple/thumbnail.png`, `@2x`, `@3x` | 90, 180, 270 square | Beside the name on the Apple pass |
| `google-hero.png` | 1032 x 336 | Across the bottom of the Google pass |

Deploys upload everything under `assets/templates/` to R2
(`just r2-upload-templates`).

## Legibility

The card's crest, title, name and QR code cover most of it, so the background
art always sits under text. A dark design is darkened further so white text
reads over it; a light one keeps its light ground and takes dark text. The
theme's colours are checked for contrast (`test/themes/cardTheme.spec.ts`),
but the art is not, so look at a rendered card, with a long name, before
adding one.

## How each year was made

- **2020 (MMXX).** One column of pixels through the scarf's serape stripes,
  turned to run upright and stretched to size. The card darkens it 58%; the
  hero and thumbnail use it as it is.
- **2021 (inaugural season).** The card and thumbnail use the scarf's back:
  the skull and its rings as a band across black, darkened 45% on the card.
  The hero is the whole front, "Listos / Los Verdes / MMXXI", on black.
- **2022 ("Verde hasta la muerte").** The doodle pattern, cut in strips from
  above the motto (so no lettering), stacked, softened slightly and reduced to
  16 colours, then darkened 45% on the card. Without the softening the
  mockup's fabric weave makes a 1.8 MB image. The hero is the motto side.
- **2023 ("i love you verde").** The mint ground, with the aloe from the
  scarf's right-hand end rising behind the QR code. The only light theme, so
  its text is black. The hero is the whole scarf on mint.

## Adding a year

A pull request with that year's files here and an entry in `YEAR_THEMES`:
its label, and colours whose text passes the contrast check. The Apple and
Google passes use the theme's background colour as it is, so pick it from the
artwork's own ground. Bump a theme's `version` whenever its images or
colours change, so cached passes are rebuilt.
