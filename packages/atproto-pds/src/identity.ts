import { Effect, Match, Option, Result, Schema } from 'effect';
import { type HandleDns, announceHandle, forgetHandle } from './handle-dns.js';
import {
  type HandleTransportShape,
  PlcSignedOperationSchema,
  buildOperation,
  liveHandleTransport,
  parseDidFromTxt,
  parseDidFromWellKnown,
  signOperation,
  validateOperation,
} from '@eoa/identity';
import {
  type PdsConfig,
  authenticate,
  invalid,
  notFound,
  serverError,
} from './pds.js';
import {
  createDIDKey,
  parseP256DidKey,
  parseSecp256k1DidKey,
} from '@eoa/crypto';
import {
  currentOperationCid,
  currentOperationData,
  submitOperation,
} from '@eoa/identity';
import { ACCESS_SCOPE } from './token.js';
import { type AccountStore } from './account-store.js';
import type { DpopReplay } from './dpop-replay.js';
import { type XrpcServer } from '@eoa/xrpc-server';
import { heldKemKey } from './kem.js';
import { validHandle } from './account.js';

/**
 * Identity, at the surface (the Effect-PDS map, `i4dk`).
 *
 * Three methods, and between them they say what this PDS believes an account
 * *is*: a handle that resolves to a DID, a DID that a client can publish
 * credentials for, and a handle that can move without the DID moving with it —
 * because the DID is not derived from the handle (`wrds`), a rename is a swap of
 * one row, not a new identity.
 */

const ResolveHandleSchema = Schema.Struct({ handle: Schema.String });

const UpdateHandleSchema = Schema.Struct({ handle: Schema.String });

/**
 * The parts of an operation a caller may set. Every field is optional: a
 * migration sends what `getRecommendedDidCredentials` returned, and a PDS that
 * fills the rest from its own config is the same call with an empty body.
 */
const PlcOverridesSchema = Schema.Struct({
  alsoKnownAs: Schema.optional(Schema.Array(Schema.String)),
  rotationKeys: Schema.optional(Schema.Array(Schema.String)),
  // What a migration sends: the *destination's* recommended methods, of which
  // `atproto_kem` is as much a part as `atproto`. Carrying only the signing key
  // would publish a document whose KEM key is the source's, or none at all.
  verificationMethods: Schema.optional(
    Schema.Struct({
      atproto: Schema.optional(Schema.String),
      atproto_kem: Schema.optional(Schema.String),
    }),
  ),
  services: Schema.optional(
    Schema.Struct({
      atproto_pds: Schema.Struct({
        type: Schema.String,
        endpoint: Schema.String,
      }),
    }),
  ),
});

const SubmitPlcSchema = Schema.Struct({
  operation: PlcSignedOperationSchema,
});

/** The PLC configuration, or nothing when this PDS serves `did:web` only. */
const plcOf = (config: PdsConfig) =>
  config.plcDirectoryUrl === undefined || config.plcRotationKey === undefined
    ? undefined
    : { url: config.plcDirectoryUrl, key: config.plcRotationKey };

/** What the identity surface needs: the accounts, and who we are. */
export interface IdentitySurfaceDeps {
  readonly config: PdsConfig;
  readonly accounts: AccountStore['Service'];
  readonly replay: DpopReplay['Service'];
  /**
   * How a handle outside our domain is checked, when one is named.
   *
   * Absent means the live network (DoH + `/.well-known`). Naming one is what a
   * test does, and what a deployment would do if it ever had to resolve handles
   * some other way.
   */
  readonly handles?: HandleTransportShape;
  /** Where a handle's external answer is written (`a34b`). Absent means this deployment does not. */
  readonly handleDns?: HandleDns | undefined;
}

/**
 * Whether the **network** already points a handle at this DID.
 *
 * A handle ending in our own domain is ours to give. One outside it — a client's
 * own domain, which is exactly what a migration preserves — is only ours to give
 * if the network says so: the `_atproto` TXT record of the handle, or the
 * document its `/.well-known/atproto-did` serves, names this DID. Asked at the
 * moment of the change rather than trusted, because the other answer is an
 * account claiming a name whose DNS belongs to somebody else.
 *
 * Both halves are the same claim read two ways, and either is enough: a TXT
 * record is what a zone can publish, and `accio.blue` publishes only that.
 */
