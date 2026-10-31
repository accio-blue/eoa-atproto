import { Context, Effect, Layer } from 'effect';
import { type CryptoError, type PublicKey, verify } from '@eoa/crypto';
import { DID, encodeCbor } from '@eoa/core';
import { type RecordHead, type SpaceRecordOp } from './write-log.js';
import { LookupError } from './grant.js';

/**
 * Ingest checks for a space write (permission-primitive.md section 9.3). The
 * write log itself trusts `author`/`signature`/`rev`; before an op is appended
 * the host verifies its signature against the author's key, enforces that the
 * revision moves forward, and requires the author to be the space authority.
 */

/** The bytes an op's `signature` covers: the op without the signature field. */
export const opSigningBytes = (op: SpaceRecordOp): Uint8Array =>
  encodeCbor({
    space: op.space,
    collection: op.collection,
    rkey: op.rkey,
    action: op.action,
    prevCid: op.prevCid ?? null,
    cid: op.cid,
    rev: op.rev,
    author: op.author,
  });

export const verifyOpSignature = (
  op: SpaceRecordOp,
  publicKey: PublicKey,
): Effect.Effect<boolean, CryptoError> =>
  verify(publicKey, opSigningBytes(op), op.signature);

/**
 * A TID is base32-sortable, so `<` is chronological: a write may only carry a
 * revision later than the record's current one. An absent current record (a
 * create, or the first write) has nothing to beat.
 */
export const revIsMonotonic = (
  op: Pick<SpaceRecordOp, 'rev'>,
  current: RecordHead | undefined,
): boolean => current === undefined || op.rev > current.rev;

/** Where an author's signing key comes from. Real DID resolution plugs in here. */
export class AuthorKeys extends Context.Service<
  AuthorKeys,
  {
    readonly publicKeyOf: (did: DID) => Effect.Effect<PublicKey, LookupError>;
  }
>()('@eoa/space-host/AuthorKeys') {
  static readonly layerFrom = (keys: ReadonlyMap<DID, PublicKey>) =>
    Layer.succeed(
      AuthorKeys,
      AuthorKeys.of({
        publicKeyOf: (did) => {
          const key = keys.get(did);
          return key === undefined
            ? Effect.fail(
                new LookupError({
                  source: 'author-keys',
                  message: `no signing key for ${did}`,
                }),
              )
            : Effect.succeed(key);
        },
      }),
    );
}

export type IngestFailure =
  | 'not-authority'
  | 'bad-signature'
  | 'rev-not-monotonic';

/**
 * The first way an op fails ingest, or `undefined` when it may be appended.
 * Fail-closed: a lookup failure is an error, and the caller must not append.
 */
export const ingestFailure = (input: {
  readonly op: SpaceRecordOp;
  readonly authority: DID;
  readonly current?: RecordHead | undefined;
}): Effect.Effect<
  IngestFailure | undefined,
  CryptoError | LookupError,
  AuthorKeys
> =>
  Effect.gen(function* () {
    if (input.op.author !== input.authority) {
      return 'not-authority';
    }
    const keys = yield* AuthorKeys;
    const publicKey = yield* keys.publicKeyOf(input.op.author);
    if (!(yield* verifyOpSignature(input.op, publicKey))) {
      return 'bad-signature';
    }
    if (!revIsMonotonic(input.op, input.current)) {
      return 'rev-not-monotonic';
    }
    return undefined;
  });
