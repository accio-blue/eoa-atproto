/**
 * Regenerate every model document + typed scaffolding under `specs/`.
 *
 *     pnpm --filter @eoa/specs generate:all
 *
 * Walks `specs/**\/*.qnt`, skips `shared/` (importable defs, not generated),
 * and writes each artifact through the quint-machine codegen, so every
 * generated document records its spec's hash for the freshness lint
 * (`automation/quint-generated-model-fresh`).
 *
 * An unsupported construct fails the whole run loudly — the generator never
 * emits a valid-looking model for a spec it cannot translate.
 */
import { Effect, Layer } from 'effect';
import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { isSharedSpec, specRelToOutRel } from '../src/layout';
import { generateModelArtifacts } from '@quint-machine/core/codegen';

const findSpecs = (): string[] => {
  if (!existsSync('specs')) return [];
  return readdirSync('specs', { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.qnt'))
    .map((entry) => `specs/${entry.replaceAll('\\', '/')}`)
    .filter((entry) => !isSharedSpec(entry))
    .sort();
};

const program = Effect.gen(function* () {
  // `generate:all specs/apg/tabs.qnt ...` regenerates only the named specs.
  const only = process.argv.slice(2);
  const specs = findSpecs().filter(
    (spec) => only.length === 0 || only.includes(spec),
  );
  yield* Effect.forEach(
    specs,
    (spec) => {
      const out = specRelToOutRel(spec);
      mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
      return generateModelArtifacts({
        specAbsolute: spec,
        outAbsolute: out,
      });
    },
    { concurrency: 1 },
  );
  yield* Effect.log(`generated ${specs.length} spec(s)`);
});

// 4.1 keeps crypto out of the platform services: the codegen hashes each spec through
// `effect/crypto/Digest`, so the layer has to be given explicitly.
NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  ),
);