export const handleClaimedBy = (params: {
  readonly handle: string;
  readonly did: string;
  readonly transport: HandleTransportShape;
}) =>
  Effect.gen(function* () {
    const fromTxt = yield* params.transport.lookupTxt(params.handle).pipe(
      Effect.map(parseDidFromTxt),
      Effect.orElseSucceed(() => undefined),
    );
    if (fromTxt === params.did) {
      return true;
    }
    const body = yield* params.transport
      .fetchWellKnown(params.handle)
      .pipe(Effect.orElseSucceed(() => undefined));
    return body !== undefined && parseDidFromWellKnown(body) === params.did;
  });

/**
 * The two halves of the rotation list, kept apart because they answer different
 * questions: `host` is the key we sign with, and the one that has to be named for
 * us to submit at all; `recovery` is the key that outranks us.
 */
interface RotationKeys {
  /** The operator's offline key, first in the list. Absent when the network has none. */
  readonly recovery: string | undefined;
  /** Our own key. Absent on a `did:web`, which has no rotation. */
  readonly host: string | undefined;
}

/** Whether a directory would take this as a rotation key: P-256 or secp256k1. */
const isKnownDidKey = (key: string) =>
  Result.isSuccess(parseP256DidKey(key)) ||
  Result.isSuccess(parseSecp256k1DidKey(key));

/**
 * The rotation keys this PDS names, most authoritative first: the network
 * operator's offline recovery key when the network has one configured, then the
 * key we sign with.
 *
 * The order is the authority — only a key listed *ahead* of the signer may
 * nullify its operation (`authorizingKeys` slices the list there) — so listing
 * the operator first is what lets the operator undo a move and us not.
 *
 * Empty when no rotation key is configured — the `did:web` answer: a `did:web`
 * has no rotation, which is exactly the trade it makes against a `did:plc`. A
 * `did:plc` account cannot be moved to a PDS that does not name itself here, so
 * the field is what makes this PDS a migration destination.
 */
const rotationKeysOf = (config: PdsConfig) => {
  const recovery = config.plcRecoveryDidKey;
  // A recovery key the directory would refuse is worth refusing here, where it
  // is one config line, rather than after the source has signed it into an
  // operation — which is the only other place it can be noticed.
  if (recovery !== undefined && !isKnownDidKey(recovery)) {
    return Effect.fail(
      serverError(`the recovery key is not a did:key: ${recovery}`),
    );
  }
  if (config.plcRotationKey === undefined) {
    return Effect.succeed<RotationKeys>({ recovery, host: undefined });
  }
  return createDIDKey(config.plcRotationKey.publicKey).pipe(
    Effect.map((host) => ({ recovery, host })),
    Effect.mapError(() => serverError('the rotation key has no did:key')),
  );
};

/** Those keys as the array an operation carries, most authoritative first. */
const listedRotationKeys = (keys: RotationKeys) =>
  keys.host === undefined
    ? []
    : keys.recovery === undefined
      ? [keys.host]
      : [keys.recovery, keys.host];

