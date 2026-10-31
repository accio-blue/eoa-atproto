# ing.lexicon.canvas

Repo-owned lexicons for canvas scenes, with a JSON Canvas 1.0-shaped core.
JSON Canvas is an import/export format only; the stored record is ours.

Decision: `effects-of-atmosphere-a1w9`. Work: `effects-of-atmosphere-d0nd`.

## Why this directory

`packages/lexicon` is the toolkit package (`Lexicons`, Effect Schema
conversion, XRPC validation), so lexicon JSON that the repo _owns_ lives under
it, in `lexicons/<nsid path>.json`. That is the layout `@atcute/lex-cli`
globs (`lexicons/**/*.json`), so generated types can target it later. It is
kept apart from `apps/obsidian-clipper/lexicons/`, which holds _vendored_
third-party lexicons with a provenance README; a repo-owned lexicon must not
sit in a tree that a `pull` can overwrite. No new workspace package, so no
lockfile change. The mapping code is `packages/lexicon/src/canvas/`, which
`tsc`, `vitest` and `vp lint` already cover (`lexicons/` is data, not in the
tsconfig `include`).

## Files

| File            | NSID                          | Kind                                      |
| --------------- | ----------------------------- | ----------------------------------------- |
| `defs.json`     | `ing.lexicon.canvas.defs`     | shared defs: node, edge, content variants |
| `scene.json`    | `ing.lexicon.canvas.scene`    | record, `key: tid`                        |
| `override.json` | `ing.lexicon.canvas.override` | record, `key: any`                        |

## Shape

A scene is `{ title?, description?, nodes[], edges[], createdAt, updatedAt? }`.
No camera: pan and zoom are UI state.

A **node** is a frame plus an open union of content:

```
{ id, x, y, width, height, order, color?, ref?, content }
content = one of  defs#text | #file | #link | #group | #component | <any other NSID>
```

- `x y width height order` are `integer` (the lexicon has no float type).
- `order` is an explicit stacking order, ascending = bottom to top; ties break
  by `id`. It replaces JSON Canvas's array-position z-order, which is not
  merge-safe. Integer, as Inlay's `z`; a fractional-index string can be added
  later as a new optional field (evolution rule: new fields are optional).
- `ref` is the `at-uri` of the record the node represents; two nodes may
  carry the same `ref`. `id` is the local stable id that edges and overrides
  use.
- `#component` is `{ componentUri, props }`, the Inlay window model; `props`
  is lexicon `unknown` (a JSON object without floats).
- **Edges** are in the record with the JSON Canvas names:
  `id, fromNode, toNode, fromSide?, toSide?, fromEnd?, toEnd?, label?, color?`.
  Sides and ends are `knownValues`, not `enum`, so they stay extensible.

### Frame plus union, not a bare union of nodes

The union is on `content`, not on the node. A reader that does not know a
variant of an open union cannot validate it ("be permissive when validating"),
so nothing about its fields is guaranteed, and a bare union of nodes would let
a reader meet an unknown node with no position. With the frame outside the
union every node, known or not, still has geometry, order and `id`, so it can
be laid out, ordered, dragged and kept. A third party adds a node type by
publishing a variant under its own NSID; this build then treats it as unknown
and keeps it verbatim.

## Override record

`ing.lexicon.canvas.override` lives in the viewer's repo:
`{ scene (at-uri), nodes[{ id, x?, y?, width?, height?, order?, hidden? }], createdAt, updatedAt? }`.
Layers rank **app < author < viewer** (ADR
`docs/adr/0002-hybrid-conformance-plugins-on-mise-en-mode.md`): the app's own
defaults or derived layout, then the scene (the author, the tenant), then this
record. A field it omits falls through; an `id` the scene lacks is ignored.

