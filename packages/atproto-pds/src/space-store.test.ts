import { Effect, Layer, Option, Result } from 'effect';
import { SpaceStore, spaceStoreLayer } from './space-store.js';
import { describe, expect, it } from 'vitest';
import { kvMemoryLayer } from '@eoa/kv';

const run = <A, E>(effect: Effect.Effect<A, E, SpaceStore>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.orDie,
      Effect.provide(spaceStoreLayer.pipe(Layer.provide(kvMemoryLayer))),
    ),
  );

const SPACE = 'at://did:web:pds.test:alice/com.example.space/club';

const AUTHORITY = 'did:web:pds.test:alice';

describe('the space store', () => {
  it('keeps an archive as the bytes it arrived as, replacing on re-import', async () => {
    const first = new TextEncoder().encode('first archive');
    const second = new TextEncoder().encode('second archive');
    const outcome = await run(
      Effect.gen(function* () {
        const store = yield* SpaceStore;
        yield* store.putMeta({
          space: SPACE,
          authority: AUTHORITY,
          archive: first,
        });
        const held = yield* store.meta(SPACE);
        yield* store.putMeta({
          space: SPACE,
          authority: AUTHORITY,
          archive: second,
        });
        return { held, after: yield* store.meta(SPACE) };
      }),
    );
    expect(Option.isSome(outcome.held)).toBe(true);
    expect(
      Option.isSome(outcome.held) ? outcome.held.value : undefined,
    ).toEqual(first);
    expect(
      Option.isSome(outcome.after) ? outcome.after.value : undefined,
    ).toEqual(second);
  });

  it('indexes the authority and the repos held, separately', async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const store = yield* SpaceStore;
        yield* store.putMeta({
          space: SPACE,
          authority: AUTHORITY,
          archive: new Uint8Array([1]),
        });
        yield* store.recordHold({ space: SPACE, did: AUTHORITY });
        yield* store.recordHold({
          space: 'at://did:web:pds.test:bob/com.example.space/club',
          did: AUTHORITY,
        });
        return {
          authority: yield* store.authorityOf(AUTHORITY),
          held: yield* store.heldBy(AUTHORITY),
          other: yield* store.heldBy('did:web:pds.test:carol'),
        };
      }),
    );
    expect(outcome.authority).toEqual([SPACE]);
    expect(outcome.held).toEqual(
      [SPACE, 'at://did:web:pds.test:bob/com.example.space/club'].sort(),
    );
    expect(outcome.other).toEqual([]);
  });

  it('answers nothing for a space it never imported', async () => {
    const held = await run(
      Effect.gen(function* () {
        const store = yield* SpaceStore;
        return yield* store.meta(
          'at://did:web:pds.test/alice/com.example.space/none',
        );
      }),
    );
    expect(Option.isNone(held)).toBe(true);
  });

  /**
   * The guarantee the member handlers rest on: an archive write names the version it was read at, so
   * two edits racing cannot lose one silently. The loser is refused, and a refusal is a thing a caller
   * retries — unlike an overwrite, which looks like success.
   */
  it('refuses the archive write that lost the race, and takes the re-read', async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const store = yield* SpaceStore;
        yield* store.putMeta({
          space: SPACE,
          authority: AUTHORITY,
          archive: new Uint8Array([1]),
        });
        const first = yield* store.metaVersioned(SPACE);
        if (Option.isNone(first)) {
          throw new Error('the archive that was just written is not there');
        }
        yield* store.replaceMeta({
          space: SPACE,
          authority: AUTHORITY,
          archive: new Uint8Array([2]),
          expected: first.value.version,
        });
        // The same version again: the archive has moved on, so this would drop the write above.
        const lost = yield* Effect.result(
          store.replaceMeta({
            space: SPACE,
            authority: AUTHORITY,
            archive: new Uint8Array([3]),
            expected: first.value.version,
          }),
        );
        const current = yield* store.metaVersioned(SPACE);
        if (Option.isNone(current)) {
          throw new Error('the archive disappeared');
        }
        const again = yield* Effect.result(
          store.replaceMeta({
            space: SPACE,
            authority: AUTHORITY,
            archive: new Uint8Array([4]),
            expected: current.value.version,
          }),
        );
        return { lost, again, after: yield* store.meta(SPACE) };
      }),
    );
    expect(Result.isFailure(outcome.lost)).toBe(true);
    if (Result.isFailure(outcome.lost)) {
      expect(outcome.lost.failure._tag).toBe('KeyPreconditionFailed');
    }
    expect(Result.isSuccess(outcome.again)).toBe(true);
    expect(
      Option.isSome(outcome.after) ? outcome.after.value : undefined,
    ).toEqual(new Uint8Array([4]));
  });
});
