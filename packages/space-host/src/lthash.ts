import { type CryptoError, sha256 } from '@eoa/crypto';
import { Effect } from 'effect';
import { concatBytes } from '@eoa/core';

/**
 * LtHash - proposal 0016's order-independent set hash, used as a permissioned
 * repo's state commitment (a two-root CAR carries no MST).
 *
 * 1024 u16 lanes, each element mixed in by adding its 2048 lane bytes modulo
 * 2^16, so the state depends on the SET of elements and not their order; a
 * removal subtracts the same bytes. The digest is `sha256` of the 2048-byte
 * state. The lane bytes are `sha256(element || counter)` in counter mode - ours
 * rather than atproto's BLAKE3-XOF, since a shared byte-for-byte format is not
 * needed while their branch is experimental.
 */

export const LT_HASH_LANES = 1024;
const LANES_BYTES = LT_HASH_LANES * 2;
const MODULUS = 0x10000;
const SHA256_BYTES = 32;

export type LtHashState = Uint16Array;

export const emptyLtHash = (): LtHashState => new Uint16Array(LT_HASH_LANES);

const laneBytesOf = (
  element: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    for (
      let counter = 0;
      chunks.length * SHA256_BYTES < LANES_BYTES;
      counter += 1
    ) {
      const suffix = new Uint8Array(4);
      new DataView(suffix.buffer).setUint32(0, counter, false);
      chunks.push(yield* sha256(concatBytes([element, suffix])));
    }
    return concatBytes(chunks).slice(0, LANES_BYTES);
  });

const mix = (
  state: LtHashState,
  bytes: Uint8Array,
  direction: 1 | -1,
): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let lane = 0; lane < LT_HASH_LANES; lane += 1) {
    const current = state[lane] ?? 0;
    const value = view.getUint16(lane * 2, true);
    state[lane] = (current + direction * value + MODULUS) % MODULUS;
  }
};

/** Mixes elements into a state; `-1` removes them again. */
export const mixElements = (
  state: LtHashState,
  elements: ReadonlyArray<Uint8Array>,
  direction: 1 | -1,
): Effect.Effect<LtHashState, CryptoError> =>
  Effect.gen(function* () {
    for (const element of elements) {
      mix(state, yield* laneBytesOf(element), direction);
    }
    return state;
  });

/** The state over a set of elements; order does not matter. */
export const ltHashOf = (
  elements: ReadonlyArray<Uint8Array>,
): Effect.Effect<LtHashState, CryptoError> =>
  mixElements(emptyLtHash(), elements, 1);

export const serializeLtHash = (state: LtHashState): Uint8Array =>
  new Uint8Array(state.buffer, state.byteOffset, state.byteLength).slice();

/** The 32-byte commitment to the set: `sha256` of the serialized state. */
export const ltHashDigestOf = (
  elements: ReadonlyArray<Uint8Array>,
): Effect.Effect<Uint8Array, CryptoError> =>
  ltHashOf(elements).pipe(
    Effect.flatMap((state) => sha256(serializeLtHash(state))),
  );

/** Constant-time comparison, so a MAC check does not leak where it differs. */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
};
