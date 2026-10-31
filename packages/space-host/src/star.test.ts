import { AUTHORITY, SPACE, tid } from './fixtures.js';
import { type Cid, encodeCbor } from '@eoa/core';
import {
  SPACE_COMMIT_VER,
  SPACE_META_STAR,
  SPACE_META_VER,
  SPACE_REPO_STAR,
  STAR_MAGIC,
  type SpaceMetaArchive,
  type SpaceRepoArchive,
  blockCidOf,
  digestOf,
  encodeRepoStar,
  encodeSpaceMetaStar,
  parseRepoStar,
  parseSpaceMetaStar,
  starProfileOf,
  verifyRepoStar,
} from './star.js';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

const run = Effect.runPromise;
const REV = tid('aaaaaaaaaaaaa');

const NOTE_1 = {
  path: 'ing.lexicon.note/n1',
  block: encodeCbor({ text: 'one' }),
} as const;
const NOTE_2 = {
  path: 'ing.lexicon.note/n2',
  block: encodeCbor({ text: 'two' }),
} as const;
const records: SpaceRepoArchive['records'] = [NOTE_1, NOTE_2];

const build = (overrides: { readonly data?: Uint8Array } = {}) =>
  Effect.gen(function* () {
    const cids: Record<string, Cid> = {};
    for (const record of records) {
      cids[record.path] = yield* blockCidOf(record.block);
    }
    const data = overrides.data ?? (yield* digestOf(cids));
    return {
      meta: {
        $type: SPACE_REPO_STAR,
        ver: SPACE_COMMIT_VER,
        repo: AUTHORITY,
        space: SPACE,
        rev: REV,
        data,
      },
      records,
    } satisfies SpaceRepoArchive;
  });

// The test frames its own bytes where the encoder would refuse: strict key order is a reader's rule,
// and a reader is what is under test.
const varint = (value: number): Uint8Array => {
  const out: Array<number> = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Uint8Array.from(out);
};

const frame = (path: string, block: Uint8Array): Uint8Array => {
  const key = new TextEncoder().encode(path);
  return Uint8Array.from([
    ...varint(key.length),
    ...key,
    ...varint(block.length),
    ...block,
  ]);
};

const archiveOf = async (pairs: ReadonlyArray<[string, Uint8Array]>) => {
  const meta = (await run(build())).meta;
  const header = encodeCbor(meta);
  return Uint8Array.from([
    ...STAR_MAGIC,
    ...varint(header.length),
    ...header,
    ...pairs.flatMap(([path, block]) => [...frame(path, block)]),
  ]);
};

