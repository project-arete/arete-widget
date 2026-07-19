# Arete Widget

Create **virtual widgets** from plain YAML files and let them live on a CNS/CP
realm. Each widget declares Connection Profile capabilities (validated against
the [cp.padi.io](https://cp.padi.io) registry — an unregistered CP is refused),
renders a **faceplate window** in lieu of the physical device, and can
**auto-actualize**: declarative rules like *"when `sOut` changes, set `cState`"*
make the widget behave like a real, working device.

The app registers one System on the realm (default name **"Arete Widget"**,
changeable in Config). Every widget you add becomes a Node under that System,
in a context of your choice — join an existing context and the realm's broker
connects your widget to whatever else lives there.

## Architecture (built for macOS / Windows / Linux, mobile-ready core)

- `core/` — **portable** widget engine, no Electron/Node APIs:
  - `widget-spec.js` parses + validates definitions against registry profiles
  - `behavior-engine.js` derives state from CNS keys and converges on rules
- `renderer/` — portable web UI (main window + faceplate), no Node APIs
- `electron/` — the desktop shell: Arete SDK service (main process only),
  widget manager, IPC bridges, per-instance faceplate windows
- `widgets/` — definition files shipped with the app; your own go in the
  per-user widget folder shown at the bottom of the Widgets tab

A future mobile shell (e.g. Capacitor) reuses `core/` + `renderer/` and only
replaces the SDK transport + window plumbing.

## Widget definition format

```yaml
widget: bulb                  # id slug
title: Virtual Bulb
description: A light being controlled.
capabilities:
  - profile: padi.light       # must exist at cp.padi.io/profiles/<name>
    role: consumer            # provider | consumer
view:                         # faceplate, top to bottom
  - { type: lamp,   bind: sOut, on: "1" }      # glows when sOut == "1"
  - { type: label,  bind: sLabel, caption: controller }
  - { type: value,  bind: cState, caption: reported state }
  # toggle (interactive on/off) and field (editable text) also available —
  # only on properties this widget's role is allowed to write.
behavior:                     # optional auto-actualize
  init: { cState: "0" }       # puts issued once, when first created
  rules:
    - { when: sOut, set: cState }        # mirror (optional map: {"1":"on"})
```

Validation is mechanical and honest: every `bind`/`set`/`init` property must
exist in the CP, and writes must match the role's side (provider ↔ `server`
properties, consumer ↔ client properties).

## Run

```bash
npm install     # also applies the off-Pi System-ID patch to the SDK
npm start
```

Do **not** run from a cloud-synced folder (Drive/iCloud/Dropbox) — sync rewrites
Electron's framework mid-run and crashes it.

## Tests (headless, no Electron)

```bash
npm run test:spec      # offline: validator + behavior engine
npm run test:connect   # live: connect + register on the public test realm
npm run test:widget    # live end-to-end: switch + bulb, broker binding,
                       # flip -> auto-actualize -> report back
```

## Build installers

```bash
npm run dist         # macOS .dmg
npm run dist:win     # Windows installer (cross-building needs wine on macOS)
npm run dist:linux   # Linux AppImage
```