export const registerIdentityMethods = (
  server: XrpcServer,
  deps: IdentitySurfaceDeps,
) => {
  // Public: this is the question another implementation asks to find us, and the
  // `H/{handle}` row is already the answer.
  server.method('com.atproto.identity.resolveHandle', {}, (ctx) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(ResolveHandleSchema)(
        ctx.params,
      );
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for resolveHandle'));
      }
      const found = yield* deps.accounts
        .byHandle(decoded.value.handle.toLowerCase())
        .pipe(
          Effect.mapError(() => serverError('the account could not be read')),
        );
      return Option.isNone(found)
        ? yield* Effect.fail(notFound('HandleNotFound', decoded.value.handle))
        : { did: found.value.did };
    }),
  );

  server.method('com.atproto.identity.updateHandle', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const decoded = Schema.decodeUnknownOption(UpdateHandleSchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for updateHandle'));
      }
      const handle = decoded.value.handle.toLowerCase();
      // One of ours, or one the **network** already points at this account. The
      // second is what a migration needs: the handle it preserves belongs to the
      // client's own domain, and a DID that does not change keeps the name.
      if (!validHandle(handle, deps.config.domain)) {
        const claimed = yield* handleClaimedBy({
          handle,
          did: caller.account.did,
          transport: deps.handles ?? liveHandleTransport,
        });
        if (!claimed) {
          return yield* Effect.fail(
            invalid(
              `a handle here looks like name.${deps.config.domain}, or one whose _atproto record already names this account`,
            ),
          );
        }
      }
      const outcome = yield* deps.accounts
        .rehandle(caller.account.did, handle)
        .pipe(
          Effect.mapError(() => serverError('the handle could not be changed')),
        );
      // The old name stops answering and the new one starts, and both are told to DNS: a resolver
      // that still found the previous handle would send clients to an account that has moved on.
      const renamed = Match.value(outcome).pipe(
        // The same handle is not a change, and not an error either.
        Match.tag('moved', () => Effect.succeed(true)),
        Match.tag('unchanged', () => Effect.succeed(false)),
        Match.tag('handleTaken', (one) =>
          Effect.fail(invalid(`the handle ${one.handle} is taken`)),
        ),
        Match.tag('noAccount', (one) =>
          Effect.fail(notFound('RepoNotFound', one.did)),
        ),
        Match.tag('raced', () =>
          Effect.fail(
            invalid(
              'the account changed while it was being updated; try again',
            ),
          ),
        ),
        Match.exhaustive,
      );
      const didMove = yield* renamed;
      if (didMove) {
        yield* announceHandle(deps.handleDns, {
          handle,
          did: caller.account.did,
        });
        if (caller.account.handle !== handle) {
          yield* forgetHandle(deps.handleDns, {
            handle: caller.account.handle,
          });
        }
      }
      return {};
    }),
  );

  server.method(
    'com.atproto.identity.getRecommendedDidCredentials',
    {},
    (ctx) =>
      Effect.gen(function* () {
        const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
        // The key this PDS signs the account's commits with, as a did:key — which
        // is what a `did:web` document lists as a verification method.
        const atproto = yield* createDIDKey(
          deps.config.signingKey.publicKey,
        ).pipe(
          Effect.mapError(() => serverError('the signing key has no did:key')),
        );
        // The account's own KEM key, when this PDS holds one. A client publishes
        // it beside `atproto`; without it a space-credential read of this
        // account's repos has no shared secret to agree.
        const kem = yield* heldKemKey({
          accounts: deps.accounts,
          did: caller.account.did,
        }).pipe(
          Effect.mapError(() =>
            serverError('the account key could not be read'),
          ),
        );
        const rotation = listedRotationKeys(yield* rotationKeysOf(deps.config));
        const credentials = {
          alsoKnownAs: [`at://${caller.account.handle}`],
          verificationMethods: {
            atproto,
            ...(Option.isSome(kem) ? { atproto_kem: kem.value.didKey } : {}),
          },
          services: {
            atproto_pds: {
              type: 'AtprotoPersonalDataServer',
              endpoint:
                deps.config.publicUrl ?? `https://${deps.config.domain}`,
            },
          },
        };
        // A did:web has no rotation, so the field is absent rather than empty.
        // A did:plc must name us here, or the operation cannot be signed by us.
        return rotation.length === 0
          ? credentials
          : { ...credentials, rotationKeys: rotation };
      }),
  );

  // `signPlcOperation` reads the DID's chain from the directory, points a new
  // operation at its head, and signs it with the rotation key. It is the half a
  // migration needs on the *old* server — and the half that lets an account
  // leave, which is the point of the pair.
  server.method('com.atproto.identity.signPlcOperation', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const plc = plcOf(deps.config);
      if (plc === undefined) {
        return yield* Effect.fail(
          invalid(
            'this PDS has no PLC rotation key; a did:web cannot be moved',
          ),
        );
      }
      const decoded = Schema.decodeUnknownOption(PlcOverridesSchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for signPlcOperation'));
      }
      const ours = yield* rotationKeysOf(deps.config);
      const rotation = decoded.value.rotationKeys ?? listedRotationKeys(ours);
      if (ours.host === undefined || rotation.length === 0) {
        return yield* Effect.fail(
          invalid('rotationKeys must name at least one key'),
        );
      }
      // Two legal operations, one guard. An operation that keeps pointing at us must name us, or
      // nobody could submit it — that is a mistake, not a request. An operation that points
      // **somewhere else** is a handover: the rotation keys are the operator's recovery key and the
      // destination's host key, and the server signing it is the one being left. The check that
      // matters for that one lives on the other side: `submitPlcOperation` refuses an operation that
      // does not name *it*, so a destination cannot be handed a DID pointed somewhere else.
      const endpoint =
        decoded.value.services?.atproto_pds.endpoint ??
        deps.config.publicUrl ??
        `https://${deps.config.domain}`;
      const oursEndpoint =
        deps.config.publicUrl ?? `https://${deps.config.domain}`;
      if (!rotation.includes(ours.host) && endpoint === oursEndpoint) {
        return yield* Effect.fail(
          invalid(
            'rotationKeys must name this PDS, or the operation must point elsewhere',
          ),
        );
      }
      const head = yield* currentOperationCid({
        plcUrl: plc.url,
        did: caller.account.did,
      }).pipe(
        Effect.mapError(() => serverError('the directory could not be read')),
      );
      if (Option.isNone(head)) {
        return yield* Effect.fail(
          invalid(
            `the directory has no chain for ${caller.account.did}; a new account is createAccount, not a signed operation`,
          ),
        );
      }

      /**
       * The step before a handover, and the reason it can be undone.
       *
       * PLC authorises an operation by the **previous** one's rotation keys, so a key that first
       * appears in the switch cannot nullify that switch. A handover therefore needs one operation
       * ahead of it: the key the handover puts first — the operator's recovery key, by the ordering
       * `dhs6` settled — listed alongside ours while the DID still points here. Only then is the
       * switch undoable by the operator, which is the 72-hour exit the whole thing is for.
       *
       * Signed and submitted here rather than left to the caller: an irreversible handover is not
       * something a mover should be able to ask for by forgetting a step.
       */
      let prev = head.value;
      const leavesHere = endpoint !== oursEndpoint;
      const first = rotation[0];
      if (leavesHere && first !== undefined) {
        const current = yield* currentOperationData({
          plcUrl: plc.url,
          did: caller.account.did,
        }).pipe(
          Effect.mapError(() => serverError('the directory could not be read')),
        );
        if (
          Option.isSome(current) &&
          !current.value.rotationKeys.includes(first)
        ) {
          const prepare = buildOperation({
            // The document does not change hands yet: same aliases, same methods, still our endpoint.
            alsoKnownAs: current.value.alsoKnownAs,
            serviceEndpoint: oursEndpoint,
            rotationKeys: [first, ...current.value.rotationKeys],
            signingKey: current.value.verificationMethods.atproto,
            ...(current.value.verificationMethods.atproto_kem === undefined
              ? {}
              : { kemKey: current.value.verificationMethods.atproto_kem }),
            prev,
          });
          const signedPrepare = yield* signOperation({
            operation: prepare,
            privateKey: plc.key,
          }).pipe(
            Effect.mapError(() =>
              serverError('the operation could not be signed'),
            ),
          );
          yield* submitOperation({
            plcUrl: plc.url,
            did: caller.account.did,
            operation: signedPrepare,
          }).pipe(
            Effect.mapError(() =>
              serverError(
                'the directory refused the operation that lists the recovery key',
              ),
            ),
          );
          // The head is read again rather than derived: the directory decides what the CID of what
          // it just accepted is, and the switch has to point at that.
          const after = yield* currentOperationCid({
            plcUrl: plc.url,
            did: caller.account.did,
          }).pipe(
            Effect.mapError(() =>
              serverError('the directory could not be read'),
            ),
          );
          if (Option.isNone(after)) {
            return yield* Effect.fail(
              serverError(
                'the directory accepted an operation and then had no head',
              ),
            );
          }
          prev = after.value;
        }
      }
      const signingKey = yield* createDIDKey(
        deps.config.signingKey.publicKey,
      ).pipe(
        Effect.mapError(() => serverError('the signing key has no did:key')),
      );
      // A migration sends the destination's keys; a caller that sends none gets
      // this account's own — the same rule as `atproto`, so a signed operation
      // never silently retracts the KEM key the account holds here.
      const held = yield* heldKemKey({
        accounts: deps.accounts,
        did: caller.account.did,
      }).pipe(
        Effect.mapError(() => serverError('the account key could not be read')),
      );
      const kemKey =
        decoded.value.verificationMethods?.atproto_kem ??
        (Option.isSome(held) ? held.value.didKey : undefined);
      const operation = buildOperation({
        alsoKnownAs: decoded.value.alsoKnownAs ?? [
          `at://${caller.account.handle}`,
        ],
        serviceEndpoint:
          decoded.value.services?.atproto_pds.endpoint ??
          deps.config.publicUrl ??
          `https://${deps.config.domain}`,
        rotationKeys: rotation,
        signingKey: decoded.value.verificationMethods?.atproto ?? signingKey,
        ...(kemKey === undefined ? {} : { kemKey }),
        prev,
      });
      const signed = yield* signOperation({
        operation,
        privateKey: plc.key,
      }).pipe(
        Effect.mapError(() => serverError('the operation could not be signed')),
      );
      return { operation: signed };
    }),
  );

  // `submitPlcOperation` is the last step of a move: the old server has already
  // signed, and this PDS forwards it to the directory. It checks the operation
  // names it — the rotation key and the endpoint — before it does, because a
  // submission that pointed the DID somewhere else is a footgun, not a request.
  server.method('com.atproto.identity.submitPlcOperation', {}, (ctx) =>
    Effect.gen(function* () {
      const caller = yield* authenticate(deps, ctx, ACCESS_SCOPE);
      const plc = plcOf(deps.config);
      if (plc === undefined) {
        return yield* Effect.fail(
          invalid('this PDS has no PLC rotation key; it cannot receive a move'),
        );
      }
      const decoded = Schema.decodeUnknownOption(SubmitPlcSchema)(ctx.input);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(invalid('bad input for submitPlcOperation'));
      }
      const operation = decoded.value.operation;
      if (operation.type !== 'plc_operation') {
        return yield* Effect.fail(
          invalid(
            'a tombstone is not a move; it is submitted by the DID owner',
          ),
        );
      }
      yield* validateOperation(operation).pipe(
        Effect.mapError(() =>
          invalid('the operation is not a legal PLC operation'),
        ),
      );
      const ours = yield* rotationKeysOf(deps.config);
      // Ours, not the first in the list: the operator's recovery key sits ahead
      // of us by design, and naming *it* is not naming this PDS.
      if (
        ours.host === undefined ||
        !operation.rotationKeys.includes(ours.host)
      ) {
        return yield* Effect.fail(
          invalid('the operation does not name this PDS as a rotation key'),
        );
      }
      const endpoint = deps.config.publicUrl ?? `https://${deps.config.domain}`;
      if (operation.services.atproto_pds.endpoint !== endpoint) {
        return yield* Effect.fail(
          invalid(
            `the operation points the DID at ${operation.services.atproto_pds.endpoint}, not at ${endpoint}`,
          ),
        );
      }
      // The KEM key this PDS holds is the one the document must name: an
      // operation that publishes a different key (or none) would leave us
      // unable to decapsulate for a reader that resolved the DID.
      const held = yield* heldKemKey({
        accounts: deps.accounts,
        did: caller.account.did,
      }).pipe(
        Effect.mapError(() => serverError('the account key could not be read')),
      );
      if (
        Option.isSome(held) &&
        operation.verificationMethods.atproto_kem !== held.value.didKey
      ) {
        return yield* Effect.fail(invalid('Incorrect KEM key'));
      }
      yield* submitOperation({
        plcUrl: plc.url,
        did: caller.account.did,
        operation,
      }).pipe(
        Effect.mapError(() =>
          serverError('the directory refused the operation'),
        ),
      );
      return {};
    }),
  );
};