**Record key.** `key: any`, and the rkey is the **scene's rkey** (a TID), so a
viewer's override for a scene is a known-URI lookup with no listing. The
record-key spec allows this: `any` "may be used to encode semantics in the
name ... a (transformed) AT URI ... enables de-duplication and known-URI
lookups", and the same key in two collections is the sanctioned sidecar
pattern (<https://atproto.com/specs/record-key>). `any` rather than `tid`
because the key is the scene's to mint, not ours. The catch is in the same
spec: rkeys are not globally unique and are user-controlled, so `(did, rkey)`
is not an identity. The required `scene` at-uri is therefore authoritative.
A reader ignores an override whose `scene` is not the scene it is rendering
or whose rkey differs from the record key. A collision can cost the viewer an
override, never apply the wrong one. The other option, a key such as
`<did>~<rkey>`, is valid today but the spec warns DIDs as keys may stop
working for future DID methods.

## JSON Canvas 1.0 gaps, and what we do

Source: <https://jsoncanvas.org/spec/1.0/>.

| Gap in JSON Canvas 1.0                              | Here                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| No camera                                           | None in the record, none in the export                                                 |
| z-order is array position                           | `order` field; export writes the array sorted by it; import numbers nodes `0, 1024, …` |
| Four node types, no typed props                     | open union `content`; `#component` carries `componentUri` + `props`                    |
| `file` is a system-local path                       | kept as an opaque string for fidelity; point at a record with `ref` instead            |
| Groups are a flat node, no nesting or `z`           | same: membership is the group's rectangle; `order` gives its z                         |
| Colours: hex or `"1"`..`"6"`                        | passed through; import accepts `#` + 3 to 8 hex digits (the spec only shows `#RRGGBB`) |
| No `ref`, `title`, `description`, `updatedAt`       | not exported; `ref` loss is reported (see notes)                                       |
| Extra keys in a `.canvas` file (the spec is silent) | ignored on import, never written on export                                             |

Stricter than the spec on import, because the scene lexicon says so:
`width`/`height` >= 0, ids 1 to 128 UTF-8 bytes, coordinates safe integers.

## Export policy (`toJsonCanvas`)

`toJsonCanvas(scene, { plugins })` returns `{ canvas, notes }`, pure.

- text, file, link, group map to the same JSON Canvas type.
- Nodes are written bottom to top by `(order, id)`.
- **Plugin or unknown node, `plugins: 'placeholder'` (default).** It becomes a
  `text` node, so Obsidian shows it. The text is Markdown naming the
  `componentUri` (`**Plugin component** \`at://…\``), then an HTML comment
  `<!-- ing.lexicon.canvas:node {"content":{…},"ref":"…"} -->`with the
  node's content and`ref`verbatim,`<`and`>` `\u`-escaped so the comment
  cannot close early. Import restores the node from that comment, so the
  round trip is lossless. A `text`node is used rather than`link`because an`at://`URL in a`link` node is a web embed that cannot render, and could
  not be told apart from a real link on the way back.
- **`plugins: 'drop'`.** Those nodes are left out, a `node-dropped` note is
  returned, and so are `edge-dropped` notes for the edges that touched them
  (an edge to a missing node would make the file invalid).
- Anything else that cannot be said in JSON Canvas 1.0 is left out and
  reported in `notes`: `field-dropped` (a side, end, colour or
  `backgroundStyle` outside the spec's values), `ref-lost` (a `ref` on a
  text/file/link/group node), `edge-dropped` (dangling edge).

Every `notes` entry is `{ action, id, detail }`. The output always decodes
under `decodeJsonCanvas`, which is the repo's JSON Canvas 1.0 check (types,
required fields, integers, enums, unique ids, edge endpoints exist).

## Import policy (`fromJsonCanvas`)

Decode untrusted input with `decodeJsonCanvas` first (a `Result`, never
throws), then `fromJsonCanvas(canvas, { createdAt, title? })`. Pure: the
caller supplies `createdAt`. `text`/`file`/`link`/`group` map back; a `text`
node holding a placeholder comment for a component or unknown variant is
restored to that node. A comment claiming to be a standard type, or a component
without a `componentUri`, is left as ordinary text.

## Validation, and what the toolkit does not check

`createLexicons`, `isLexiconDoc` and `validateWithLexicon` from this package
load the three files and enforce integer-ness. They do not walk a record: the
toolkit's `lexiconToSchema` reads only the top-level `type` of a def. So
`src/canvas/canvas-lexicon.test.ts` also walks the JSON itself (allowed types,
refs resolve, union open) and checks sample scenes and overrides against it.
The reference implementation (`@atproto/lexicon`, not a dependency of this
package) was run once over the same files and samples; it accepted them and
rejected a float `x` and a missing `order`.

## Constraints that cannot change once published

From the Lexicon spec, "Lexicon Evolution"
(<https://atproto.com/specs/lexicon#lexicon-evolution>): new fields must be
optional, types and names cannot change, old data must stay valid. So:

- `nodes`, `edges`, `createdAt`, and a node's `id x y width height order content`
  are required for good. Everything we may want later is optional.
- Limits are minimal on purpose: only ids (128 bytes), `color` (16 bytes)
  and integer ranges (safe-integer bound, `width`/`height` >= 0). Record size is
  the real cap, so a very large scene needs splitting.
- The content union is open (`closed: false`), which the spec allows to grow
  and tells validators to be permissive about
  (<https://atproto.com/specs/lexicon#union>).
- Known risk: the spec says lexicon authors are "strongly recommended to not
  use `unknown` fields in `record` objects for now"
  (<https://atproto.com/specs/lexicon#unknown>). `props` is `unknown` because
  plugin props cannot be typed in advance; they must be a JSON object with no
  floats.
