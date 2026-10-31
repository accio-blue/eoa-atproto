# Test utilities

Shared helpers for workspace tests. `tests/utils` is **not** a vitest project:
the root `vite.config.ts` only collects suites from `apps/**`, `packages/**`
and `tools/**`, so nothing here runs on its own. Package tests import these
helpers by relative path, for example
`../../../tests/utils/fixtures.js`.

## `fixtures.ts`

Paths are resolved under `tests/fixtures/atproto-interop/` (the CC0 atproto
interop corpus). Fixture paths are validated so they cannot escape that
directory.

- `loadFixture<T>(path)` — parse a JSON fixture and return it typed as `T`.
- `loadTextFixture(path)` — read a fixture verbatim.
- `loadSyntaxFixture(kind)` — read `syntax/<kind>.txt` and return its non-empty,
  non-comment (`#`, `//`) lines. `kind` may include the `.txt` suffix.
- `parseSyntaxFixture(content)` — the line parser used by `loadSyntaxFixture`.

Leading and trailing whitespace on value lines is preserved on purpose: some
syntax fixtures encode invalid values using stray spaces.

The helpers derive their own location from `import.meta.url`, so they are safe
to import from ES modules (no `__dirname`).

### Example

```ts
import { loadFixture } from '../../../tests/utils/fixtures.js';

interface LexiconQuery {
  readonly id: string;
}

const query = loadFixture<LexiconQuery>('lexicon/catalog/query.json');
```
