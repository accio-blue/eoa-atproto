import { type PlcSignedOperation, createAccount } from '@eoa/identity';
import { type PrivateKey, createDIDKey } from '@eoa/crypto';
import { Effect } from 'effect';

/**
 * Minting this PDS's own `did:plc` (ticket `vasp`).
 *
 * A `did:plc` **is** its own genesis operation, so "the org's DID" is something
 * that has to be minted rather than chosen: the keys are named in the operation,
 * the operation is signed by the rotation key, and the DID is the hash of it.
 *
 * The cast is the whole point — `rotationKeys` first, so it is the rotation key
 * that can move the DID later; `verificationMethods.atproto` is the key this PDS
 * signs its commits with; and `services.atproto_pds` is where the DID will point
 * the moment the directory accepts the operation. Get any of those wrong and the
 * DID still mints — it simply names a different server or a different key.
 */
export interface MintedIdentity {
  readonly did: string;
  readonly operation: PlcSignedOperation;
}

/** The pieces an operator already has: the keys, the handle, and the endpoint. */
export interface MintParams {
  readonly handle: string;
  /** The endpoint the DID will point at — `PDS_PUBLIC_URL`. */
  readonly endpoint: string;
  /** The key this PDS signs commits and sessions with. */
  readonly signingKey: PrivateKey;
  /** The PLC rotation key: what authorises every later change to the DID. */
  readonly rotationKey: PrivateKey;
}

export const mintIdentity = (params: MintParams) =>
  Effect.gen(function* () {
    const rotation = yield* createDIDKey(params.rotationKey.publicKey);
    const signing = yield* createDIDKey(params.signingKey.publicKey);
    const minted = yield* createAccount({
      handle: params.handle,
      serviceEndpoint: params.endpoint,
      // One rotation key, and it is ours: the operator recovery key is added by
      // the directory or a later operation, not at genesis.
      rotationKeys: [rotation],
      signingKey: signing,
      rotationPrivateKey: params.rotationKey,
    });
    return { did: String(minted.did), operation: minted.operation };
  });
