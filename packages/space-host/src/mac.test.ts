import {
  COMMIT_MAC_TYPE,
  MAC_HEADER,
  MAC_VERSION,
  RECORD_MAC_TYPE,
  WANT_MAC_HEADER,
  computeCommitMac,
  computeRecordMac,
  formatMac,
  formatWantMac,
  parseMac,
  parseWantMac,
  verifyCommitMac,
  verifyRecordMac,
} from './mac.js';
import {
  decapsulate,
  encapsulate,
  generateKemKeyPair,
  kemKeyDidKey,
} from './kem.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { tid } from './fixtures.js';

const run = Effect.runPromise;

const REV = tid('aaaaaaaaaaaaa');
const SPACE = 'at://did:web:space.example/ing.lexicon.space/club';
const REPO = 'did:plc:authorauthorauthorauthor';
const DATA = new Uint8Array(32).fill(3);
const URI = `${SPACE}/${REPO}/ing.lexicon.note/n1`;
const CID = Uint8Array.from([0x01, 0x71, 0x12, 0x20, 9, 9, 9]);

const agree = async () => {
  const keyPair = await run(generateKemKeyPair());
  const kemKey = await run(kemKeyDidKey(keyPair.publicKey));
  const encapsulation = await run(encapsulate(kemKey));
  const decapsulated = await run(
    decapsulate({ keyPair, keyShare: encapsulation.keyShare }),
  );
  return { keyPair, kemKey, encapsulation, decapsulated };
};

describe('the per-request shared secret', () => {
  it('agrees from both sides of one encapsulation', async () => {
    const { encapsulation, decapsulated } = await agree();

    expect(encapsulation.sharedSecret.length).toBe(32);
    expect([...decapsulated]).toEqual([...encapsulation.sharedSecret]);
  });

  it('takes a fresh ephemeral key for every request', async () => {
    const keyPair = await run(generateKemKeyPair());
    const kemKey = await run(kemKeyDidKey(keyPair.publicKey));

    const first = await run(encapsulate(kemKey));
    const second = await run(encapsulate(kemKey));

    expect(first.keyShare).not.toBe(second.keyShare);
    expect([...first.sharedSecret]).not.toEqual([...second.sharedSecret]);
  });

  it('gives a different secret to a different KEM key', async () => {
    const { encapsulation } = await agree();
    const other = await run(generateKemKeyPair());

    const decapsulated = await run(
      decapsulate({ keyPair: other, keyShare: encapsulation.keyShare }),
    );

    expect([...decapsulated]).not.toEqual([...encapsulation.sharedSecret]);
  });

  it('names the key as a P-256 did:key', async () => {
    const { kemKey } = await agree();

    expect(kemKey.startsWith('did:key:zDna')).toBe(true);
  });
});

describe('the commit MAC', () => {
  it('verifies what it signed, and nothing that moved', async () => {
    const { encapsulation } = await agree();
    const sharedSecret = encapsulation.sharedSecret;
    const mac = await run(
      computeCommitMac({
        sharedSecret,
        space: SPACE,
        repo: REPO,
        rev: REV,
        data: DATA,
      }),
    );

    expect(
      await run(
        verifyCommitMac({
          sharedSecret,
          space: SPACE,
          repo: REPO,
          rev: REV,
          data: DATA,
          mac,
        }),
      ),
    ).toBe(true);

    // The revision is in the context, so a MAC cannot move to another commit of the same repo.
    expect(
      await run(
        verifyCommitMac({
          sharedSecret,
          space: SPACE,
          repo: REPO,
          rev: tid('bbbbbbbbbbbbb'),
          data: DATA,
          mac,
        }),
      ),
    ).toBe(false);

    // Nor to another space, nor to another digest.
    expect(
      await run(
        verifyCommitMac({
          sharedSecret,
          space: `${SPACE}-other`,
          repo: REPO,
          rev: REV,
          data: DATA,
          mac,
        }),
      ),
    ).toBe(false);
    expect(
      await run(
        verifyCommitMac({
          sharedSecret,
          space: SPACE,
          repo: REPO,
          rev: REV,
          data: new Uint8Array(32).fill(4),
          mac,
        }),
      ),
    ).toBe(false);
  });

  it('fails under a secret from someone else', async () => {
    const { encapsulation } = await agree();
    const other = await agree();
    const mac = await run(
      computeCommitMac({
        sharedSecret: encapsulation.sharedSecret,
        space: SPACE,
        repo: REPO,
        rev: REV,
        data: DATA,
      }),
    );

    expect(
      await run(
        verifyCommitMac({
          sharedSecret: other.encapsulation.sharedSecret,
          space: SPACE,
          repo: REPO,
          rev: REV,
          data: DATA,
          mac,
        }),
      ),
    ).toBe(false);
  });

  it('does not sign the same bytes as a record MAC', async () => {
    const { encapsulation } = await agree();
    const sharedSecret = encapsulation.sharedSecret;
    const commitMac = await run(
      computeCommitMac({
        sharedSecret,
        space: SPACE,
        repo: REPO,
        rev: REV,
        data: DATA,
      }),
    );
    const recordMac = await run(
      computeRecordMac({ sharedSecret, uri: URI, cid: CID }),
    );

    expect([...commitMac]).not.toEqual([...recordMac]);
  });
});

