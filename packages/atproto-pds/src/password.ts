import {
  CryptoError,
  base64urlDecode,
  base64urlEncode,
  sha256,
} from '@eoa/crypto';
import { Effect } from 'effect';

/**
 * Secrets: the ones people choose, the ones we mint, and the check for each.
 *
 * A **human password** is low-entropy, so it gets a real KDF: PBKDF2-SHA256 at a high iteration
 * count, salted per password, stored as `pbkdf2c$iterations$salt$hash` so the parameters travel
 * with the hash and can be raised later without invalidating anyone. The `c` is for **chained**:
 * one call cannot carry the count every runtime should have, because a Worker's WebCrypto refuses
 * more than 100,000 of them, so the count is spent in rounds of at most that — see
 * `MAX_ROUND_ITERATIONS`.
 *
 * An **app password** is machine-generated with the entropy of a key (~100
 * bits), so it gets a plain digest: a KDF buys nothing against a search space
 * that large, and a digest is what lets a login check every app password on an
 * account without a second of CPU per attempt.
 *
 * Session ids and invite codes are minted here too — same family, same rule:
 * a secret comes from a CSPRNG, and the alphabet is a power of two so a modulo
 * is a uniform draw.
 *
 * // ponytail: PBKDF2 is not memory-hard. Swap for argon2/scrypt when a native
 * // KDF is available on every runtime the PDS runs on.
 */

const ITERATIONS = 600_000;

/**
 * The iteration count a deployment hashes with, when it has to name one.
 *
 * It is a parameter because the count belongs to a deployment's judgement, and it is stored inside
 * every hash (`pbkdf2$iterations$salt$hash`), so raising it later invalidates nobody.
 *
 * // This was read wrong twice before it was read right. A failure was first taken for a CPU budget
 * // that 600,000 iterations could not fit in, and then — when 600,000 worked once and not again —
 * // for a cold start. It is neither: a Worker's WebCrypto **refuses** the parameter. `wrangler
 * // tail` and a throwaway Worker on the edge that asked for several counts settled it, and the
 * // refusal is that worker's own words: `Pbkdf2 failed: iteration counts above 100000 are not
 * // supported (requested 600000)`. No plan raises it and no flag moves it. The "measured cold and
 * // warm, well under a second" that supported the second reading was measured on `wrangler dev`,
 * // whose simulator does not enforce the cap — which is the whole reason a local measurement
 * // could say the opposite of the edge.
 */
export const passwordIterationsOf = (chosen: number | undefined) =>
  chosen ?? ITERATIONS;

/**
 * The most iterations one `deriveBits` call may ask for.
 *
 * The platform's, not ours, and it is a **refusal** rather than a budget: a Worker's WebCrypto
 * answers a larger count with `Pbkdf2 failed: iteration counts above 100000 are not supported
 * (requested …)` before doing any work, so this was never the CPU limit it was twice read as. No
 * plan raises it.
 *
 * It is a compiled constant rather than a deployment setting on purpose: **the hash format has to
 * mean the same thing on every runtime.** A Worker that chained six rounds and a node host that
 * chained one would write hashes each other could not check, and a stored password that can only
 * be verified by the runtime that wrote it is worse than either.
 */
export const MAX_ROUND_ITERATIONS = 100_000;

/**
 * The rounds a total iteration count is spent in, and how many iterations each gets.
 *
 * Split evenly, because an uneven split spends the same work for less protection: `600_000` is six
 * rounds of `100_000`, not five and a remainder. Exported because this is the arithmetic the whole
 * arrangement rests on, and because it can be checked without a runtime that enforces the cap —
 * the local simulator used by the tests happily takes 600,000 in one call, which is exactly how
 * the wrong reading of this was reached.
 */
export const roundsOf = (total: number) => {
  const rounds = Math.max(1, Math.ceil(total / MAX_ROUND_ITERATIONS));
  return { rounds, each: Math.max(1, Math.ceil(total / rounds)) };
};

/** The marker for a **chained** hash, as opposed to `pbkdf2`, which was one call. */
const CHAINED = 'pbkdf2c';

const KEY_BITS = 256;

const SALT_BYTES = 16;

const encoder = new TextEncoder();

/** `[a-z0-9]` words, which is what an app password is made of. */
const APP_PASSWORD_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Four groups of four, which is the shape atproto clients recognise. */
const APP_PASSWORD_GROUPS = 4;

const APP_PASSWORD_GROUP_LENGTH = 4;

/** Five groups of five, which is what an invite code looks like. */
const INVITE_CODE_GROUPS = 5;

const INVITE_CODE_GROUP_LENGTH = 5;

const SESSION_ID_BYTES = 16;

const randomBytes = (length: number) =>
  crypto.getRandomValues(new Uint8Array(length));

const derive = (password: string, salt: Uint8Array, iterations: number) =>
  Effect.tryPromise({
    try: async () => {
      // A copy, because `deriveBits` wants a buffer-backed view and a decode
      // hands back one that may share its bytes.
      const saltBytes = Uint8Array.from(salt);
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits'],
      );
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
        key,
        KEY_BITS,
      );
      return new Uint8Array(bits);
    },
    catch: (cause) => new CryptoError({ cause, operation: 'pbkdf2' }),
  });

