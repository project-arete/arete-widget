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
| `propagate-sender.yaml` | Provider widget: posts `bulletin` (propagated), keeps `draft` (not), bumps `ping` |
| `propagate-receiver.yaml` | Consumer widget: shows what arrives, auto-replies `ping` → `echo`, keeps private `notes` |
| `../../scripts/test-propagate.js` | Headless experiment: writes both flavors on both sides, then inspects the raw key namespace and reports where every value did and did not land |

The CP's six properties differ **only** in their flags. Names carry the
**purpose** (per registry naming guidance: no direction prefixes — the
`server` flag is the authority on who writes; `padi.test.*` is the namespace
for development/test profiles):

| Property | Writer | Propagate | Purpose |
|---|---|---|---|
| `bulletin` | provider | ✔ | posted for everyone — consumers see it |
| `draft` | provider | ✘ | stays on the provider's desk — never leaves |
| `ping` | provider | ✔ | counter consumers auto-reply to |
| `feedback` | consumer | ✔ | sent back — the provider sees it |
| `notes` | consumer | ✘ | private — never leave the consumer |
| `echo` | consumer | ✔ | the reply to ping — proves the round trip |

## Running the demo

1. **Register the CP** at cp.padi.io from `cp-padi.test.propagate.json`.
   Until it exists, everything here is deliberately inert: the widgets fail
   validation ("NOT in the CP registry") and the script skips.
2. Copy the two YAMLs into `widgets/` (or your local widget folder) and hit
   **Reload** in Arete Widget — they turn valid the moment the registry
   resolves.
3. Add a **Propagate Sender** in a new context; add a **Propagate Receiver**
   joining it. Open both faceplates side by side.
4. Type into `bulletin` on the sender → appears on the receiver, with a
   flash. Type into `draft` → nothing happens on the receiver, ever. Note
   the dashed **local** chip the app puts on `draft` automatically — it read
   the flag from the registry.
5. Bump `ping` → the receiver's rule replies on `echo`, which propagates
   back and lands on the sender. One counter, two propagated hops.
6. Open **Arete Monitor → Connections** on the context: the connection
   carries `bulletin`, `feedback`, `ping`, `echo` — and never `draft` or
   `notes`. Faceplates show the experience; the Monitor shows the wire.
7. For the empirical record: `npm run test:propagate` prints a findings
   table asserting exactly where each value landed in the namespace.

## Why the receiver has no `draft` display

The app's validator refuses a widget that *reads* a peer-written property
without the propagate flag — the value can never reach its connections, so
the display would be forever blank (a "dead bind"). That refusal is part of
the lesson: the contract itself tells you what can never be observed.

## Findings so far (living record)

**2026-07-19, dashboard.test.cns.dev — the full story in three acts:**

1. **Unknown-CP era** (minutes after registration, orchestrator not yet aware
   of the CP): pairs bound instantly and EVERYTHING propagated — including
   `draft` and `notes`, continuously (verified with sequential post-bind
   writes). Unknown profiles are brokered permissively with no flag handling.
2. **Bind-blocking** (once the orchestrator learned the CP): pairs whose
   capabilities carried a non-propagated VALUE at bind time were never bound
   at all (60s+), while `padi.light` pairs bound in seconds and a
   padi.test.propagate pair with NO non-propagated values bound in 5s. This
   is why the rig widgets no longer initialize `draft`/`notes` — write them
   from the faceplate after binding.
3. **Post-bind leak** (bound pair, orchestrator aware of the CP): writes to
   `draft` still appeared in connection properties and reached the peer.
   The propagate flag is not enforced for data flow.

**Net:** propagated properties behave exactly per spec (including the
ping → echo round trip). The flag's only observable effect today is the
bind-blocking side effect in act 2 — data-flow enforcement is absent.
On such realms, "local" values are NOT actually private.

**anto.aretehosting.com (chart arete 1.5.3), 2026-07-19:** IDENTICAL
behavior to the test host. First run (rig with non-propagated init values)
never bound — act 2 confirmed. Bind-safe re-run: bound promptly, all
propagated properties correct including ping → echo, and the same leak —
`draft` and `notes` appeared in connection properties and reached the peers.

**Conclusion (two independent orchestrator deployments, same result):**
propagate enforcement for data flow is absent from current orchestrator
builds, and non-propagated values present at bind time block brokerage.
Both are orchestrator-side issues; the registry contract and this rig are
the reproduction.
