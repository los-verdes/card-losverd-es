# Year theme artwork

Each year's card theme (`YEAR_THEMES` in `src/themes/cardTheme.ts`) takes its
artwork from that year's membership scarf. The scarf designs themselves are
kept in the shared Los Verdes Google Drive, or with the Merch Team, and are
not committed here; only what is cut from them is. The print files sent to
the scarf maker are the best source: flat, full resolution, and free of the
folds and lighting in product photos.

Every year has the same files, at the sizes in `ARTWORK_SIZES`:

| File | Size | Where it shows |
| --- | --- | --- |
| `card-background.png` | 1050 x 660 | Under everything on the card image |
| `apple-poster/poster.png`, `@2x`, `@3x` | 358 x 448 pt (1074 x 1344 at 3x) | Behind the whole Apple pass on iOS 27 and later (`artwork.png` in the pass) |
| `apple-poster/primaryLogo.png`, `@2x`, `@3x` | 100 x 23 pt | The logo at the top of the Apple poster: light over dark art, dark over light |
| `apple/thumbnail.png`, `@2x`, `@3x` | 90, 180, 270 square | Beside the name on the Apple pass before iOS 27 |
| `google-hero.png` | 1032 x 812 | Full width under the details of the Google pass |

The Apple poster and the Google hero show the same design, each composed for
its own shape. Everything under `assets/templates/` is bundled with the Worker
on each deploy, and ships and rolls back with the code that reads it.

## Legibility

The card's crest, title, name and QR code cover most of it, so the background
art always sits under text. A dark design is darkened further so white text
reads over it; a light one keeps its light ground and takes dark text. The
theme's colours are checked for contrast (`test/themes/cardTheme.spec.ts`),
but the art is not, so look at a rendered card, with a long name, before
adding one.

The Apple poster has its own layout, checked on an iPhone running iOS 27
(2026-09-29): the header sits over the top of the art, the QR code over its
middle (about 30-70% across and 49-78% down), and the name and footer in a
darkened strip across the bottom quarter. Wallet also trims about 5% off each
side. So the art's subject belongs in the top half, clear of the sides.

## How each year was made

- **2020 (MMXX).** One column of pixels through the scarf's serape stripes.
  Turned upright and stretched for the card (darkened 58%) and the hero; left
  running across, as the scarf hangs, for the poster (darkened 35%).
- **2021 (inaugural season).** The scarf's back: the skull and its rings on
  black, darkened 45% on the card. The poster and hero show the skull and its
  rays at the top and middle respectively.
- **2022 ("Verde hasta la muerte").** The doodle pattern from its source image
  inside the scarf's print file, at the scale and angle (8 degrees) the scarf
  used and with its lightness -20, so the colours are the printed ones.
  Darkened 30% on the card and 25% on the poster.
- **2023 ("i love you verde").** The flags from the scarf's papel picado side,
  lifted off their black and set, with a soft shadow, in two rows ("LOS" and
  the skull, then "VERDES") on the mint of the scarf's other side. Faded 68%
  towards the mint on the card, so its dark text reads.

## Subgroup themes

A subgroup theme (`GROUP_THEMES`) is for the members of one subgroup
(`CARD_GROUPS` in `src/themes/groups.ts`), and keeps its files under its own
id here rather than a year.

- **Los Pringles (`los-pringles/`).** The centre of the back of the Los
  Pringles scarf, the all-seeing Pringle on black, with the flying Pringles
  either side. The scarf's end panels, with their lettered names of honour
  and their barcodes, are left out. The emblem itself is laid over
  the scarf's copy from a separate, sharper source file of it (about 1,230
  pixels across), so it stays crisp where the scarf image is soft. Darkened
  35% on the card.
- **Verdirojas (`verdirojas/`).** From two scarves. The card is the
  VERDIROJAS side of the Verdirojas scarf, from flatbed scans stitched
  together: the watermelon slice between VERDI and ROJAS, on the keffiyeh
  net, darkened 58%. The thumbnail is the watermelon slice. The
  poster and hero are the raised fist from the end of the Refugees Welcome
  scarf, rendered from its vector print file: upright on the poster (darkened
  25%), across the hero as the scarf runs. The border is the watermelon's red.

## Adding a year

A pull request with that year's files here and an entry in `YEAR_THEMES`:
its label, and colours whose text passes the contrast check. The Apple and
Google passes use the theme's background colour as it is, so pick it from the
artwork's own ground. Bump a theme's `version` whenever its images or
colours change, so cached passes are rebuilt and Google fetches the new hero.
