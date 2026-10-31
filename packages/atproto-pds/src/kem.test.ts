import { AccountStore, accountStoreLayer } from './account-store.js';
import { Effect, Layer, Option, Stream } from 'effect';
import { Firehose, type FirehoseEvent, firehoseLayer } from './firehose.js';
import {
  type PrivateKey,
  createDIDKey,
  generateES256KeyPair,
} from '@eoa/crypto';
import { backfillKemKeys, ensureKemKey, heldKemKey } from './kem.js';
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { kvMemoryLayer } from '@eoa/kv';

/**
 * The `#atproto_kem` lifecycle, minus the HTTP surface (spaces alpha,
 * 2026-10-22, §7).
 *
 * Two promises are what these tests are about: a key is generated once and never
 * replaced behind the account's back, and the backfill that gives existing
 * accounts one runs once, publishes only where it is allowed to, and leaves a
 * failure to be retried rather than recorded as done.
 */

const DOMAIN = 'pds.example';

const signingKeyOf = () =>
  Effect.runPromise(
    generateES256KeyPair().pipe(Effect.map((pair) => pair.privateKey)),
  );

const configOf = (params: {
  readonly signingKey: PrivateKey;
  readonly plc?: { readonly url: string; readonly key: PrivateKey };
}) => ({
  did: `did:web:${DOMAIN}`,
  domain: DOMAIN,
  signingKey: params.signingKey,
  clockId: 0,
  ...(params.plc === undefined
    ? {}
    : { plcDirectoryUrl: params.plc.url, plcRotationKey: params.plc.key }),
});

