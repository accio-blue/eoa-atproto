# ing.lexicon.ui lexicons

Repo-owned records for the headless UI layer.

## `ing.lexicon.ui.prefs`

A user's accessibility and UI preferences — **one per repo** (record key `literal:self`). Every preference is optional, so an absent field means the primitive's default and a new field can be added later without invalidating old records (`ing.lexicon.ui.prefs` may only add optional constraints).

| field                | type                           | default  | what it does                                                     |
| -------------------- | ------------------------------ | -------- | ---------------------------------------------------------------- |
| `motion`             | `system` \| `reduce` \| `full` | `system` | follows `prefers-reduced-motion`, or overrides it                |
| `motionDurationMs`   | integer                        | 200      | tween duration; **forced to 0** when motion resolves to `reduce` |
| `typeaheadDelayMs`   | integer                        | 500      | typeahead buffer lifetime (listbox, combobox, menus)             |
| `tooltipShowDelayMs` | integer                        | 600      | hover/focus delay before a tooltip shows                         |
| `tooltipHideDelayMs` | integer                        | 300      | grace period before it hides                                     |
| `announce`           | boolean                        | true     | whether primitives emit live-region announcements                |
| `focusFollowsCamera` | boolean                        | true     | focusing an off-screen node pans the camera to it                |

### The seam

**The host resolves the record and injects the values; `@cssints/headless` never imports atproto.** `resolvePrefs(record, { reducedMotion })` in `packages/lexicon/src/ui/prefs.ts` is the whole resolver: it merges the defaults, resolves `system` against the host's media query, and coerces an untrusted record (unknown enum, negative delay, non-boolean) back to a default rather than letting it reach a primitive.

Look-related policy — colour, type, the focus-ring style — is **not** a preference; it belongs to the look layer (ADR 0002).

## `ing.lexicon.ui.component`

A component implementation, Inlay-shaped under our namespace: **the record key IS the NSID the component implements**, and the record carries an ordered DID `imports` stack, a `body` (a remote call or a template tree) and a `view` contract (which prop receives record or primitive data).

Resolution — `resolveComponent(nsid, published, order)` in `packages/lexicon/src/ui/component.ts`:

1. only DIDs present in the order are candidates (deny-by-default — a repo the host was not told to trust cannot win by publishing the name);
2. the first candidate in the order wins;
3. nobody in the order publishes it → `undefined` (the host decides the fallback);
4. two records from one DID for one NSID is invalid and throws.

The order is the tenant's default, and a component's own `imports` override it for that subtree (`resolutionOrderFor`).

**No behaviour in the record** — a record carries the body and the view, never logic. Interop with `at.inlay.component` is a read/convert, not the storage shape.

### Composing a tree

`resolveComposition(roots, published, tenantOrder, { maxDepth })` in `packages/lexicon/src/ui/compose.ts` walks the whole render tree — elements are `{ key?, type, props? }` with children under `props.children` — and resolves every `type`:

- a resolved component's own `imports` become the order for **its subtree**, so a component pins the dependency it wants without changing anything else;
- an NSID nobody in the effective order publishes is **collected in `unresolved`** and its node simply carries no `resolved`, so the host can fall back to a built-in primitive, a placeholder or an error surface;
- a depth cap (default 64) reports `truncated` rather than recursing forever.

Nothing throws for a name that does not resolve; deny-by-default applies to the whole tree, not just the root.

## `ing.lexicon.ui.primitive`

The seam the other way round: a **primitive's published interface**, record key = the primitive NSID (the same shape as the component record). The host publishes one record per built-in primitive, so a component record or a third-party plugin author can bind to a name and read what it accepts without reading our TypeScript.

- `props` — `#propDecl`: `name`, `type` (string, integer, number, boolean, array, object, element, ref, function), `required`, `knownValues` for an enum, `default`, `description`.
- `events` — `#eventDecl`: `name`, `payload` (none, string, integer, number, boolean, object, element). An uncontrolled primitive emits these as **requests** the host may ignore.
- `lookIntents` — the Mise en Mode intents the primitive reads, restricted to the standard's **33 names** (21 colour: control 3, action 9, surface 9; 12 typography: 3 priorities × size/weight/family/lineHeight). A record cannot invent one, and `unknownIntents(record)` is the containment check a host runs on a record it did not write (ADR 0002, Rule 7).

`declaresProp` / `declaresEvent` answer whether a record declares a name. The canonical list lives in `packages/lexicon/src/ui/primitive.ts` as well as the lexicon, and a test asserts the two are identical so they cannot drift. A primitive record carries **no behaviour** — the contract only.
