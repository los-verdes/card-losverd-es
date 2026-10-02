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
  Left running across, as the scarf hangs, and stretched to each shape: the
  card (darkened 58%), the poster (darkened 35%) and the hero.
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
- **2024 (MMXXIV).** No print file was to hand, so this year comes from the
  Merch Team's flat-lay mockup render (`2024-ScarfMockup1.jpg`), in which
  both sides of the scarf lie straight: turned level (35.75 degrees), cut
  out, and upscaled where a surface needs more than the render holds (up to
  about 1.8 times), through a light median filter so the render's fabric
  weave doesn't sharpen into noise, and a gentle sharpen after. The card is
  the floral side's birds and flourishes, darkened 55%; the poster and hero
  its centrepiece, the bat under a sugar skull; the thumbnail the sugar
  skull in its sunburst from the LOS VERDES side. Worth replacing from the
  print file if one turns up.
- **2025 ("Cinco Uno Dos").** From the scarf's vector print file, rendered at
  200 dpi. The card is the green side's three skeleton hands, five, one and
  two, each cut out from the letter behind it, standing on the scarf's green
  between its paisley borders, darkened 58%. The poster, hero and thumbnail are the LOS VERDES roundel
  from the black side: on the poster with the confetti around it, faded into
  the scarf's black.
- **2026 ("Skull Gaiter").** No scarf print file was to hand, so this year
  is composed from the 2026 kit's vector art, rendered at 150 dpi: the same
  skull, brush lettering and blackletter the scarf carries, on the kit's
  dark ground. The card is VERDE, ATX and LISTOS, darkened 66%; the poster
  and thumbnail the skull; the hero LOS VERDES with the skull.

## Subgroup themes

A subgroup theme (`GROUP_THEMES`) is for the members of one subgroup
(`CARD_GROUPS` in `src/themes/groups.ts`), and keeps its files under its own
id here rather than a year.

- **Los Pringles (`los-pringles/`).** The back of the Los Pringles scarf,
  from flatbed scans stitched together: the all-seeing Pringle at the centre
  of its starfield, with all eight flying Pringles (mask, chef, money,
  rainbow, cowboy, pirate, crown, agent) feathered in from both sides as on
  the scarf. The emblem is laid over the scarf's copy from a separate,
  sharper source file of it (about 1,230 pixels across), and the scan's dark
  grey taken down to black to match it. The poster and hero add "if you
  pring, you pring" in green, set in Yellowtail, a script close to the
  scarf's own lettering. Darkened 35% on the card; the thumbnail is the
  emblem.
- **Verdirojas (`verdirojas/`).** From two scarves. The card, poster and
  hero come from the Refugees Welcome scarf's vector print file. The card is
  the flower between REFUGEES and WELCOME, alone on black, darkened 40%. The
  poster and hero are the raised fist from the scarf's end, upright on both:
  on the poster darkened 25%, on the hero the fist and forearm across the
  scarf's full width. The thumbnail is the watermelon slice between VERDI
  and ROJAS on the Verdirojas scarf, from flatbed scans stitched together.
  The border is the watermelon's red.

## Adding a year

A pull request with that year's files here and an entry in `YEAR_THEMES`:
its label, and colours whose text passes the contrast check. The Apple and
Google passes use the theme's background colour as it is, so pick it from the
artwork's own ground. Nothing needs bumping when a theme's images or
colours change: its version is a hash of them (`src/themes/fingerprint.ts`),
so cached passes are rebuilt and Google fetches the new hero by themselves.