/**
 * The salt a round hashes with: the stored one for the first, and the stored one with the round
 * number appended after that.
 *
 * A salt needs no secrecy, only to not repeat, and a round number cannot repeat. Folding it in
 * this way is what lets one salt be stored for a hash whose count spans several rounds.
 */
const saltOfRound = (salt: Uint8Array, round: number) =>
  round === 0
    ? salt
    : Uint8Array.from([...salt, ...encoder.encode(String(round))]);

/**
 * PBKDF2 as far as the platform will take one call, applied until the count is spent.
 *
 * Each round takes the last round's output as its secret and a salt of its own, so the work is
 * sequential — no round can begin before the one before it has ended — and the stored form still
 * carries a single salt. `600_000` is six rounds of `100_000`: the same work as one call the
 * platform will not accept.
 *
 * // Say plainly what it is: a **cascade**, not one 600,000-iteration call. The work factor is the
 * // same and every round is keyed by the one before it, which is what a password KDF needs of it.
 * // If that stops being enough, the answer is a memory-hard KDF, not a longer chain.
 */
const deriveRounds = (password: string, salt: Uint8Array, total: number) =>
  Effect.gen(function* () {
    const { rounds, each } = roundsOf(total);
    // `roundsOf` never returns zero rounds, so the loop's starting point is real work.
    let held = yield* derive(password, salt, each);
    for (let round = 1; round < rounds; round += 1) {
      held = yield* derive(
        base64urlEncode(held),
        saltOfRound(salt, round),
        each,
      );
    }
    return held;
  });

/** A human password as it is stored: the total count, the one salt, and the chained hash. */
export const hashPassword = (password: string, chosen?: number) =>
  Effect.gen(function* () {
    const iterations = passwordIterationsOf(chosen);
    const salt = randomBytes(SALT_BYTES);
    const hash = yield* deriveRounds(password, salt, iterations);
    return `${CHAINED}$${iterations}$${base64urlEncode(salt)}$${base64urlEncode(hash)}`;
  });

/** Zero when the two strings are equal, and never short of work when they are not. */
const difference = (left: string, right: string) =>
  left.length === right.length
    ? [...left].reduce(
        (accumulated, character, index) =>
          accumulated |
          (character.charCodeAt(0) ^ (right.charCodeAt(index) || 0)),
        0,
      )
    : 1;

/**
 * Does the password match the stored hash? A hash we cannot parse is a mismatch,
 * not an error: a row from another scheme should refuse a login, not break it.
 */
export const verifyPassword = (password: string, stored: string) =>
  Effect.gen(function* () {
    const parts = stored.split('$');
    const [scheme, count, salt, expected] = parts;
    if (
      parts.length !== 4 ||
      (scheme !== CHAINED && scheme !== 'pbkdf2') ||
      salt === undefined ||
      expected === undefined
    ) {
      return false;
    }
    const iterations = Number(count);
    if (!Number.isInteger(iterations) || iterations <= 0) {
      return false;
    }
    // A single-call row from before the rounds, asking for a count this runtime refuses: the
    // parameter is rejected before any work, so the row cannot be checked here and a refused login
    // is the honest answer. Rows at or below the cap are one round, so they go through the same
    // path as a chained one and agree with it exactly.
    if (scheme === 'pbkdf2' && iterations > MAX_ROUND_ITERATIONS) {
      return false;
    }
    const hash = yield* deriveRounds(
      password,
      base64urlDecode(salt),
      iterations,
    );
    return difference(base64urlEncode(hash), expected) === 0;
  });

/**
 * The digest an app password is stored under. Plain, deliberately: the secret
 * is random, so there is nothing to brute-force, and the cheapness is what makes
 * "which of this account's app passwords is this?" a scan rather than a queue.
 */
export const digestSecret = (secret: string) =>
  sha256(encoder.encode(secret)).pipe(Effect.map(base64urlEncode));

/**
 * One character from the shared alphabet. The alphabet is a power of two and
 * the bytes are uniform, so `% length` is a uniform draw — no modulo bias.
 */
const randomCharacter = () => {
  const byte = randomBytes(1).at(0) ?? 0;
  return APP_PASSWORD_ALPHABET.charAt(byte % APP_PASSWORD_ALPHABET.length);
};

const randomGroup = (length: number) =>
  Array.from({ length }, randomCharacter).join('');

/** A fresh app password: `xxxx-xxxx-xxxx-xxxx`. */
export const newAppPassword = () =>
  Array.from({ length: APP_PASSWORD_GROUPS }, () =>
    randomGroup(APP_PASSWORD_GROUP_LENGTH),
  ).join('-');

/** An invite code, in the shape atproto hands out: five groups of five. */
export const newInviteCode = () =>
  Array.from({ length: INVITE_CODE_GROUPS }, () =>
    randomGroup(INVITE_CODE_GROUP_LENGTH),
  ).join('-');

/** An opaque id: a session's, and nothing else's. */
export const randomId = () => base64urlEncode(randomBytes(SESSION_ID_BYTES));

/** Compare a presented secret to a stored digest without leaking where they differ. */
export const sameSecret = (presented: string, digest: string) =>
  digestSecret(presented).pipe(
    Effect.map((one) => difference(one, digest) === 0),
  );
