# Bundled font

`bungee-latin-400-normal.woff` is the display face the membership card image
is rendered with (`src/cardimage/render.ts`), and since #97 also the face the
web pages' headings use, served from `/assets/bungee.woff`.

| | |
| :--- | :--- |
| **Font** | Bungee, regular (400), latin subset |
| **Source** | [`@fontsource/bungee`](https://www.npmjs.com/package/@fontsource/bungee) 5.3.0, file `files/bungee-latin-400-normal.woff` |
| **Upstream** | <https://github.com/djrrb/Bungee> |
| **Licence** | SIL Open Font License 1.1 — the full text is in `bungee-LICENSE.txt` beside the font |
| **SHA-256** | `ce965f529c48def2baf2447acafc3bdc2eba88c916e38d713a542a3a9eb36837` |

## Why the file is committed rather than imported

Wrangler inlines it at build time (the `[[rules]]` block in `wrangler.toml`
treats `.woff` as `Data`), because a Worker cannot read a file from disk at
request time. Satori needs the raw bytes, and so does the `/assets/bungee.woff`
route.

`@fontsource/bungee` was a dependency until this file was given a home of its
own. It was never imported: the package existed only as the place this file had
been copied from, and as an undeclared record of where that was. Carrying a
dependency to serve as a footnote is the sort of thing that quietly accumulates,
so the footnote is written down here instead and the dependency is gone.

Keeping the licence text beside the font is not only tidiness. The OFL requires
that the licence travel with the font, and this repository is public — so
removing the package, which had been carrying the licence in `node_modules`,
would otherwise have left us distributing the font without it.

## Replacing or updating it

Take the file from a published `@fontsource/bungee` release rather than
re-subsetting one by hand, so the result stays comparable:

```bash
npm pack @fontsource/bungee@<version>
tar -xzOf fontsource-bungee-<version>.tgz package/files/bungee-latin-400-normal.woff \
  > src/cardimage/assets/bungee-latin-400-normal.woff
```

Then update the version and hash in the table above, refresh
`bungee-LICENSE.txt` from the same release, and check a rendered card image:
the card layout is measured with this font, so a different subset or weight
moves the text.
