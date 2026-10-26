# Bundled fonts

Nebula ships the two fonts its UI uses, so opening the app asks no outside
server for them and the fonts still apply offline. Until 2026-10-21
`index.html` loaded them from Google Fonts on every start.

| Family | Version (name table) | Weights used | License |
|---|---|---|---|
| Inter | 4.001;git-66647c0bb | 200, 300, 400, 500, 600 | SIL OFL 1.1, [`inter/OFL.txt`](inter/OFL.txt) |
| JetBrains Mono | 2.211 | 400, 500, 600 | SIL OFL 1.1, [`jetbrains-mono/OFL.txt`](jetbrains-mono/OFL.txt) |

## Where the files come from

The files are the ones Google Fonts served for the stylesheet the app used to
link, fetched on 2026-10-21 with a desktop Chrome user agent:

    https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap

`fonts.css` is that stylesheet's 53 `@font-face` rules (7 Inter subsets x 5
weights, 6 JetBrains Mono subsets x 3 weights) with only the URLs made local.
Both families are variable fonts, so every weight of a subset shares one file.
Keeping Google's files and `unicode-range` subsets means text renders exactly as
it did, and a page downloads only the subsets it uses (normally the two latin
files, 79,772 bytes together).

Upstream: Google added Inter 4.001 to [google/fonts](https://github.com/google/fonts/tree/main/ofl/inter)
on 2024-06-06 (commit e1d6480102) and JetBrains Mono 2.211 to
[google/fonts](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono) on
2020-11-18 (commit 2e05c1cf00). The license files are `ofl/inter/OFL.txt` and
`ofl/jetbrainsmono/OFL.txt` from google/fonts `main`. The fonts' own projects
are [rsms/inter](https://github.com/rsms/inter) and
[JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono); their
latest releases (Inter 4.1, 2024-11-16; JetBrains Mono 2.304, 2023-01-14) are
newer builds than the ones Google serves, so they would not render identically,
and they are whole fonts: Inter's InterVariable.woff2 alone is 352,240 bytes,
more than all 13 files here.

## Files

| File | Bytes | sha256 | Source URL | Last-Modified (server) |
|---|---|---|---|---|
| `inter/inter-cyrillic-ext.woff2` | 25844 | `fccca918fea40089dacadc7045861314d1a6bc91f1f323cc1eeb22ebcdb321b5` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7W0Q5n-wU.woff2 | Tue, 09 Sep 2025 18:39:20 GMT |
| `inter/inter-cyrillic.woff2` | 18744 | `aebf2ab4a4ce6810d73c1ac7be7cafb4e5ec4cee2d6db5fb3e09691747ec4bd6` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7W0Q5n-wU.woff2 | Tue, 09 Sep 2025 18:34:09 GMT |
| `inter/inter-greek-ext.woff2` | 11272 | `a2e2c783ca6f9c20486e81e72a279203e86730bbf8f01ff6a5ee9dbd09e1c271` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7W0Q5n-wU.woff2 | Tue, 09 Sep 2025 18:37:09 GMT |
| `inter/inter-greek.woff2` | 19044 | `46dd4cdca58c26ae87cc6927657bf83b2e8abfc39ffd0ab176e301a8d28d22bf` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7W0Q5n-wU.woff2 | Tue, 09 Sep 2025 18:36:30 GMT |
| `inter/inter-vietnamese.woff2` | 10280 | `8db00ff46c67b22cda8bed865acf7077651cac8d2841d5b40980556b48961931` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7W0Q5n-wU.woff2 | Tue, 09 Sep 2025 18:32:48 GMT |
| `inter/inter-latin-ext.woff2` | 85272 | `a28eb6d3ccb534ae0c94ca999371df024aab60b08c3c8a5720ee9e32fa0faaa2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7W0Q5n-wU.woff2 | Tue, 09 Sep 2025 18:34:27 GMT |
| `inter/inter-latin.woff2` | 48432 | `c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 | Tue, 09 Sep 2025 18:40:32 GMT |
| `jetbrains-mono/jetbrains-mono-cyrillic-ext.woff2` | 1664 | `9343de2ca5d9549f792e7962375af8efb0f320c7643bfd36c884b5a30e5c396f` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx3cwgknk-6nFg.woff2 | Wed, 10 Sep 2025 16:56:22 GMT |
| `jetbrains-mono/jetbrains-mono-cyrillic.woff2` | 8892 | `4995a9a43ac659ec32fcd8b463755cd6a07b31a6e6b3894a6a153b661cf490e2` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxTcwgknk-6nFg.woff2 | Wed, 10 Sep 2025 16:58:08 GMT |
| `jetbrains-mono/jetbrains-mono-greek.woff2` | 6800 | `49c3da6c9a2b279b0f1f860f5cfb1f5dc38d88a5c7be9c9b1837bbc4e3db6111` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxPcwgknk-6nFg.woff2 | Wed, 10 Sep 2025 16:52:39 GMT |
| `jetbrains-mono/jetbrains-mono-vietnamese.woff2` | 5872 | `d44eb1936043a56038eb02dd70b243f379bef65783f94ec12f277550720411f1` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx_cwgknk-6nFg.woff2 | Wed, 10 Sep 2025 16:58:10 GMT |
| `jetbrains-mono/jetbrains-mono-latin-ext.woff2` | 11596 | `9c38cb2d0d2d93c1ee6e21fa78db76f13ea7e15e15cc64214c7ca89b6aaa35c4` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx7cwgknk-6nFg.woff2 | Wed, 10 Sep 2025 16:54:29 GMT |
| `jetbrains-mono/jetbrains-mono-latin.woff2` | 31340 | `2c32b9b3ee358c119e210f6f5195f9bd34894d78a785ff2e95d60e718e400af4` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwgknk-4.woff2 | Wed, 10 Sep 2025 16:54:17 GMT |

13 files, 285,052 bytes. License texts: `inter/OFL.txt` sha256
`5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57`,
`jetbrains-mono/OFL.txt` sha256
`b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d`.

## Updating

Fetch the stylesheet above again with a current desktop Chrome user agent,
download each `fonts.gstatic.com` URL it names, give each file its subset name
(the `/* latin */` comment above its rule), replace the URLs in `fonts.css`,
and update the table. Use files that have been public for at least 14 days.
`tests/localFonts.test.ts` checks that every file's sha256 is listed here, and
`scripts/check-built-fonts.mjs` checks the build output.
