# eoa-atproto

An Effect-native AT Protocol implementation: the protocol primitives (`core`,
`crypto`, `identity`, `lexicon`, `xrpc`), the repository (`repo`, `repo-store`),
the firehose (`sync`), OAuth (`oauth`, `oauth-provider`), a PDS (`atproto-pds`),
an AppView (`appview`) and the spaces over it (`space-host`).

Every package is `@eoa/*`, MIT, and depends on
[Effect](https://effect.website) 4.

## Status

Early. The API moves with the implementation, and a package version is not a
compatibility promise yet.

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```

This repository is published from a private monorepo: the packages here are the
part that is meant to be read and used, and the history is the history of those
files. Issues and patches are welcome; the code is copied back by hand, so a
patch may take a while to appear.
