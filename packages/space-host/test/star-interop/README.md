# STAR interop vectors (vendored)

`valid-star-fixtures.json` and `invalid-star-fixtures.json` are copied unmodified from
[`microcosm.blue/star`](https://tangled.org/microcosm.blue/star/tree/main/interop), the upstream
interop set for [STAR](https://dasl.ing/star.html) v1 — fetched 2026-11-04 from
`https://tangled.org/microcosm.blue/star`.

Why they are here: `packages/space-host/src/star.ts` framed archives with no `0x01` control byte
before each pair and no `0x00` terminator, which the spec (revised 2026-11-03, after our 2026-10-22
framing) requires. The vectors are the measurement: before the fix, 0 of 19 valid archives parsed
correctly and 5 of 37 invalid ones were accepted.

They test the **framing only** — no application profile. The atproto space profiles
(`atproto-space-repo`, `atproto-space-meta`) add required meta fields, size ceilings and strict key
ordering on top, and are tested by the profile's own suite.

Upstream status, as of the copy: hex is uppercase; `comment` fields are commentary, not assertions;
failure _types_ are not defined, only that a parser must fail rather than crash. Upstream says be
prepared for breaking changes — re-copy these files when the spec moves.

Licences: the source repository carries `LICENSE.MIT` and `LICENSE.Apache-2.0`.