describe('the record MAC', () => {
  it('binds the URI and the record CID', async () => {
    const { encapsulation } = await agree();
    const sharedSecret = encapsulation.sharedSecret;
    const mac = await run(
      computeRecordMac({ sharedSecret, uri: URI, cid: CID }),
    );

    expect(
      await run(verifyRecordMac({ sharedSecret, uri: URI, cid: CID, mac })),
    ).toBe(true);
    expect(
      await run(
        verifyRecordMac({
          sharedSecret,
          uri: `${SPACE}/${REPO}/ing.lexicon.note/n2`,
          cid: CID,
          mac,
        }),
      ),
    ).toBe(false);
    expect(
      await run(
        verifyRecordMac({
          sharedSecret,
          uri: URI,
          cid: Uint8Array.from([...CID, 0]),
          mac,
        }),
      ),
    ).toBe(false);
  });
});

describe('the MAC headers', () => {
  it('writes and reads the request header', async () => {
    const { kemKey } = await agree();
    const header = formatWantMac({
      type: COMMIT_MAC_TYPE,
      ver: MAC_VERSION,
      keyShare: kemKey,
    });

    expect(header).toBe(
      `type="${COMMIT_MAC_TYPE}", ver=1, key_share="${kemKey}"`,
    );
    expect(await run(parseWantMac(header))).toEqual({
      type: COMMIT_MAC_TYPE,
      ver: MAC_VERSION,
      keyShare: kemKey,
    });
  });

  it('writes and reads the response header', async () => {
    const mac = new Uint8Array(32).fill(7);
    const header = formatMac({ type: RECORD_MAC_TYPE, ver: MAC_VERSION, mac });

    expect(header.startsWith(`type="${RECORD_MAC_TYPE}", ver=1, mac=:`)).toBe(
      true,
    );
    const parsed = await run(parseMac(header));
    expect(parsed.type).toBe(RECORD_MAC_TYPE);
    expect(parsed.ver).toBe(MAC_VERSION);
    expect([...parsed.mac]).toEqual([...mac]);
  });

  it('refuses a header it cannot act on', async () => {
    const request = 'type="atproto-space-repo", ver=1';

    // No key_share, an unsupported version, and a key that is not a did:key.
    await expect(run(parseWantMac(request))).rejects.toMatchObject({
      reason: 'header',
    });
    await expect(
      run(
        parseWantMac(
          'type="atproto-space-repo", ver=2, key_share="did:key:zDna"',
        ),
      ),
    ).rejects.toMatchObject({ reason: 'version' });
    await expect(
      run(parseWantMac('type="atproto-space-repo", ver=1, key_share="nope"')),
    ).rejects.toMatchObject({ reason: 'key' });

    // The MAC must travel as a byte sequence, not as a string.
    await expect(
      run(parseMac('type="atproto-space-repo", ver=1, mac="AAAA"')),
    ).rejects.toMatchObject({ reason: 'header' });
    await expect(
      run(parseMac('type="atproto-space-repo", ver=1, mac=:AAAA:, mac=:AAAA:')),
    ).rejects.toMatchObject({ reason: 'header' });
    await expect(run(parseMac(''))).rejects.toMatchObject({
      reason: 'header',
    });
  });

  it('names the headers the spec names', () => {
    expect(WANT_MAC_HEADER).toBe('Atproto-Space-Want-Mac');
    expect(MAC_HEADER).toBe('Atproto-Space-Mac');
  });
});