describe('the space repo STAR archive', () => {
  it('round-trips and verifies', async () => {
    const archive = await run(build());
    const bytes = await run(encodeRepoStar(archive));

    const parsed = await run(parseRepoStar(bytes));
    expect(parsed.meta).toEqual(archive.meta);
    expect(parsed.records.map((one) => one.path)).toEqual([
      'ing.lexicon.note/n1',
      'ing.lexicon.note/n2',
    ]);

    const verified = await run(verifyRepoStar(bytes));
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(Object.keys(verified.index).sort()).toEqual(
        records.map((one) => one.path).sort(),
      );
    }
  });

  it('sorts the pairs it is given, because the profile requires it', async () => {
    const archive = await run(build());
    const bytes = await run(
      encodeRepoStar({ ...archive, records: [...records].reverse() }),
    );

    const parsed = await run(parseRepoStar(bytes));
    expect(parsed.records.map((one) => one.path)).toEqual([
      'ing.lexicon.note/n1',
      'ing.lexicon.note/n2',
    ]);
  });

  it('rejects a record that was replaced under the same revision', async () => {
    const archive = await run(build());
    const bytes = await run(encodeRepoStar(archive));
    const tampered = Uint8Array.from(bytes);
    // A byte inside the last value: the framing still parses, the digest no longer matches.
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;

    expect(await run(verifyRepoStar(tampered))).toEqual({
      valid: false,
      reason: 'digest-mismatch',
    });
  });

  it('rejects a digest from another archive', async () => {
    const stale = await run(
      digestOf({
        'ing.lexicon.note/n9': await run(
          blockCidOf(encodeCbor({ text: 'nine' })),
        ),
      }),
    );
    const bytes = await run(encodeRepoStar(await run(build({ data: stale }))));

    expect(await run(verifyRepoStar(bytes))).toEqual({
      valid: false,
      reason: 'digest-mismatch',
    });
  });

  it('rejects pairs out of order, which a conforming archive never has', async () => {
    const bytes = await archiveOf([
      [NOTE_2.path, NOTE_2.block],
      [NOTE_1.path, NOTE_1.block],
    ]);

    expect(await run(verifyRepoStar(bytes))).toEqual({
      valid: false,
      reason: 'order',
    });
  });

  it('rejects a duplicate key', async () => {
    const bytes = await archiveOf([
      [NOTE_1.path, NOTE_1.block],
      [NOTE_1.path, NOTE_2.block],
    ]);

    expect(await run(verifyRepoStar(bytes))).toEqual({
      valid: false,
      reason: 'order',
    });
  });

  it('rejects a file that is not a STAR archive at all', async () => {
    // A CAR begins with a varint length, not with the magic.
    const notStar = encodeCbor({ version: 1, roots: [] });

    expect(await run(verifyRepoStar(notStar))).toEqual({
      valid: false,
      reason: 'magic',
    });
  });

  it('rejects an archive truncated at a pair boundary', async () => {
    const bytes = await run(encodeRepoStar(await run(build())));
    const truncated = bytes.slice(0, bytes.length - 3);

    expect(await run(verifyRepoStar(truncated))).toEqual({
      valid: false,
      reason: 'truncated',
    });
  });

  it('refuses to encode a record over the profile ceiling', async () => {
    const archive = await run(build());
    const huge = {
      path: 'ing.lexicon.note/big',
      block: new Uint8Array(1024 * 1024 + 1),
    };

    await expect(
      run(encodeRepoStar({ ...archive, records: [huge] })),
    ).rejects.toMatchObject({ reason: 'size' });
  });

  it('refuses to encode the same path twice', async () => {
    const archive = await run(build());
    const twice = [NOTE_1, NOTE_1];

    await expect(
      run(encodeRepoStar({ ...archive, records: twice })),
    ).rejects.toMatchObject({ reason: 'order' });
  });
});

// ---------------------------------------------------------------------------
// The migration profile: a space's host-side state, which is the half of a spaces account that does
// not ride the public repo (2026-10-29).
// ---------------------------------------------------------------------------

const WRITER = {
  did: AUTHORITY,
  rev: tid('bbbbbbbbbbbbb'),
  data: new Uint8Array(32).fill(7),
  spaceRev: tid('ccccccccccccc'),
};

const MEMBER_KEY = 'com.atproto.memberspace.member/did:plc:alice';

const metaArchive: SpaceMetaArchive = {
  meta: { $type: SPACE_META_STAR, ver: SPACE_META_VER, space: SPACE },
  policy: {
    $type: 'com.atproto.memberspace.policy',
    publicRead: false,
    publicWrite: false,
    publishPolicy: false,
    publishMembers: true,
  },
  policyState: [
    {
      key: MEMBER_KEY,
      value: {
        $type: 'com.atproto.memberspace.member',
        read: true,
        write: false,
      },
    },
  ],
  writers: [WRITER],
};

/** A meta archive framed from hand-picked pairs, so a broken section order can be built at all. */
const metaBytesOf = (pairs: ReadonlyArray<[string, Uint8Array]>) => {
  const header = encodeCbor({
    $type: metaArchive.meta.$type,
    ver: metaArchive.meta.ver,
    space: metaArchive.meta.space,
  });
  return Uint8Array.from([
    ...STAR_MAGIC,
    ...varint(header.length),
    ...header,
    ...pairs.flatMap(([path, block]) => [...frame(path, block)]),
  ]);
};

const memberBytes = () => encodeCbor(metaArchive.policyState[0]?.value ?? {});
const policyBytes = () => encodeCbor(metaArchive.policy);
const writerBytes = () =>
  encodeCbor({
    rev: WRITER.rev,
    data: WRITER.data,
    spaceRev: WRITER.spaceRev,
  });