/** A store of its own, with the accounts a test made. */
const withStack = <A, E>(
  use: (stack: {
    readonly accounts: AccountStore['Service'];
    readonly firehose: Firehose['Service'];
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use({
        accounts: yield* AccountStore,
        firehose: yield* Firehose,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(accountStoreLayer, firehoseLayer()).pipe(
          Layer.provide(kvMemoryLayer),
        ),
      ),
    ),
  );

const register = (params: {
  readonly accounts: AccountStore['Service'];
  readonly did: string;
  readonly handle: string;
}) =>
  params.accounts.create({
    did: params.did,
    handle: params.handle,
    email: null,
    passwordHash: 'pbkdf2$1$salt$hash',
    inviteCode: undefined,
    inviteRequired: false,
    now: 1000,
  });

describe('an account’s KEM key', () => {
  it('is generated once, and never replaced', async () => {
    const keys = await withStack(({ accounts }) =>
      Effect.gen(function* () {
        yield* register({
          accounts,
          did: 'did:web:pds.example:one',
          handle: 'a.pds.example',
        });
        const first = yield* ensureKemKey({
          accounts,
          did: 'did:web:pds.example:one',
          now: 1,
        });
        const second = yield* ensureKemKey({
          accounts,
          did: 'did:web:pds.example:one',
          now: 2,
        });
        return { first, second };
      }),
    );

    expect(keys.first.didKey).toMatch(/^did:key:zDna/u);
    // A second key would be one the published document does not name, so the
    // stored one is the answer even when the caller asks for a fresh one.
    expect(keys.second.didKey).toBe(keys.first.didKey);
  });

  it('is per-account: one account’s key is not another’s', async () => {
    const report = await withStack(({ accounts }) =>
      Effect.gen(function* () {
        yield* register({
          accounts,
          did: 'did:web:pds.example:one',
          handle: 'a.pds.example',
        });
        yield* register({
          accounts,
          did: 'did:web:pds.example:two',
          handle: 'b.pds.example',
        });
        const one = yield* ensureKemKey({
          accounts,
          did: 'did:web:pds.example:one',
          now: 1,
        });
        const two = yield* ensureKemKey({
          accounts,
          did: 'did:web:pds.example:two',
          now: 1,
        });
        return {
          one,
          two,
          held: yield* heldKemKey({ accounts, did: 'did:web:pds.example:one' }),
        };
      }),
    );

    expect(report.one.didKey).not.toBe(report.two.didKey);
    // ...and reading one account's key never answers with another's.
    expect(Option.getOrThrow(report.held).didKey).toBe(report.one.didKey);
  });
});

describe('the KEM backfill', () => {
  it('gives a key to every account, records completion, and never runs again', async () => {
    const signingKey = await signingKeyOf();
    const config = configOf({ signingKey });

    const report = await withStack(({ accounts, firehose }) =>
      Effect.gen(function* () {
        yield* register({
          accounts,
          did: 'did:web:pds.example:one',
          handle: 'a.pds.example',
        });
        yield* register({
          accounts,
          did: 'did:web:pds.example:two',
          handle: 'b.pds.example',
        });
        // One account already has a key: the backfill must keep it, not mint a
        // second one the document does not name.
        const kept = yield* ensureKemKey({
          accounts,
          did: 'did:web:pds.example:two',
          now: 1,
        });

        const first = yield* backfillKemKeys({
          config,
          accounts,
          firehose,
          now: 5,
        });
        const second = yield* backfillKemKeys({
          config,
          accounts,
          firehose,
          now: 6,
        });
        return {
          first,
          second,
          kept,
          one: yield* heldKemKey({ accounts, did: 'did:web:pds.example:one' }),
          two: yield* heldKemKey({ accounts, did: 'did:web:pds.example:two' }),
          head: yield* firehose.head,
        };
      }),
    );

    expect(report.first.ran).toBe(true);
    expect(report.first.visited).toBe(2);
    // Nothing was published: a `did:web` document is not in a directory.
    expect(report.first.unpublished).toEqual([
      'did:web:pds.example:one',
      'did:web:pds.example:two',
    ]);
    expect(report.first.published).toEqual([]);

    expect(Option.isSome(report.one)).toBe(true);
    expect(Option.isSome(report.two)).toBe(true);
    expect(Option.getOrThrow(report.two).didKey).toBe(report.kept.didKey);

    // Completion is recorded, so a second boot visits nothing at all.
    expect(report.second.ran).toBe(false);
    expect(report.second.visited).toBe(0);
    // ...and no `#identity` event was emitted for a key nobody published.
    expect(report.head.seq).toBe(0);
  });

  it('publishes to PLC and says so on the stream, when it is the current PDS', async () => {
    const signingKey = await signingKeyOf();
    const rotation = await Effect.runPromise(generateES256KeyPair());
    const rotationDidKey = await Effect.runPromise(
      createDIDKey(rotation.publicKey),
    );
    const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
    const endpoint = `https://${DOMAIN}`;
    const headCid =
      'bafyreidfayvfuwqa4xokwj2gmwzdsv4v5w5ndp7zq2qk5v2n5w2w5w5w5w4';
    const submissions: string[] = [];
    const directory = createServer((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        // `/log/audit` is the head, `/data` the state a new operation has to
        // carry forward whole.
        response.end(
          request.url?.endsWith('/log/audit') === true
            ? JSON.stringify([{ cid: headCid }])
            : JSON.stringify({
                did,
                rotationKeys: [rotationDidKey],
                verificationMethods: { atproto: rotationDidKey },
                alsoKnownAs: ['at://a.pds.example'],
                services: {
                  atproto_pds: {
                    type: 'AtprotoPersonalDataServer',
                    endpoint,
                  },
                },
              }),
        );
        return;
      }
      const chunks: Uint8Array[] = [];
      request.on('data', (chunk: Uint8Array) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        submissions.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      directory.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = directory.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;

    const report = await withStack(({ accounts, firehose }) =>
      Effect.gen(function* () {
        yield* register({ accounts, did, handle: 'a.pds.example' });
        const backfill = yield* backfillKemKeys({
          config: configOf({
            signingKey,
            plc: {
              url: `http://127.0.0.1:${port}`,
              key: rotation.privateKey,
            },
          }),
          accounts,
          firehose,
          now: 5,
        });
        // Resuming from the start replays the window, so the event a syncer
        // would have received is the event this reads.
        const event: Option.Option<FirehoseEvent> = yield* Stream.runHead(
          firehose.subscribe({ cursor: 0 }),
        );
        return { backfill, event, held: yield* heldKemKey({ accounts, did }) };
      }),
    );
    directory.close();

    expect(report.backfill.published).toEqual([did]);
    expect(report.backfill.failed).toEqual([]);
    // The operation carried the held key, and pointed `prev` at the head — a PLC
    // operation is the whole document, so the aliases and rotation keys are
    // carried forward untouched.
    expect(submissions).toHaveLength(1);
    const submitted = submissions[0] ?? '';
    const key = Option.getOrThrow(report.held);
    expect(submitted).toContain(key.didKey);
    expect(submitted).toContain(headCid);
    expect(submitted).toContain('at://a.pds.example');

    const event = Option.getOrThrow(report.event);
    expect(event.kind).toBe('identity');
    expect(event.did).toBe(did);
  });
});
