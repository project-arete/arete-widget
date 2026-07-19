# The Propagate Test Rig

A small rig that gets to the bottom of — and teaches — the CNS/CP
**propagate flag**: for each property a CP defines, writes are pushed to all
active connections **only if the property carries the `propagate` flag**.
Without it, the value stays on the writing node's capability and peers can
never see it.

## Pieces

| File | What it is |
|---|---|
| `cp-padi.test.propagate.json` | Draft definition of **cp:padi.test.propagate**, ready to register at [cp.padi.io](https://cp.padi.io) (registry JSON shape; flags encoded by key presence) |
| `propagate-sender.yaml` | Provider widget: writes `sShared` (propagated), `sLocal` (not), bumps `sPing` |
| `propagate-receiver.yaml` | Consumer widget: shows what arrives, auto-echoes `sPing` → `cPong`, keeps its own `cLocal` |
| `../../scripts/test-propagate.js` | Headless experiment: writes both flavors on both sides, then inspects the raw key namespace and reports where every value did and did not land |

The CP's six properties differ **only** in their flags:

| Property | Writer | Propagate | So… |
|---|---|---|---|
| `sShared` | provider | ✔ | receivers see it |
| `sLocal` | provider | ✘ | never leaves the sender |
| `sPing` | provider | ✔ | receivers auto-echo it |
| `cShared` | consumer | ✔ | the sender sees it |
| `cLocal` | consumer | ✘ | never leaves the receiver |
| `cPong` | consumer | ✔ | the echo — proves the round trip |

## Running the demo

1. **Register the CP** at cp.padi.io from `cp-padi.test.propagate.json`.
   Until it exists, everything here is deliberately inert: the widgets fail
   validation ("NOT in the CP registry") and the script skips.
2. Copy the two YAMLs into `widgets/` (or your local widget folder) and hit
   **Reload** in Arete Widget — they turn valid the moment the registry
   resolves.
3. Add a **Propagate Sender** in a new context; add a **Propagate Receiver**
   joining it. Open both faceplates side by side.
4. Type into `sShared` on the sender → appears on the receiver, with a flash.
   Type into `sLocal` → nothing happens on the receiver, ever. Note the
   dashed **local** chip the app puts on `sLocal` automatically — it read the
   flag from the registry.
5. Bump `sPing` → the receiver's rule echoes it to `cPong`, which propagates
   back and lands on the sender. One counter, two propagated hops.
6. Open **Arete Monitor → Connections** on the context: the connection
   carries `sShared`, `cShared`, `sPing`, `cPong` — and never `sLocal` or
   `cLocal`. Faceplates show the experience; the Monitor shows the wire.
7. For the empirical record: `npm run test:propagate` prints a findings
   table asserting exactly where each value landed in the namespace.

## Why the receiver has no `sLocal` display

The app's validator refuses a widget that *reads* a peer-written property
without the propagate flag — the value can never reach its connections, so
the display would be forever blank (a "dead bind"). That refusal is part of
the lesson: the contract itself tells you what can never be observed.
