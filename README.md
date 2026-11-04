# Platform Spoof — Revenge Classic port

This is a Revenge Classic / Vendetta-compatible port of the gateway-identification behavior from [k1ng0p/PlatformSpoof](https://github.com/k1ng0p/PlatformSpoof).

## Compatibility target

- **Revenge Classic:** bundle release **1.12.1**, commit `0980cfc` (the build identifier reported by the user).
- **Plugin API:** legacy Vendetta-compatible plugin loader (`manifest.json` + an expression in `index.js`).
- **Not compatible with:** Vencord plugin installation, BetterDiscord plugin installation, or the newer Revenge Next/Bunny spec-3 repository format.

The port uses APIs exposed by this Revenge Classic build: `vendetta.metro.findByProps`, `vendetta.metro.common.React`, `vendetta.metro.common.ReactNative`, `vendetta.plugin.storage`, and `vendetta.storage.useProxy`.

## Install from GitHub

Upload these files to the **root of the `main` branch** of your repository:

- `manifest.json`
- `index.js`

`README.md`, `LICENSE`, and `tests/` are optional for installation. The plugin manager downloads the manifest and then the `main` file named in the manifest.

For this repository, paste this **base URL** into Revenge's **Source URL** field:

```text
https://raw.githubusercontent.com/sdafdc/revenge-platform-spoof-classic/main/
```

Do not paste the GitHub `github.com` page, `manifest.json`, or `index.js` URL into that field. Revenge Classic appends `manifest.json` to the base URL, reads `main` from that manifest, and fetches the JavaScript file from the same base URL.

After adding the source, install **Platform Spoof (Revenge Classic)** and enable it. Open its settings and choose **Desktop (Windows)**. Changing the platform forces a new Discord Gateway IDENTIFY by clearing the current session id/sequence and closing the active WebSocket, matching the approach in the upstream PlatformSpoof project.

## Available modes

- Off
- Desktop (Windows) — `Windows` / `Discord Client`
- Web / Browser — `Linux` / `Chrome`
- Mobile (Android) — `Android` / `Discord Android`
- Meta Quest / VR
- Console

The default is Desktop (Windows).

## Verification performed

The JavaScript passed `node --check`. The included mocked smoke test reproduces Revenge Classic's `vendetta=>{return <plugin source>}` evaluation path and checks manifest fields, plugin lifecycle, Desktop IDENTIFY rewriting, Web selection, settings rendering, and restoration of the original gateway send method on unload.

**Not verified:** a live install/run on a physical Android device or a real Discord 351 Gateway session. The Metro module lookup and socket behavior are aligned with the upstream PlatformSpoof implementation and the Revenge Classic API, but live behavior still needs on-device confirmation. The plugin may need adjustment if Discord changes its gateway internals.

## Risk and privacy

This plugin changes the client properties sent in Discord Gateway IDENTIFY; it does not turn the Android app into the desktop client. It does not read, export, or request your Discord token. Use only code you have reviewed. Client spoofing is unofficial and may violate Discord's Terms of Service or lead to account restrictions.

## Upstream and license

- Original project: <https://github.com/k1ng0p/PlatformSpoof>
- Original plugin source: <https://github.com/k1ng0p/PlatformSpoof/blob/main/index.tsx>
- Original author: k1ng0p
- The upstream source identifies itself as GPL-3.0-or-later. This derived port is distributed under the same license; see `LICENSE`.
