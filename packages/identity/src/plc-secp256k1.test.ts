import { Effect, Result } from 'effect';
import {
  type PlcSignedOperation,
  buildOperation,
  createAccount,
  signOperation,
  validateGenesisOperation,
  validateOperation,
  verifyOperationSignature,
} from './plc-operation.js';
import { describe, expect, it } from 'vitest';
import { formatP256DidKey, secp256k1KeyFromScalar } from '@eoa/crypto';

/**
 * A `did:plc` made elsewhere lists secp256k1 rotation keys, and this is the one
 * it matters for: the fixture is kocharin's own key, from its audit log.
 */
const KOCHARIN_ROTATION_KEY =
  'did:key:zQ3shhCGUqDKjStzuDxPkTxN6ujddP4RkEKJJouJGRRkaLGbg';

const ours = formatP256DidKey(new Uint8Array(33).fill(7));

/** A scalar, fixed rather than random: the arithmetic is what is under test. */
const SCALAR = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const operation = (rotationKeys: readonly string[]): PlcSignedOperation => ({
  type: 'plc_operation',
  rotationKeys: [...rotationKeys],
  verificationMethods: { atproto: KOCHARIN_ROTATION_KEY },
  alsoKnownAs: ['at://kocharin.art'],
  services: {
    atproto_pds: {
      type: 'AtprotoPersonalDataServer',
      endpoint: 'https://pds.example',
    },
  },
  prev: null,
});

describe('an operation with secp256k1 keys', () => {
  it('passes the shape check a destination runs before it submits', async () => {
    // The move names the account's own key *and* ours, which is the shape a
    // migration sends: the new list has to include the destination.
    const accepted = await Effect.runPromise(
      validateOperation(operation([KOCHARIN_ROTATION_KEY, ours])),
    );
    expect(accepted.type).toBe('plc_operation');
    if (accepted.type !== 'plc_operation') {
      throw new Error('a validated plc_operation came back a tombstone');
    }
    expect(accepted.rotationKeys).toEqual([KOCHARIN_ROTATION_KEY, ours]);
  });

  it('still refuses a key of no known curve', async () => {
    const refused = await Effect.runPromise(
      Effect.result(validateOperation(operation(['did:key:zNotAKey']))),
    );
    expect(Result.isFailure(refused)).toBe(true);
  });
});

/**
 * The half that used to be missing: not reading a foreign key's shape, but
 * checking what it signed - which is what the directory does on submit, and what
 * makes the operator's own offline recovery key usable at all.
 */
describe('an operation signed by a secp256k1 key', () => {
  const genesis = (rotationKeys: readonly string[]) =>
    buildOperation({
      alsoKnownAs: ['at://kocharin.art'],
      serviceEndpoint: 'https://pds.example',
      rotationKeys,
      signingKey: KOCHARIN_ROTATION_KEY,
      prev: null,
    });

  it('verifies against that key, and stops verifying once the bytes change', async () => {
    const key = await Effect.runPromise(secp256k1KeyFromScalar(SCALAR));
    const signed = await Effect.runPromise(
      signOperation({ operation: genesis([key.didKey]), privateKey: key }),
    );

    const signer = await Effect.runPromise(
      verifyOperationSignature({
        operation: signed,
        allowedKeys: [key.didKey],
      }),
    );
    expect(signer).toBe(key.didKey);

    // The signature covers the operation's own bytes: name another endpoint and
    // the same signature has to stop authorizing it.
    const tampered: PlcSignedOperation = {
      ...signed,
      services: {
        atproto_pds: {
          type: 'AtprotoPersonalDataServer',
          endpoint: 'https://elsewhere.example',
        },
      },
    };
    const refused = await Effect.runPromise(
      Effect.result(
        verifyOperationSignature({
          operation: tampered,
          allowedKeys: [key.didKey],
        }),
      ),
    );
    expect(Result.isFailure(refused)).toBe(true);
  });

  it('is refused when the signer is not one of the allowed keys', async () => {
    // A secp256k1 key whose signature does not match is a "no", not an error:
    // the directory has to be able to say that about the curve it cannot mint.
    const key = await Effect.runPromise(secp256k1KeyFromScalar(SCALAR));
    const stranger = await Effect.runPromise(
      secp256k1KeyFromScalar(SCALAR.map((byte) => byte + 1)),
    );
    const signed = await Effect.runPromise(
      signOperation({ operation: genesis([key.didKey]), privateKey: key }),
    );

    const refused = await Effect.runPromise(
      Effect.result(
        verifyOperationSignature({
          operation: signed,
          allowedKeys: [stranger.didKey],
        }),
      ),
    );
    expect(Result.isFailure(refused)).toBe(true);
  });

  it('mints a genesis the directory would accept, DID and signature together', async () => {
    const key = await Effect.runPromise(secp256k1KeyFromScalar(SCALAR));
    const account = await Effect.runPromise(
      createAccount({
        handle: 'at://kocharin.art',
        serviceEndpoint: 'https://pds.example',
        rotationKeys: [key.didKey],
        signingKey: KOCHARIN_ROTATION_KEY,
        rotationPrivateKey: key,
      }),
    );

    const validated = await Effect.runPromise(
      validateGenesisOperation({
        did: account.did,
        operation: account.operation,
      }),
    );
    expect(validated).toBe(account.did);
  });
});