describe('the space meta STAR archive (account migration)', () => {
  it('round-trips: the policy, the state it keeps, and the writer set', async () => {
    const bytes = await run(encodeSpaceMetaStar(metaArchive));

    const parsed = await run(parseSpaceMetaStar(bytes));
    expect(parsed).toEqual(metaArchive);
    // The three sections, in the order the profile names them.
    expect(parsed.meta.space).toBe(SPACE);
    expect(parsed.policy['$type']).toBe('com.atproto.memberspace.policy');
    expect(parsed.policyState.map((entry) => entry.key)).toEqual([MEMBER_KEY]);
    expect(parsed.writers).toEqual([WRITER]);
  });

  it('says which profile an archive is, and a meta archive is not a repo', async () => {
    const repoBytes = await run(encodeRepoStar(await run(build())));
    const metaBytes = await run(encodeSpaceMetaStar(metaArchive));

    expect(await run(starProfileOf(repoBytes))).toBe(SPACE_REPO_STAR);
    expect(await run(starProfileOf(metaBytes))).toBe(SPACE_META_STAR);

    // A reader that assumes the 22.10 profile refuses rather than reading a meta archive as a repo
    // with odd record paths: the two carry different things and only the `$type` tells them apart.
    expect(await run(verifyRepoStar(metaBytes))).toEqual({
      valid: false,
      reason: 'meta',
    });
    expect(
      await run(parseRepoStar(metaBytes).pipe(Effect.result)),
    ).toMatchObject({
      _tag: 'Failure',
    });
  });

  it('reports no profile for an unknown archive type, and errors on a non-STAR file', async () => {
    // A metadata `$type` from a later release: nothing here can say what it means, so it is
    // reported as unknown rather than guessed.
    const header = encodeCbor({ $type: 'com.example.other', ver: 1 });
    const unknown = Uint8Array.from([
      ...STAR_MAGIC,
      ...varint(header.length),
      ...header,
    ]);
    expect(await run(starProfileOf(unknown))).toBe(undefined);

    // Not STAR at all: the framing fails before there is a `$type` to read, which is an error.
    await expect(
      run(starProfileOf(encodeCbor({ version: 1 }))),
    ).rejects.toMatchObject({ reason: 'magic' });
  });

  it('refuses sections out of order, and an archive with no policy', async () => {
    const outOfOrder = metaBytesOf([
      [`writer/${WRITER.did}`, writerBytes()],
      ['policy', policyBytes()],
    ]);
    await expect(run(parseSpaceMetaStar(outOfOrder))).rejects.toMatchObject({
      reason: 'section',
    });

    const noPolicy = metaBytesOf([
      [MEMBER_KEY, memberBytes()],
      [`writer/${WRITER.did}`, writerBytes()],
    ]);
    await expect(run(parseSpaceMetaStar(noPolicy))).rejects.toMatchObject({
      reason: 'section',
    });
  });

  it('refuses a writer entry that is not one', async () => {
    const badWriter = metaBytesOf([
      ['policy', policyBytes()],
      ['writer/not-a-did', writerBytes()],
    ]);
    await expect(run(parseSpaceMetaStar(badWriter))).rejects.toMatchObject({
      reason: 'writer',
    });

    const noDigest = metaBytesOf([
      ['policy', policyBytes()],
      [
        `writer/${WRITER.did}`,
        encodeCbor({ rev: WRITER.rev, spaceRev: WRITER.spaceRev }),
      ],
    ]);
    await expect(run(parseSpaceMetaStar(noDigest))).rejects.toMatchObject({
      reason: 'writer',
    });
  });

  it('puts each section into key order, whatever order it was handed', async () => {
    const reversed = {
      ...metaArchive,
      policyState: [
        { key: `${MEMBER_KEY}2`, value: { read: false, write: false } },
        { key: MEMBER_KEY, value: metaArchive.policyState[0]?.value ?? {} },
      ],
    } satisfies SpaceMetaArchive;

    const parsed = await run(
      parseSpaceMetaStar(await run(encodeSpaceMetaStar(reversed))),
    );
    expect(parsed.policyState.map((entry) => entry.key)).toEqual([
      MEMBER_KEY,
      `${MEMBER_KEY}2`,
    ]);
  });

  it('refuses a policy-state key that names a section of its own', async () => {
    await expect(
      run(
        encodeSpaceMetaStar({
          ...metaArchive,
          policyState: [{ key: 'writer/did:plc:alice', value: { read: true } }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'section' });
  });
});
