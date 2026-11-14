import { type CborValue, TID, encodeCbor } from '@eoa/core';
import { Effect, Schema, Stream } from 'effect';
import {
  SPACE_COMMIT_VER,
  SPACE_META_STAR,
  SPACE_META_VER,
  SPACE_REPO_STAR,
  type SpaceMetaValue,
  type SpaceMetaWriter,
  blockCidOf,
  digestOf,
  encodeRepoStar,
  encodeSpaceMetaStar,
  jktOfKey,
  ltHashDigestOf,
  parseSpaceMetaStar,
  signAppProof,
  verifyRepoStar,
} from '@eoa/space-host';
import { SpaceStore, spaceStoreLayer } from './space-store.js';
import { describe, expect, it } from 'vitest';
import { type AddressInfo } from 'node:net';
import { DefaultIdentityResolver } from '@eoa/identity';
import { type Firehose } from './firehose.js';
import { Kv } from '@eoa/kv';
import { createPdsServer } from './server.js';
import { createServer } from 'node:http';
import { encodeTid } from '@eoa/repo-store';
import { generateES256KeyPair } from '@eoa/crypto';
import { startMemoryPds } from './memory.js';
import { validateSpaceMeta } from './space.js';

const SPACE_TYPE = 'com.example.space';

const tid = (n: number) =>
  encodeTid({ micros: 1_700_000_000_000 + n, clockId: 0 });

interface Account {
  readonly did: string;
  readonly accessJwt: string;
}

const createAccount = async (url: string, handle: string): Promise<Account> => {
  const response = await fetch(`${url}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, password: 'correct horse battery staple' }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const body = (await response.json()) as Record<string, string>;
  return { did: body['did'] ?? '', accessJwt: body['accessJwt'] ?? '' };
};

const postRaw = async (url: string, body: Uint8Array, token: string) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
    },
    body: Buffer.from(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, string>,
  };
};

const getJson = async (url: string, token: string) => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

const postJson = async (
  url: string,
  token: string,
  body: Record<string, Schema.Json>,
) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, Schema.Json>,
  };
};

interface RecordInput {
  readonly path: string;
  readonly value: CborValue;
}

const repoArchive = async (params: {
  readonly repo: string;
  readonly space: string;
  readonly rev: string;
  readonly records: ReadonlyArray<RecordInput>;
}) => {
  const records = params.records.map((record) => ({
    path: record.path,
    block: encodeCbor(record.value),
  }));
  const entries = await Promise.all(
    records.map(async (record) => {
      const cid = await Effect.runPromise(blockCidOf(record.block));
      return [record.path, cid] as const;
    }),
  );
  const data = await Effect.runPromise(digestOf(Object.fromEntries(entries)));
  const bytes = await Effect.runPromise(
    encodeRepoStar({
      meta: {
        $type: SPACE_REPO_STAR,
        ver: SPACE_COMMIT_VER,
        repo: params.repo,
        space: params.space,
        rev: Schema.decodeSync(TID)(params.rev),
        data,
      },
      records,
    }),
  );
  return { bytes, data };
};

const memberState = (did: string, read = true): [string, SpaceMetaValue] => [
  `com.atproto.memberspace.member/${did}`,
  {
    $type: 'com.atproto.memberspace.member',
    read,
    write: false,
  },
];

const metaArchive = async (params: {
  readonly space: string;
  readonly policy: SpaceMetaValue;
  readonly state?: ReadonlyArray<[string, SpaceMetaValue]> | undefined;
  readonly writers?: ReadonlyArray<SpaceMetaWriter> | undefined;
}) => {
  const bytes = await Effect.runPromise(
    encodeSpaceMetaStar({
      meta: {
        $type: SPACE_META_STAR,
        ver: SPACE_META_VER,
        space: params.space,
      },
      policy: params.policy,
      policyState: (params.state ?? []).map(([key, value]) => ({
        key,
        value,
      })),
      writers: params.writers ?? [],
    }),
  );
  return bytes;
};

const MEMBER_POLICY: SpaceMetaValue = {
  $type: 'com.atproto.memberspace.policy',
  publicRead: false,
  publishMembers: true,
};

describe('the spaces surface', () => {
  it('carries a space and a repo, serves them back, and replaces on re-import', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const account = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const space = `at://${account.did}/${SPACE_TYPE}/club`;
          const first = yield* Effect.promise(() =>
            repoArchive({
              repo: account.did,
              space,
              rev: tid(1),
              records: [
                {
                  path: 'com.example.note/one',
                  value: { $type: 'com.example.note', text: 'one' },
                },
              ],
            }),
          );

          // A repo cannot precede the space it is the authority of.
          const early = yield* Effect.promise(() =>
            postRaw(
              `${pds.url}/xrpc/com.atproto.space.importRepo`,
              first.bytes,
              account.accessJwt,
            ),
          );
          expect(early.body['error']).toBe('SpaceNotFound');

          const meta = yield* Effect.promise(() =>
            metaArchive({
              space,
              policy: MEMBER_POLICY,
              state: [memberState(account.did)],
              writers: [
                {
                  did: account.did,
                  rev: tid(1),
                  data: first.data,
                  spaceRev: tid(1),
                },
              ],
            }),
          );
          const importedMeta = yield* Effect.promise(() =>
            postRaw(
              `${pds.url}/xrpc/com.atproto.space.importSpaceMeta`,
              meta,
              account.accessJwt,
            ),
          );
          expect(importedMeta.status).toBe(200);

          const imported = yield* Effect.promise(() =>
            postRaw(
              `${pds.url}/xrpc/com.atproto.space.importRepo`,
              first.bytes,
              account.accessJwt,
            ),
          );
          expect(imported.status).toBe(200);

          // The export is the archive this host holds, byte for byte.
          const exported = yield* Effect.promise(async () => {
            const response = await fetch(
              `${pds.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(space)}`,
              { headers: { authorization: `Bearer ${account.accessJwt}` } },
            );
            return {
              status: response.status,
              bytes: new Uint8Array(await response.arrayBuffer()),
            };
          });
          expect(exported.status).toBe(200);
          expect(exported.bytes).toEqual(meta);

          const described = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getSpace?space=${encodeURIComponent(space)}`,
              account.accessJwt,
            ),
          );
          expect(described.body['policy']).toMatchObject({
            $type: 'com.atproto.memberspace.policy',
          });

          const listed = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listSpaces`,
              account.accessJwt,
            ),
          );
          expect(listed.body['spaces']).toEqual([{ uri: space }]);

          const records = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${encodeURIComponent(account.did)}`,
              account.accessJwt,
            ),
          );
          expect(records.body['records']).toHaveLength(1);
          expect(records.body['records']).toMatchObject([
            {
              collection: 'com.example.note',
              rkey: 'one',
              value: { $type: 'com.example.note', text: 'one' },
            },
          ]);

          // What the archive implies is what the repo answers: its records fold
          // to the commit's `data`, with a revision this host chose.
          const downloaded = yield* Effect.promise(async () => {
            const response = await fetch(
              `${pds.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(space)}&repo=${encodeURIComponent(account.did)}`,
              { headers: { authorization: `Bearer ${account.accessJwt}` } },
            );
            return {
              status: response.status,
              bytes: new Uint8Array(await response.arrayBuffer()),
            };
          });
          expect(downloaded.status).toBe(200);
          const verified = yield* Effect.promise(() =>
            Effect.runPromise(verifyRepoStar(downloaded.bytes)),
          );
          expect(verified.valid).toBe(true);
          expect(
            verified.valid ? Buffer.from(verified.meta.data) : undefined,
          ).toEqual(Buffer.from(first.data));

          const latest = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getLatestCommit?space=${encodeURIComponent(space)}&repo=${encodeURIComponent(account.did)}`,
              account.accessJwt,
            ),
          );
          const commit = latest.body['commit'] as {
            data: { $bytes: string };
            rev: string;
          };
          expect(Buffer.from(commit.data.$bytes, 'base64')).toEqual(
            Buffer.from(first.data),
          );
          expect(commit.rev).not.toBe(tid(1));

          // A second import replaces rather than appends.
          const second = yield* Effect.promise(() =>
            repoArchive({
              repo: account.did,
              space,
              rev: tid(2),
              records: [
                {
                  path: 'com.example.note/two',
                  value: { $type: 'com.example.note', text: 'two' },
                },
              ],
            }),
          );
          const replaced = yield* Effect.promise(() =>
            postRaw(
              `${pds.url}/xrpc/com.atproto.space.importRepo`,
              second.bytes,
              account.accessJwt,
            ),
          );
          expect(replaced.status).toBe(200);
          const after = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${encodeURIComponent(account.did)}`,
              account.accessJwt,
            ),
          );
          expect(after.body['records']).toHaveLength(1);
          expect(after.body['records']).toMatchObject([
            { rkey: 'two', value: { text: 'two' } },
          ]);
          const gone = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${encodeURIComponent(account.did)}&collection=com.example.note&rkey=one`,
              account.accessJwt,
            ),
          );
          expect(gone.body['error']).toBe('RecordNotFound');
        }),
      ),
    );
  });
});

/** The STAR framing, written by hand so a broken archive can be framed. */
const MAGIC = Uint8Array.from([0x2a, 0x6c, 0x01, 0x00]);

const utf8 = (value: string) => new TextEncoder().encode(value);

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// Every key and value here is far under 128 bytes, so a varint is one byte.
const frame = (key: string, value: Uint8Array) => {
  const keyBytes = utf8(key);
  return concat(
    Uint8Array.of(keyBytes.length),
    keyBytes,
    Uint8Array.of(value.length),
    value,
  );
};

const starBytes = (
  header: CborValue,
  pairs: ReadonlyArray<[string, Uint8Array]>,
) => {
  const encoded = encodeCbor(header);
  return concat(
    MAGIC,
    Uint8Array.of(encoded.length),
    encoded,
    ...pairs.map(([key, value]) => frame(key, value)),
  );
};

const reader = {
  space: 'at://did:web:pds.test:alice/com.example.space/club',
  caller: 'did:web:pds.test:alice',
};

describe('space meta import validation', () => {
  it('refuses a space anchored on another account', async () => {
    const bytes = await metaArchive({
      space: reader.space,
      policy: MEMBER_POLICY,
    });
    const failure = await Effect.runPromise(
      Effect.flip(
        validateSpaceMeta({ bytes, callerDid: 'did:web:pds.test:bob' }),
      ),
    );
    expect(failure.error).toBe('NotSpaceOwner');
  });

  it('refuses a policy the host does not implement', async () => {
    const bytes = await metaArchive({
      space: reader.space,
      policy: { $type: 'com.example.policy' },
    });
    const failure = await Effect.runPromise(
      Effect.flip(validateSpaceMeta({ bytes, callerDid: reader.caller })),
    );
    expect(failure.error).toBe('UnsupportedPolicy');
  });

  it('refuses policy state the policy does not define', async () => {
    const bytes = await metaArchive({
      space: reader.space,
      policy: MEMBER_POLICY,
      state: [['com.example.other/one', { read: true }]],
    });
    const failure = await Effect.runPromise(
      Effect.flip(validateSpaceMeta({ bytes, callerDid: reader.caller })),
    );
    expect(failure.error).toBe('InvalidRequest');
  });

  it('refuses state on a policy that keeps none', async () => {
    const bytes = await metaArchive({
      space: reader.space,
      policy: { $type: 'com.atproto.personalspace.policy' },
      state: [memberState(reader.caller)],
    });
    const failure = await Effect.runPromise(
      Effect.flip(validateSpaceMeta({ bytes, callerDid: reader.caller })),
    );
    expect(failure.error).toBe('InvalidRequest');
  });

  it('refuses an archive with no policy', async () => {
    const bytes = starBytes(
      {
        $type: SPACE_META_STAR,
        ver: SPACE_META_VER,
        space: reader.space,
      },
      [
        [
          `com.atproto.memberspace.member/${reader.caller}`,
          encodeCbor({ read: true, write: false }),
        ],
      ],
    );
    const failure = await Effect.runPromise(
      Effect.flip(validateSpaceMeta({ bytes, callerDid: reader.caller })),
    );
    expect(failure.error).toBe('InvalidRequest');
  });

  it('refuses a section out of order', async () => {
    const bytes = starBytes(
      {
        $type: SPACE_META_STAR,
        ver: SPACE_META_VER,
        space: reader.space,
      },
      [
        [
          `writer/${reader.caller}`,
          encodeCbor({
            rev: tid(1),
            data: new Uint8Array(32),
            spaceRev: tid(1),
          }),
        ],
        ['policy', encodeCbor(MEMBER_POLICY)],
      ],
    );
    const failure = await Effect.runPromise(
      Effect.flip(validateSpaceMeta({ bytes, callerDid: reader.caller })),
    );
    expect(failure.error).toBe('InvalidRequest');
  });

  it('refuses a duplicate key', async () => {
    const bytes = starBytes(
      {
        $type: SPACE_META_STAR,
        ver: SPACE_META_VER,
        space: reader.space,
      },
      [
        ['policy', encodeCbor(MEMBER_POLICY)],
        ['policy', encodeCbor(MEMBER_POLICY)],
      ],
    );
    const failure = await Effect.runPromise(
      Effect.flip(validateSpaceMeta({ bytes, callerDid: reader.caller })),
    );
    expect(failure.error).toBe('InvalidRequest');
  });
});

describe('creating and deleting a space', () => {
  const postJson = async (
    url: string,
    token: string,
    body: Record<string, unknown>,
  ) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };

  it('creates a space the owner can name, and takes it back', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const alice = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );

          const created = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createSpace`,
              alice.accessJwt,
              {
                spaceType: SPACE_TYPE,
                // No key: the host names it, which is what makes `createSpace` usable without the
                // caller inventing one.
                policy: {
                  $type: 'com.atproto.memberspace.policy',
                  publicRead: true,
                },
              },
            ),
          );
          expect(created.status).toBe(200);
          const uri = String(created.body['uri']);
          expect(uri.startsWith(`at://${alice.did}/${SPACE_TYPE}/`)).toBe(true);
          // The generated key is a TID: 13 characters from the base32-sortable alphabet.
          expect(uri.split('/').at(-1)).toMatch(
            /^[234567abcdefghij][0-9a-z]{12}$/u,
          );

          const described = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getSpace?space=${encodeURIComponent(uri)}`,
              alice.accessJwt,
            ),
          );
          expect(described.status).toBe(200);
          expect(described.body['uri']).toBe(uri);
          expect(described.body['policy']).toEqual({
            $type: 'com.atproto.memberspace.policy',
            publicRead: true,
          });

          const listed = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listSpaces?did=${encodeURIComponent(alice.did)}`,
              alice.accessJwt,
            ),
          );
          const spaces = listed.body['spaces'] as ReadonlyArray<{
            uri: string;
          }>;
          expect(spaces.map((one) => one.uri)).toContain(uri);

          const deleted = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.deleteSpace`,
              alice.accessJwt,
              { space: uri },
            ),
          );
          expect(deleted.status).toBe(200);

          // A deleted space is gone: it is not described and it is not listed.
          const after = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getSpace?space=${encodeURIComponent(uri)}`,
              alice.accessJwt,
            ),
          );
          expect(after.body['error']).toBe('SpaceNotFound');
          const listedAgain = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listSpaces?did=${encodeURIComponent(alice.did)}`,
              alice.accessJwt,
            ),
          );
          expect(listedAgain.body['spaces']).toEqual([]);
        }),
      ),
    );
  });

  it('refuses a taken key, a foreign policy, and a delete by somebody else', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const alice = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const bob = yield* Effect.promise(() =>
            createAccount(pds.url, 'bob.pds.test'),
          );
          const space = `at://${alice.did}/${SPACE_TYPE}/club`;

          const first = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createSpace`,
              alice.accessJwt,
              {
                spaceType: SPACE_TYPE,
                skey: 'club',
                policy: { $type: 'com.atproto.personalspace.policy' },
              },
            ),
          );
          expect(first.status).toBe(200);
          expect(first.body['uri']).toBe(space);

          const again = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createSpace`,
              alice.accessJwt,
              {
                spaceType: SPACE_TYPE,
                skey: 'club',
                policy: { $type: 'com.atproto.personalspace.policy' },
              },
            ),
          );
          expect(again.body['error']).toBe('SpaceAlreadyExists');

          // A policy this host has no answer for is refused rather than stored and misread later.
          const foreign = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createSpace`,
              alice.accessJwt,
              {
                spaceType: SPACE_TYPE,
                skey: 'other',
                policy: { $type: 'com.example.somebody.elses.policy' },
              },
            ),
          );
          expect(foreign.body['error']).toBe('UnsupportedPolicy');

          const intruder = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.deleteSpace`,
              bob.accessJwt,
              { space },
            ),
          );
          expect(intruder.body['error']).toBe('NotSpaceOwner');

          // The owner's space survived all three refusals.
          const described = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getSpace?space=${encodeURIComponent(space)}`,
              alice.accessJwt,
            ),
          );
          expect(described.status).toBe(200);
        }),
      ),
    );
  });
});

describe('writing into a space', () => {
  const createPersonalSpace = async (
    url: string,
    token: string,
    did: string,
    skey: string,
  ) => {
    const created = await postJson(
      `${url}/xrpc/com.atproto.space.createSpace`,
      token,
      {
        spaceType: SPACE_TYPE,
        skey,
        policy: { $type: 'com.atproto.personalspace.policy' },
      },
    );
    expect(created.status).toBe(200);
    return `at://${did}/${SPACE_TYPE}/${skey}`;
  };

  const spaceQuery = (space: string, repo: string) =>
    `space=${encodeURIComponent(space)}&repo=${encodeURIComponent(repo)}`;

  it('the authority writes a record and reads it back through every read', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const alice = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const space = yield* Effect.promise(() =>
            createPersonalSpace(pds.url, alice.accessJwt, alice.did, 'notes'),
          );
          const created = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createRecord`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
                collection: 'com.example.note',
                rkey: 'one',
                record: { $type: 'com.example.note', text: 'one' },
              },
            ),
          );
          expect(created.status).toBe(200);
          expect(created.body['uri']).toBe(
            `at://${alice.did}/com.example.note/one`,
          );
          expect(typeof created.body['cid']).toBe('string');

          const listed = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listRecords?${spaceQuery(space, alice.did)}`,
              alice.accessJwt,
            ),
          );
          expect(listed.body['records']).toMatchObject([
            {
              collection: 'com.example.note',
              rkey: 'one',
              value: { $type: 'com.example.note', text: 'one' },
            },
          ]);

          const one = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getRecord?${spaceQuery(space, alice.did)}&collection=com.example.note&rkey=one`,
              alice.accessJwt,
            ),
          );
          expect(one.body['value']).toEqual({
            $type: 'com.example.note',
            text: 'one',
          });

          const downloaded = yield* Effect.promise(async () => {
            const response = await fetch(
              `${pds.url}/xrpc/com.atproto.space.getRepo?${spaceQuery(space, alice.did)}`,
              { headers: { authorization: `Bearer ${alice.accessJwt}` } },
            );
            return {
              status: response.status,
              bytes: new Uint8Array(await response.arrayBuffer()),
            };
          });
          expect(downloaded.status).toBe(200);
          const verified = yield* Effect.promise(() =>
            Effect.runPromise(verifyRepoStar(downloaded.bytes)),
          );
          expect(verified.valid).toBe(true);
          expect(verified.valid ? verified.index : undefined).toHaveProperty([
            'com.example.note/one',
          ]);

          // A delete is a no-op the second time and frees the key for a create.
          const deleted = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.deleteRecord`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
                collection: 'com.example.note',
                rkey: 'one',
              },
            ),
          );
          expect(deleted.status).toBe(200);
          const gone = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getRecord?${spaceQuery(space, alice.did)}&collection=com.example.note&rkey=one`,
              alice.accessJwt,
            ),
          );
          expect(gone.body['error']).toBe('RecordNotFound');
          const again = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createRecord`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
                collection: 'com.example.note',
                rkey: 'one',
                record: { $type: 'com.example.note', text: 'again' },
              },
            ),
          );
          expect(again.status).toBe(200);
        }),
      ),
    );
  });

  it('a member with write: false is refused and the log is untouched', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const alice = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const bob = yield* Effect.promise(() =>
            createAccount(pds.url, 'bob.pds.test'),
          );
          const space = `at://${alice.did}/${SPACE_TYPE}/club`;
          const meta = yield* Effect.promise(() =>
            metaArchive({
              space,
              policy: MEMBER_POLICY,
              state: [memberState(bob.did)],
            }),
          );
          const imported = yield* Effect.promise(() =>
            postRaw(
              `${pds.url}/xrpc/com.atproto.space.importSpaceMeta`,
              meta,
              alice.accessJwt,
            ),
          );
          expect(imported.status).toBe(200);

          const refused = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createRecord`,
              bob.accessJwt,
              {
                space,
                repo: bob.did,
                collection: 'com.example.note',
                rkey: 'one',
                record: { $type: 'com.example.note', text: 'nope' },
              },
            ),
          );
          expect(refused.status).toBe(403);
          expect(String(refused.body['message'])).toContain(
            'member-has-no-write',
          );

          // No repo was made for Bob: the refusal happened before the log.
          const bobHead = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getLatestCommit?${spaceQuery(space, bob.did)}`,
              bob.accessJwt,
            ),
          );
          expect(bobHead.body['error']).toBe('RepoNotFound');
        }),
      ),
    );
  });

  it('a managedspace refuses writes when the host has no identity resolver to ask', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const alice = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const bob = yield* Effect.promise(() =>
            createAccount(pds.url, 'bob.pds.test'),
          );
          const space = `at://${alice.did}/${SPACE_TYPE}/forum`;
          const meta = yield* Effect.promise(() =>
            metaArchive({
              space,
              policy: {
                $type: 'com.atproto.managedspace.policy',
                managingApp: 'did:web:forum.example#forum',
              },
            }),
          );
          yield* Effect.promise(() =>
            postRaw(
              `${pds.url}/xrpc/com.atproto.space.importSpaceMeta`,
              meta,
              alice.accessJwt,
            ),
          );

          const refused = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createRecord`,
              bob.accessJwt,
              {
                space,
                repo: bob.did,
                collection: 'com.example.note',
                rkey: 'one',
                record: { $type: 'com.example.note', text: 'nope' },
              },
            ),
          );
          expect(refused.status).toBe(403);
          expect(String(refused.body['message'])).toContain('managing app');
          expect(String(refused.body['message'])).toContain(
            'no identity resolver',
          );

          // A read is the same answer: with no resolver there is nobody to ask, so the grant gate
          // decides and the 403 says the managing app would have.
          const written = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createRecord`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
                collection: 'com.example.note',
                rkey: 'one',
                record: { $type: 'com.example.note', text: 'one' },
              },
            ),
          );
          expect(written.status).toBe(200);
          const read = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listRecords?${spaceQuery(space, alice.did)}`,
              bob.accessJwt,
            ),
          );
          expect(read.status).toBe(403);
          expect(String(read.body['message'])).toContain('decides reads');
        }),
      ),
    );
  });

  it('applyWrites commits the whole batch or nothing', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const alice = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const space = yield* Effect.promise(() =>
            createPersonalSpace(pds.url, alice.accessJwt, alice.did, 'batch'),
          );
          const refused = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.applyWrites`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
                writes: [
                  {
                    $type: 'com.atproto.space.applyWrites#create',
                    collection: 'com.example.note',
                    rkey: 'same',
                    value: { $type: 'com.example.note', text: 'first' },
                  },
                  {
                    $type: 'com.atproto.space.applyWrites#create',
                    collection: 'com.example.note',
                    rkey: 'same',
                    value: { $type: 'com.example.note', text: 'second' },
                  },
                ],
              },
            ),
          );
          expect(refused.body['error']).toBe('RecordAlreadyExists');

          const empty = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listRecords?${spaceQuery(space, alice.did)}`,
              alice.accessJwt,
            ),
          );
          // Neither write landed, not even the valid first one.
          expect(empty.body['error']).toBe('RepoNotFound');

          const committed = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.applyWrites`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
                writes: [
                  {
                    $type: 'com.atproto.space.applyWrites#create',
                    collection: 'com.example.note',
                    rkey: 'a',
                    value: { $type: 'com.example.note', text: 'a' },
                  },
                  {
                    $type: 'com.atproto.space.applyWrites#create',
                    collection: 'com.example.note',
                    rkey: 'b',
                    value: { $type: 'com.example.note', text: 'b' },
                  },
                ],
              },
            ),
          );
          expect(committed.status).toBe(200);
          expect(committed.body['results']).toHaveLength(2);
          const listed = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listRecords?${spaceQuery(space, alice.did)}`,
              alice.accessJwt,
            ),
          );
          expect(listed.body['records']).toHaveLength(2);
        }),
      ),
    );
  });

  it('clearRecords leaves an empty repo at a new rev, and the next write is a create', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const alice = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const space = yield* Effect.promise(() =>
            createPersonalSpace(pds.url, alice.accessJwt, alice.did, 'clear'),
          );
          yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createRecord`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
                collection: 'com.example.note',
                rkey: 'one',
                record: { $type: 'com.example.note', text: 'one' },
              },
            ),
          );
          const cleared = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.clearRecords`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
              },
            ),
          );
          expect(cleared.status).toBe(200);

          const listed = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.listRecords?${spaceQuery(space, alice.did)}`,
              alice.accessJwt,
            ),
          );
          expect(listed.body['records']).toEqual([]);
          const latest = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getLatestCommit?${spaceQuery(space, alice.did)}`,
              alice.accessJwt,
            ),
          );
          const commit = latest.body['commit'] as {
            data: { $bytes: string };
            rev: string;
          };
          const empty = yield* Effect.promise(() =>
            Effect.runPromise(ltHashDigestOf([])),
          );
          expect(Buffer.from(commit.data.$bytes, 'base64')).toEqual(
            Buffer.from(empty),
          );

          // A second clear has nothing to delete: same revision, no new entry.
          yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.clearRecords`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
              },
            ),
          );
          const again = yield* Effect.promise(() =>
            getJson(
              `${pds.url}/xrpc/com.atproto.space.getLatestCommit?${spaceQuery(space, alice.did)}`,
              alice.accessJwt,
            ),
          );
          expect((again.body['commit'] as { rev: string }).rev).toBe(
            commit.rev,
          );

          // The state is empty, so this is a `create` from `null`, not a
          // duplicate of the record the clear removed.
          const recreated = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createRecord`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
                collection: 'com.example.note',
                rkey: 'one',
                record: { $type: 'com.example.note', text: 'back' },
              },
            ),
          );
          expect(recreated.status).toBe(200);
        }),
      ),
    );
  });
});

describe('a space repo outlives the server', () => {
  it('a fresh server over the same store reads the space, its record and its digest', async () => {
    // `wks8`: the write log used to be process memory, so a restart or an isolate eviction lost every
    // space repo. It now lives in the same `Kv` as the archives — and "the same store" is what this
    // test builds: a second server over the first one's services, which is a restart with the sockets
    // still up.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* startMemoryPds();
          const created = yield* Effect.promise(() =>
            fetch(`${first.url}/xrpc/com.atproto.server.createAccount`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                handle: 'alice.pds.test',
                password: 'correct horse battery staple',
              }),
            }).then(
              (response) => response.json() as Promise<Record<string, string>>,
            ),
          );
          const did = created['did'] ?? '';
          const token = created['accessJwt'] ?? '';
          const post = (method: string, body: Record<string, unknown>) =>
            Effect.promise(() =>
              fetch(`${first.url}/xrpc/${method}`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
              }).then(async (response) => ({
                status: response.status,
                body: (await response.json()) as Record<string, unknown>,
              })),
            );

          const spaceAnswer = yield* post('com.atproto.space.createSpace', {
            spaceType: SPACE_TYPE,
            skey: 'club',
            policy: { $type: 'com.atproto.personalspace.policy' },
          });
          const space = String(spaceAnswer.body['uri']);
          const written = yield* post('com.atproto.space.createRecord', {
            space,
            repo: did,
            collection: 'com.example.note',
            rkey: 'one',
            record: { $type: 'com.example.note', text: 'one' },
          });
          expect(written.status).toBe(200);

          // The second server: same `Kv`, **new service objects** — a restart, as the store can tell.
          // A `SpaceStore` cached from the first server would share its log whatever the log is made
          // of, which is why this one is built fresh over the same `Kv`.
          const restartStore = yield* SpaceStore.pipe(
            Effect.provide(spaceStoreLayer),
            Effect.provideService(Kv, first.spaces.kv),
          );
          const keys = yield* generateES256KeyPair();
          const secondPort = yield* createPdsServer({
            config: {
              did: 'did:web:pds.test',
              domain: 'pds.test',
              signingKey: keys.privateKey,
              clockId: 0,
            },
            repo: first.repo,
            accounts: first.accounts,
            blobs: first.blobs,
            replay: first.replay,
            firehose: first.firehose,
            mail: first.mail,
            spaces: restartStore,
          }).start({ port: 0, hostname: '127.0.0.1' });
          const base = `http://127.0.0.1:${secondPort}`;
          const session = yield* Effect.promise(() =>
            fetch(`${base}/xrpc/com.atproto.server.createSession`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                identifier: did,
                password: 'correct horse battery staple',
              }),
            }).then(
              (response) => response.json() as Promise<Record<string, string>>,
            ),
          );
          const fresh = session['accessJwt'] ?? '';
          const read = (path: string) =>
            Effect.promise(() =>
              fetch(`${base}/xrpc/${path}`, {
                headers: { authorization: `Bearer ${fresh}` },
              }).then(
                (response) =>
                  response.json() as Promise<Record<string, unknown>>,
              ),
            );

          expect(
            yield* read(`com.atproto.space.listSpaces?did=${did}`),
          ).toEqual({
            spaces: [{ uri: space }],
          });
          const listed = yield* read(
            `com.atproto.space.listRecords?space=${space}&repo=${did}`,
          );
          expect(listed['records']).toEqual([
            expect.objectContaining({
              collection: 'com.example.note',
              rkey: 'one',
            }),
          ]);
          // The same `data`: the digest of what the repo holds, not of who served it.
          const commit = (yield* read(
            `com.atproto.space.getLatestCommit?space=${space}&repo=${did}`,
          )) as { commit: { data: { $bytes: string } } };
          expect(commit.commit.data.$bytes.length).toBeGreaterThan(0);
        }),
      ),
    );
  });
});

describe('the authority, or a member, mints a space credential (frxd, myyq)', () => {
  const JKT = 'the-app-dpop-thumbprint';

  const withSpace = async (
    run: (params: {
      readonly url: string;
      readonly space: string;
      readonly account: Account;
      readonly other: Account;
      readonly post: (
        path: string,
        body: unknown,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
    }) => Promise<void>,
    allowedApps?: ReadonlyArray<string>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const account = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const other = yield* Effect.promise(() =>
            createAccount(pds.url, 'bob.pds.test'),
          );
          const space = `at://${account.did}/${SPACE_TYPE}/club`;
          const meta = yield* Effect.promise(() =>
            metaArchive({
              space,
              policy: {
                $type: 'com.atproto.memberspace.policy',
                publicRead: true,
                ...(allowedApps === undefined
                  ? {}
                  : { allowedApps: [...allowedApps] }),
              },
              state: [memberState(account.did)],
              writers: [],
            }),
          );
          const imported = yield* Effect.promise(() =>
            postRaw(
              `${pds.url}/xrpc/com.atproto.space.importSpaceMeta`,
              meta,
              account.accessJwt,
            ),
          );
          expect(imported.status).toBe(200);
          yield* Effect.promise(() =>
            run({
              url: pds.url,
              space,
              account,
              other,
              post: (path, body, jwt) =>
                postJson(
                  `${pds.url}${path}`,
                  jwt,
                  body as Record<string, Schema.Json>,
                ),
            }),
          );
        }),
      ),
    );

  it('mints for an app the policy names, and the token verifies against the host key', async () => {
    await withSpace(
      async ({ space, account, post }) => {
        const minted = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: 'did:web:appview.example', jkt: JKT },
          account.accessJwt,
        );
        expect(minted.status).toBe(200);
        const token = String(minted.body['token'] ?? '');
        expect(token.split('.')).toHaveLength(3);
        // The claims say who may use it, for what, and until when.
        const claims = JSON.parse(
          Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
        ) as {
          space: string;
          sub: string;
          member: string;
          cnf: { jkt: string };
        };
        expect(claims).toMatchObject({
          space,
          sub: 'did:web:appview.example',
          member: account.did,
          cnf: { jkt: JKT },
        });
      },
      ['did:web:appview.example'],
    );
  });

  it('refuses an app the policy does not name', async () => {
    await withSpace(
      async ({ space, account, post }) => {
        const refused = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: 'did:web:stranger.example', jkt: JKT },
          account.accessJwt,
        );
        expect(refused.status).toBe(403);
        expect(String(refused.body['message'])).toContain(
          'not an app this space allows',
        );
      },
      ['did:web:appview.example'],
    );
  });

  /**
   * A memberspace with `publicRead: false` and a member row for one account (not the authority),
   * which is the only place `decideRead` has a membership to lend.
   */
  const withClosed = async (
    run: (params: {
      readonly space: string;
      readonly authority: Account;
      readonly member: Account;
      readonly carol: Account;
      readonly post: (
        path: string,
        body: unknown,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
    }) => Promise<void>,
    allowedApps?: ReadonlyArray<string>,
    read = true,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const authority = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const member = yield* Effect.promise(() =>
            createAccount(pds.url, 'bob.pds.test'),
          );
          const carol = yield* Effect.promise(() =>
            createAccount(pds.url, 'carol.pds.test'),
          );
          const space = `at://${authority.did}/${SPACE_TYPE}/club`;
          const meta = yield* Effect.promise(() =>
            metaArchive({
              space,
              policy: {
                $type: 'com.atproto.memberspace.policy',
                publicRead: false,
                ...(allowedApps === undefined
                  ? {}
                  : { allowedApps: [...allowedApps] }),
              },
              state: [
                memberState(authority.did),
                memberState(member.did, read),
              ],
              writers: [],
            }),
          );
          const imported = yield* Effect.promise(() =>
            postRaw(
              `${pds.url}/xrpc/com.atproto.space.importSpaceMeta`,
              meta,
              authority.accessJwt,
            ),
          );
          expect(imported.status).toBe(200);
          yield* Effect.promise(() =>
            run({
              space,
              authority,
              member,
              carol,
              post: (path, body, jwt) =>
                postJson(
                  `${pds.url}${path}`,
                  jwt,
                  body as Record<string, Schema.Json>,
                ),
            }),
          );
        }),
      ),
    );

  const APP = 'did:web:appview.example';

  it('refuses a session with no member row in a closed space', async () => {
    await withClosed(
      async ({ space, carol, post }) => {
        const refused = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: APP, jkt: JKT },
          carol.accessJwt,
        );
        expect(refused.status).toBe(403);
        expect(String(refused.body['message'])).toContain('not-a-member');
      },
      [APP],
    );
  });

  it('mints for an app when a member with read lends its read', async () => {
    await withClosed(
      async ({ space, member, post }) => {
        const minted = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: APP, jkt: JKT },
          member.accessJwt,
        );
        expect(minted.status).toBe(200);
        const token = String(minted.body['token'] ?? '');
        // The token names the app as `sub`, and the member that lent its read as `member`.
        const claims = JSON.parse(
          Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
        ) as { sub: string; member: string; cnf: { jkt: string } };
        expect(claims.sub).toBe(APP);
        expect(claims.member).toBe(member.did);
        expect(claims.cnf.jkt).toBe(JKT);
      },
      [APP],
    );
  });

  it('refuses a member with no read', async () => {
    await withClosed(
      async ({ space, member, post }) => {
        const refused = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: APP, jkt: JKT },
          member.accessJwt,
        );
        expect(refused.status).toBe(403);
        expect(String(refused.body['message'])).toContain('member-has-no-read');
      },
      [APP],
      false,
    );
  });

  it('refuses an app the policy does not name, even for a member', async () => {
    await withClosed(
      async ({ space, member, post }) => {
        const refused = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: APP, jkt: JKT },
          member.accessJwt,
        );
        expect(refused.status).toBe(403);
        expect(String(refused.body['message'])).toContain(
          'not an app this space allows',
        );
      },
      ['did:web:other.example'],
    );
  });

  it('still lets the authority mint in a closed space', async () => {
    await withClosed(
      async ({ space, authority, post }) => {
        const minted = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: APP, jkt: JKT },
          authority.accessJwt,
        );
        expect(minted.status).toBe(200);
      },
      [APP],
    );
  });
});

describe('an approved app asks for a credential, without a session (frxd)', () => {
  const APP = 'did:web:appview.example:identity';
  const JKT = 'the-app-dpop-thumbprint';

  const withApp = async (params: {
    readonly run: (input: {
      readonly url: string;
      readonly space: string;
      readonly proof: string;
      readonly post: (
        path: string,
        body: Record<string, Schema.Json>,
        headers: Record<string, string>,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
    }) => Promise<void>;
    readonly allowedApps?: ReadonlyArray<string>;
    readonly appKey?: boolean;
  }) => {
    const appKeys = await Effect.runPromise(generateES256KeyPair());
    const proof = await Effect.runPromise(
      signAppProof({
        app: APP,
        audience: 'did:web:pds.test',
        jkt: JKT,
        now: Date.now(),
        key: appKeys.privateKey,
        ttl: 60,
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds({
            appKeys: (did) =>
              Effect.succeed(
                params.appKey === false || did !== APP
                  ? undefined
                  : appKeys.publicKey,
              ),
          });
          const account = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const space = `at://${account.did}/${SPACE_TYPE}/club`;
          const meta = yield* Effect.promise(() =>
            metaArchive({
              space,
              policy: {
                $type: 'com.atproto.memberspace.policy',
                publicRead: true,
                allowedApps: [...(params.allowedApps ?? [APP])],
              },
              state: [memberState(account.did)],
              writers: [],
            }),
          );
          const imported = yield* Effect.promise(() =>
            postRaw(
              `${pds.url}/xrpc/com.atproto.space.importSpaceMeta`,
              meta,
              account.accessJwt,
            ),
          );
          expect(imported.status).toBe(200);
          yield* Effect.promise(() =>
            params.run({
              url: pds.url,
              space,
              proof,
              post: async (path, body, headers) => {
                const response = await fetch(`${pds.url}${path}`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', ...headers },
                  body: JSON.stringify(body),
                });
                return {
                  status: response.status,
                  body: (await response.json()) as Record<string, Schema.Json>,
                };
              },
            }),
          );
        }),
      ),
    );
  };

  it('mints for the app that signed, with no account behind it', async () => {
    await withApp({
      run: async ({ space, proof, post }) => {
        const minted = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: APP, jkt: JKT },
          { authorization: `Bearer ${proof}` },
        );
        expect(minted.status).toBe(200);
        const token = String(minted.body['token'] ?? '');
        const claims = JSON.parse(
          Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
        ) as { sub: string; cnf: { jkt: string } };
        expect(claims.sub).toBe(APP);
        expect(claims.cnf.jkt).toBe(JKT);
      },
    });
  });

  it('refuses an app the policy does not name', async () => {
    await withApp({
      allowedApps: ['did:web:other.example'],
      run: async ({ space, proof, post }) => {
        const refused = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: APP, jkt: JKT },
          { authorization: `Bearer ${proof}` },
        );
        expect(refused.status).toBe(403);
      },
    });
  });

  it('refuses a proof whose key nobody publishes', async () => {
    await withApp({
      appKey: false,
      run: async ({ space, proof, post }) => {
        const refused = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: APP, jkt: JKT },
          { authorization: `Bearer ${proof}` },
        );
        expect(refused.status).toBe(401);
      },
    });
  });
});

describe('an approved app reads a space with its credential (frxd)', () => {
  const APP = 'did:web:appview.example:identity';

  /** One PDS, a space the app may read, and one record in it. */
  const withSpace = async (
    run: (input: {
      readonly read: (
        space: string,
        repo: string,
        headers: Record<string, string>,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, unknown>;
      }>;
      readonly mint: (
        space: string,
        jkt: string,
        proof: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, unknown>;
      }>;
      /** The same, with a session's token: the authority, or a member lending its read. */
      readonly mintWith: (
        space: string,
        jkt: string,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, unknown>;
      }>;
      readonly space: string;
      readonly repo: string;
      /** A read proof for one space, signed by the app's key. */
      readonly readProofFor: (space: string) => Promise<string>;
      readonly jkt: string;
      readonly proof: string;
      /** The second account: a member, never the authority. */
      readonly member: Account;
      /** The space's authority. */
      readonly authority: Account;
      /** Remove the member from the space, as the authority. */
      readonly removeMember: (did: string) => Promise<void>;
    }) => Promise<void>,
    options?: { readonly publicRead?: boolean },
  ) => {
    const keys = await Effect.runPromise(generateES256KeyPair());
    const jkt = await Effect.runPromise(jktOfKey(keys.publicKey));
    if (jkt === undefined) {
      throw new Error('the test key has no thumbprint');
    }
    const proof = await Effect.runPromise(
      signAppProof({
        app: APP,
        audience: 'did:web:pds.test',
        jkt,
        now: Date.now(),
        key: keys.privateKey,
        ttl: 300,
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds({
            appKeys: (did) =>
              Effect.succeed(did === APP ? keys.publicKey : undefined),
          });
          const alice = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const member = yield* Effect.promise(() =>
            createAccount(pds.url, 'bob.pds.test'),
          );
          const created = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createSpace`,
              alice.accessJwt,
              {
                spaceType: SPACE_TYPE,
                skey: 'club',
                policy: {
                  $type: 'com.atproto.memberspace.policy',
                  // The AppView's case: a space anyone may read, which still needs *something*
                  // that proves it — a session before, a credential for an app now.
                  publicRead: options?.publicRead ?? true,
                  allowedApps: [APP],
                },
              },
            ),
          );
          const space = String(created.body['uri']);
          const added = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.memberspace.putMember`,
              alice.accessJwt,
              { space, did: member.did, read: true, write: false },
            ),
          );
          expect(added.status).toBe(200);
          const written = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createRecord`,
              alice.accessJwt,
              {
                space,
                repo: alice.did,
                collection: 'com.example.note',
                rkey: 'one',
                record: { $type: 'com.example.note', text: 'one' },
              },
            ),
          );
          expect(written.status).toBe(200);
          const call = async (
            path: string,
            init: {
              readonly method?: string;
              readonly headers: Record<string, string>;
              readonly body?: string;
            },
          ) => {
            const response = await fetch(`${pds.url}${path}`, {
              ...(init.method === undefined ? {} : { method: init.method }),
              headers: {
                ...(init.body === undefined
                  ? {}
                  : { 'content-type': 'application/json' }),
                ...init.headers,
              },
              ...(init.body === undefined ? {} : { body: init.body }),
            });
            return {
              status: response.status,
              body: (await response.json()) as Record<string, unknown>,
            };
          };
          yield* Effect.promise(() =>
            run({
              space,
              repo: alice.did,
              readProofFor: (space) =>
                Effect.runPromise(
                  signAppProof({
                    app: APP,
                    audience: 'did:web:pds.test',
                    jkt,
                    space,
                    now: Date.now(),
                    key: keys.privateKey,
                  }),
                ),
              jkt,
              proof,
              member,
              authority: alice,
              removeMember: async (did) => {
                const removed = await call(
                  '/xrpc/com.atproto.memberspace.removeMember',
                  {
                    method: 'POST',
                    headers: { authorization: `Bearer ${alice.accessJwt}` },
                    body: JSON.stringify({ space, did }),
                  },
                );
                expect(removed.status).toBe(200);
              },
              mint: (space, jkt, proof) =>
                call('/xrpc/com.atproto.space.getCredential', {
                  method: 'POST',
                  headers: { authorization: `Bearer ${proof}` },
                  body: JSON.stringify({ space, app: APP, jkt }),
                }),
              mintWith: (space, jkt, jwt) =>
                call('/xrpc/com.atproto.space.getCredential', {
                  method: 'POST',
                  headers: { authorization: `Bearer ${jwt}` },
                  body: JSON.stringify({ space, app: APP, jkt }),
                }),
              read: (space, repo, headers) =>
                call(
                  `/xrpc/com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${encodeURIComponent(repo)}`,
                  { headers },
                ),
            }),
          );
        }),
      ),
    );
  };

  it('serves the records to a valid credential and a proof for its key', async () => {
    await withSpace(
      async ({ space, repo, jkt, proof, mint, read, readProofFor }) => {
        const minted = await mint(space, jkt, proof);
        expect(minted.status).toBe(200);
        const credential = String(minted.body['token'] ?? '');
        const answer = await read(space, repo, {
          authorization: `Bearer ${credential}`,
          dpop: await readProofFor(space),
        });
        expect(answer.status).toBe(200);
        const records = answer.body['records'] as ReadonlyArray<{
          collection: string;
          rkey: string;
          value: Record<string, unknown>;
        }>;
        expect(records.map((one) => `${one.collection}/${one.rkey}`)).toEqual([
          'com.example.note/one',
        ]);
        expect(records[0]?.value['text']).toBe('one');
      },
    );
  });

  it('refuses the credential with no proof behind it', async () => {
    await withSpace(async ({ space, repo, jkt, proof, mint, read }) => {
      const minted = await mint(space, jkt, proof);
      const credential = String(minted.body['token'] ?? '');
      const answer = await read(space, repo, {
        authorization: `Bearer ${credential}`,
      });
      expect(answer.status).toBe(401);
    });
  });

  it('refuses a proof made for another space', async () => {
    await withSpace(
      async ({ space, repo, jkt, proof, mint, read, readProofFor }) => {
        const minted = await mint(space, jkt, proof);
        const credential = String(minted.body['token'] ?? '');
        const answer = await read(space, repo, {
          authorization: `Bearer ${credential}`,
          dpop: await readProofFor(
            'at://did:plc:someoneelse/com.example.space/other',
          ),
        });
        expect(answer.status).toBe(401);
      },
    );
  });

  it('refuses a credential bound to a key the caller does not hold', async () => {
    await withSpace(
      async ({ space, repo, jkt, proof, mint, read, readProofFor }) => {
        // The token names a key that is not the one the proof verifies with.
        const minted = await mint(space, `${jkt}-not-the-key`, proof);
        const credential = String(minted.body['token'] ?? '');
        const answer = await read(space, repo, {
          authorization: `Bearer ${credential}`,
          dpop: await readProofFor(space),
        });
        expect(answer.status).toBe(401);
      },
    );
  });

  it('stops opening the space when the member that lent it is removed', async () => {
    await withSpace(
      async ({
        space,
        repo,
        jkt,
        member,
        mintWith,
        read,
        readProofFor,
        removeMember,
      }) => {
        const minted = await mintWith(space, jkt, member.accessJwt);
        expect(minted.status).toBe(200);
        const credential = String(minted.body['token'] ?? '');
        const headers = async () => ({
          authorization: `Bearer ${credential}`,
          dpop: await readProofFor(space),
        });
        // The read the membership bought, while it stands.
        expect((await read(space, repo, await headers())).status).toBe(200);
        await removeMember(member.did);
        // The same token, well before `exp`, no longer opens anything.
        const refused = await read(space, repo, await headers());
        expect(refused.status).toBe(401);
        expect(String(refused.body['message'])).toContain('not-a-member');
      },
      { publicRead: false },
    );
  });

  it("still reads with the authority's own credential in a closed space", async () => {
    await withSpace(
      async ({ space, repo, jkt, authority, mintWith, read, readProofFor }) => {
        const minted = await mintWith(space, jkt, authority.accessJwt);
        expect(minted.status).toBe(200);
        const answer = await read(space, repo, {
          authorization: `Bearer ${String(minted.body['token'] ?? '')}`,
          dpop: await readProofFor(space),
        });
        expect(answer.status).toBe(200);
      },
      { publicRead: false },
    );
  });

  it('keeps a publicRead credential reading after a member is removed', async () => {
    await withSpace(
      async ({
        space,
        repo,
        jkt,
        proof,
        member,
        mint,
        read,
        readProofFor,
        removeMember,
      }) => {
        // The app asks on its own here, so the token's `member` is the app: `publicRead` is what
        // the re-check answers with, and a membership it never had cannot take that away.
        const minted = await mint(space, jkt, proof);
        expect(minted.status).toBe(200);
        const credential = String(minted.body['token'] ?? '');
        await removeMember(member.did);
        const answer = await read(space, repo, {
          authorization: `Bearer ${credential}`,
          dpop: await readProofFor(space),
        });
        expect(answer.status).toBe(200);
      },
    );
  });
});

describe('a managedspace asks its app (`70cr`)', () => {
  /** The app's `did:web` identity: the domain names the host, the service names the endpoint. */
  const DID_WEB = 'did:web:appview.example';
  const MANAGING_APP = `${DID_WEB}#manage`;

  const documentFor = (endpoint: string) =>
    JSON.stringify({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: DID_WEB,
      service: [
        {
          id: '#manage',
          type: 'AtprotoManagedSpace',
          serviceEndpoint: endpoint,
        },
      ],
    });

  /**
   * A managing app that answers `{ read, write }` — or, for the failure paths, the old
   * `{ authorized }` body, or never answers at all: `unreachable` is a port nothing listens on,
   * `timeout` a server that holds the request.
   */
  type AppAnswer =
    | { readonly read: boolean; readonly write: boolean }
    | 'the-old-body'
    | 'unreachable'
    | 'timeout';

  const startApp = async (answer: AppAnswer) => {
    const asked: Array<{ url: string; authorization: string }> = [];
    if (answer === 'unreachable') {
      // A port that was bound and closed again: the endpoint resolves, nothing answers.
      const probe = createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, '127.0.0.1', resolve),
      );
      const { port } = probe.address() as AddressInfo;
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
      return {
        endpoint: `http://127.0.0.1:${port}`,
        asked,
        close: () => Promise.resolve(),
      };
    }
    const server = createServer((request, response) => {
      asked.push({
        url: request.url ?? '',
        authorization: String(request.headers.authorization ?? ''),
      });
      if (answer === 'timeout') {
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          answer === 'the-old-body' ? { authorized: true } : answer,
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    return {
      endpoint: `http://127.0.0.1:${port}`,
      asked,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  };

  /**
   * A PDS whose identity resolver serves the app's document from memory: the real resolver, the real
   * `checkAccess` call over HTTP, only the document fetch replaced.
   */
  const withManagedSpace = async (
    answer: AppAnswer,
    run: (params: {
      readonly url: string;
      readonly space: string;
      readonly authority: Account;
      readonly writer: Account;
      readonly asked: ReadonlyArray<{
        readonly url: string;
        readonly authorization: string;
      }>;
      readonly post: (
        path: string,
        body: Record<string, Schema.Json>,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
      readonly get: (
        query: string,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
    }) => Promise<void>,
  ) => {
    const app = await startApp(answer);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pds = yield* startMemoryPds({
              identity: new DefaultIdentityResolver(
                {
                  lookupTxt: () => Effect.succeed([]),
                  fetchWellKnown: () => Effect.succeed(undefined),
                },
                {
                  fetchDocument: () =>
                    Effect.succeed(documentFor(app.endpoint)),
                },
              ),
            });
            const authority = yield* Effect.promise(() =>
              createAccount(pds.url, 'alice.pds.test'),
            );
            const writer = yield* Effect.promise(() =>
              createAccount(pds.url, 'bob.pds.test'),
            );
            const space = `at://${authority.did}/${SPACE_TYPE}/managed`;
            const created = yield* Effect.promise(() =>
              postJson(
                `${pds.url}/xrpc/com.atproto.space.createSpace`,
                authority.accessJwt,
                {
                  spaceType: SPACE_TYPE,
                  skey: 'managed',
                  policy: {
                    $type: 'com.atproto.managedspace.policy',
                    managingApp: MANAGING_APP,
                  },
                },
              ),
            );
            expect(created.status).toBe(200);

            yield* Effect.promise(() =>
              run({
                url: pds.url,
                space,
                authority,
                writer,
                asked: app.asked,
                post: (path, body, jwt) =>
                  postJson(`${pds.url}${path}`, jwt, body),
                get: async (query, jwt) => {
                  const response = await fetch(`${pds.url}/xrpc/${query}`, {
                    headers: { authorization: `Bearer ${jwt}` },
                  });
                  return {
                    status: response.status,
                    body: (await response.json()) as Record<
                      string,
                      Schema.Json
                    >,
                  };
                },
              }),
            );
          }),
        ),
      );
    } finally {
      await app.close();
    }
  };

  it('lets a write land when the app says yes, and asks it about the writer', async () => {
    await withManagedSpace(
      { read: true, write: true },
      async ({ space, writer, asked, post }) => {
        const written = await post(
          '/xrpc/com.atproto.space.createRecord',
          {
            space,
            repo: writer.did,
            collection: 'com.example.note',
            rkey: 'one',
            record: { $type: 'com.example.note', text: 'one' },
          },
          writer.accessJwt,
        );

        expect(written.status).toBe(200);
        expect(asked).toHaveLength(1);
        const asked1 = new URL(`http://app${asked[0]?.url ?? ''}`);
        expect(asked1.searchParams.get('space')).toBe(space);
        expect(asked1.searchParams.get('repo')).toBe(writer.did);
        // The access kind is no longer a parameter: the app answers both fields.
        expect(asked1.searchParams.get('access')).toBeNull();
        // A write carries no client: `notifyWrite` does not identify the originating app.
        expect(asked1.searchParams.get('clientId')).toBeNull();
      },
    );
  });

  it('refuses the write when the app says no, and asks it once', async () => {
    await withManagedSpace(
      { read: true, write: false },
      async ({ space, writer, asked, post }) => {
        const written = await post(
          '/xrpc/com.atproto.space.createRecord',
          {
            space,
            repo: writer.did,
            collection: 'com.example.note',
            rkey: 'one',
            record: { $type: 'com.example.note', text: 'one' },
          },
          writer.accessJwt,
        );

        expect(written.status).toBe(403);
        // The named reason, not just a refusal: "the app said no" is not "the app never answered".
        expect(String(written.body['message'])).toContain('the-app-denied');
        expect(asked).toHaveLength(1);
      },
    );
  });

  it('never asks the app about the authority', async () => {
    await withManagedSpace(
      { read: false, write: false },
      async ({ space, authority, asked, post }) => {
        const written = await post(
          '/xrpc/com.atproto.space.createRecord',
          {
            space,
            repo: authority.did,
            collection: 'com.example.note',
            rkey: 'one',
            record: { $type: 'com.example.note', text: 'one' },
          },
          authority.accessJwt,
        );

        expect(written.status).toBe(200);
        expect(asked).toEqual([]);
      },
    );
  });

  /** The note the authority writes, and the grant it may share instead of the app's yes. */
  const noteRecord = (space: string, repo: string) => ({
    space,
    repo,
    collection: 'com.example.note',
    rkey: 'one',
    record: { $type: 'com.example.note', text: 'one' },
  });

  const grantRecord = (params: {
    readonly space: string;
    readonly subject: string;
    readonly issuedBy: string;
  }) => ({
    space: params.space,
    repo: params.issuedBy,
    collection: 'ing.lexicon.grant',
    rkey: 'to-reader',
    record: {
      $type: 'ing.lexicon.grant',
      space: params.space,
      subject: params.subject,
      selectors: [{ collection: 'com.example.note' }],
      actions: ['view'],
      issuedBy: params.issuedBy,
      createdAt: new Date().toISOString(),
    },
  });

  const notesOf = (space: string, repo: string) =>
    `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${repo}&collection=com.example.note`;

  it('lets a session read another author when the app says yes, with no grant', async () => {
    await withManagedSpace(
      { read: true, write: true },
      async ({ space, authority, writer, asked, post, get }) => {
        const written = await post(
          '/xrpc/com.atproto.space.createRecord',
          noteRecord(space, authority.did),
          authority.accessJwt,
        );
        expect(written.status).toBe(200);
        // The authority's own write asks nothing: the read below is the only ask.
        expect(asked).toEqual([]);

        const listed = await get(
          notesOf(space, authority.did),
          writer.accessJwt,
        );
        expect(listed.status).toBe(200);
        expect(
          (listed.body['records'] as ReadonlyArray<{ rkey: string }>).map(
            (one) => one.rkey,
          ),
        ).toEqual(['one']);

        expect(asked).toHaveLength(1);
        const asked1 = new URL(`http://app${asked[0]?.url ?? ''}`);
        expect(asked1.searchParams.get('space')).toBe(space);
        expect(asked1.searchParams.get('repo')).toBe(writer.did);
        expect(asked1.searchParams.get('access')).toBeNull();
      },
    );
  });

  for (const [name, answer, reason] of [
    ['says no to both', { read: false, write: false }, 'the-app-denied'],
    ['is unreachable', 'unreachable', 'unreachable'],
    ['times out', 'timeout', 'timeout'],
    ['answers the old { authorized } body', 'the-old-body', 'malformed'],
  ] as const) {
    it(`falls through to the grant gate when the app ${name}`, async () => {
      await withManagedSpace(
        answer,
        async ({ space, authority, writer, post, get }) => {
          const written = await post(
            '/xrpc/com.atproto.space.createRecord',
            noteRecord(space, authority.did),
            authority.accessJwt,
          );
          expect(written.status).toBe(200);

          // No grant: refused with the app's own reason, never a 500.
          const refused = await get(
            notesOf(space, authority.did),
            writer.accessJwt,
          );
          expect(refused.status).toBe(403);
          expect(String(refused.body['message'])).toContain(reason);

          // The grant is the second axis: the app's no does not withdraw it.
          const granted = await post(
            '/xrpc/com.atproto.space.createRecord',
            grantRecord({
              space,
              subject: writer.did,
              issuedBy: authority.did,
            }),
            authority.accessJwt,
          );
          expect(granted.status).toBe(200);
          const listed = await get(
            notesOf(space, authority.did),
            writer.accessJwt,
          );
          expect(listed.status).toBe(200);
        },
      );
    }, 15_000); // Two asks at the app's 2 s bound: the granted read asks again rather than caching.
  }

  it('allows the write and refuses the read when the app answers { read: false, write: true }', async () => {
    await withManagedSpace(
      { read: false, write: true },
      async ({ space, authority, writer, post, get }) => {
        // The write asks the app and gets `write: true`: the fields are separate answers.
        const ownWrite = await post(
          '/xrpc/com.atproto.space.createRecord',
          noteRecord(space, writer.did),
          writer.accessJwt,
        );
        expect(ownWrite.status).toBe(200);

        const authorityWrite = await post(
          '/xrpc/com.atproto.space.createRecord',
          noteRecord(space, authority.did),
          authority.accessJwt,
        );
        expect(authorityWrite.status).toBe(200);

        // The same app said `read: false`, and no grant covers it.
        const refused = await get(
          notesOf(space, authority.did),
          writer.accessJwt,
        );
        expect(refused.status).toBe(403);
        expect(String(refused.body['message'])).toContain('the-app-denied');
        expect(String(refused.body['message'])).toContain('read is false');
      },
    );
  });

  it('mints a credential for a managed space when the app says yes', async () => {
    await withManagedSpace(
      { read: true, write: true },
      async ({ space, writer, post }) => {
        const minted = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: 'did:web:reader.example', jkt: 'jkt' },
          writer.accessJwt,
        );
        expect(minted.status).toBe(200);
        expect(String(minted.body['token'] ?? '').split('.')).toHaveLength(3);
      },
    );
  });

  it('refuses a credential for a managed space when the app says no', async () => {
    await withManagedSpace(
      { read: false, write: false },
      async ({ space, writer, post }) => {
        const refused = await post(
          '/xrpc/com.atproto.space.getCredential',
          { space, app: 'did:web:reader.example', jkt: 'jkt' },
          writer.accessJwt,
        );
        expect(refused.status).toBe(403);
        expect(String(refused.body['message'])).toContain(
          'the-managing-app-decides',
        );
      },
    );
  });

  it('never asks for a memberspace or a personalspace', async () => {
    await withManagedSpace(
      { read: false, write: false },
      async ({ authority, writer, asked, post, get }) => {
        const memberSpace = `at://${authority.did}/${SPACE_TYPE}/public`;
        const created = await post(
          '/xrpc/com.atproto.space.createSpace',
          {
            spaceType: SPACE_TYPE,
            skey: 'public',
            policy: {
              $type: 'com.atproto.memberspace.policy',
              publicRead: true,
            },
          },
          authority.accessJwt,
        );
        expect(created.status).toBe(200);
        const written = await post(
          '/xrpc/com.atproto.space.createRecord',
          noteRecord(memberSpace, authority.did),
          authority.accessJwt,
        );
        expect(written.status).toBe(200);
        const publicRead = await get(
          notesOf(memberSpace, authority.did),
          writer.accessJwt,
        );
        expect(publicRead.status).toBe(200);

        const personalSpace = `at://${authority.did}/${SPACE_TYPE}/mine`;
        const personal = await post(
          '/xrpc/com.atproto.space.createSpace',
          {
            spaceType: SPACE_TYPE,
            skey: 'mine',
            policy: { $type: 'com.atproto.personalspace.policy' },
          },
          authority.accessJwt,
        );
        expect(personal.status).toBe(200);
        const own = await post(
          '/xrpc/com.atproto.space.createRecord',
          noteRecord(personalSpace, authority.did),
          authority.accessJwt,
        );
        expect(own.status).toBe(200);
        const refused = await get(
          notesOf(personalSpace, authority.did),
          writer.accessJwt,
        );
        expect(refused.status).toBe(403);

        expect(asked).toEqual([]);
      },
    );
  });
});
describe('grants over a space', () => {
  const GRANT = 'ing.lexicon.grant';
  const REVOKE = 'ing.lexicon.grant.revoke';
  const A_CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  /** The record the authority shares. */
  const note = (rkey: string) => ({ $type: 'com.example.note', text: rkey });

  const grantFor = (params: {
    readonly space: string;
    readonly subject: string;
    readonly issuedBy: string;
    readonly selector: Record<string, Schema.Json>;
  }) => ({
    $type: GRANT,
    space: params.space,
    subject: params.subject,
    selectors: [params.selector],
    actions: ['view'],
    issuedBy: params.issuedBy,
    createdAt: new Date().toISOString(),
  });

  /**
   * A personal space of `alice`, read by `bob`. A grant lives in the **authority's** repo in the
   * space, which is the whole point of the store: that repo is the only one consulted, so a grant a
   * member writes into their own repo is not a grant.
   */
  const withGrantedSpace = async (
    run: (params: {
      readonly space: string;
      readonly authority: Account;
      readonly reader: Account;
      readonly write: (
        body: Record<string, Schema.Json>,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
      readonly get: (
        query: string,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
    }) => Promise<void>,
    policy: Record<string, Schema.Json> = {
      $type: 'com.atproto.personalspace.policy',
    },
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const authority = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const reader = yield* Effect.promise(() =>
            createAccount(pds.url, 'bob.pds.test'),
          );
          const space = `at://${authority.did}/${SPACE_TYPE}/shared`;
          const created = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createSpace`,
              authority.accessJwt,
              { spaceType: SPACE_TYPE, skey: 'shared', policy },
            ),
          );
          expect(created.status).toBe(200);
          yield* Effect.promise(() =>
            run({
              space,
              authority,
              reader,
              write: (body, jwt) =>
                postJson(
                  `${pds.url}/xrpc/com.atproto.space.createRecord`,
                  jwt,
                  body,
                ),
              get: async (query, jwt) => {
                const response = await fetch(`${pds.url}/xrpc/${query}`, {
                  headers: { authorization: `Bearer ${jwt}` },
                });
                return {
                  status: response.status,
                  body: (await response.json()) as Record<string, Schema.Json>,
                };
              },
            }),
          );
        }),
      ),
    );

  const record = (params: {
    readonly space: string;
    readonly repo: string;
    readonly collection: string;
    readonly rkey: string;
    readonly value: Record<string, Schema.Json>;
  }) => ({
    space: params.space,
    repo: params.repo,
    collection: params.collection,
    rkey: params.rkey,
    record: params.value as Schema.Json,
  });

  it('lets another account read the collection a grant names', async () => {
    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      for (const rkey of ['one', 'two']) {
        const written = await write(
          record({
            space,
            repo: authority.did,
            collection: 'com.example.note',
            rkey,
            value: note(rkey),
          }),
          authority.accessJwt,
        );
        expect(written.status).toBe(200);
      }
      const granted = await write(
        record({
          space,
          repo: authority.did,
          collection: GRANT,
          rkey: 'to-bob',
          value: grantFor({
            space,
            subject: reader.did,
            issuedBy: authority.did,
            selector: { collection: 'com.example.note' },
          }),
        }),
        authority.accessJwt,
      );
      expect(granted.status).toBe(200);

      const listed = await get(
        `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`,
        reader.accessJwt,
      );
      expect(listed.status).toBe(200);
      expect(
        (listed.body['records'] as ReadonlyArray<{ rkey: string }>).map(
          (one) => one.rkey,
        ),
      ).toEqual(['one', 'two']);
    });
  });

  it('returns only the fields a grant promises, and no others', async () => {
    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      const written = await write(
        record({
          space,
          repo: authority.did,
          collection: 'com.example.note',
          rkey: 'one',
          value: {
            $type: 'com.example.note',
            text: 'what the coach must not see',
            startedAt: '2026-11-07T00:00:00.000Z',
          },
        }),
        authority.accessJwt,
      );
      expect(written.status).toBe(200);

      const granted = await write(
        record({
          space,
          repo: authority.did,
          collection: GRANT,
          rkey: 'fields-to-bob',
          value: grantFor({
            space,
            subject: reader.did,
            issuedBy: authority.did,
            selector: {
              collection: 'com.example.note',
              fields: ['/startedAt'],
            },
          }),
        }),
        authority.accessJwt,
      );
      expect(granted.status).toBe(200);

      const listed = await get(
        `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`,
        reader.accessJwt,
      );
      expect(listed.status).toBe(200);
      const records = listed.body['records'] as ReadonlyArray<{
        rkey: string;
        value: Record<string, Schema.Json>;
      }>;
      expect(records.map((one) => one.rkey)).toEqual(['one']);
      // The promised field, the type every reader needs to interpret it, and nothing else.
      expect(records[0]?.value).toEqual({
        $type: 'com.example.note',
        startedAt: '2026-11-07T00:00:00.000Z',
      });

      const one = await get(
        `com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note&rkey=one`,
        reader.accessJwt,
      );
      expect(one.status).toBe(200);
      expect(one.body['value']).toEqual({
        $type: 'com.example.note',
        startedAt: '2026-11-07T00:00:00.000Z',
      });
    });
  });

  it('hides a record that no longer satisfies the grant condition', async () => {
    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      const fresh = new Date().toISOString();
      const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      for (const [rkey, createdAt] of [
        ['fresh', fresh],
        ['stale', stale],
      ] as const) {
        const written = await write(
          record({
            space,
            repo: authority.did,
            collection: 'com.example.note',
            rkey,
            value: { $type: 'com.example.note', text: rkey, createdAt },
          }),
          authority.accessJwt,
        );
        expect(written.status).toBe(200);
      }

      const granted = await write(
        record({
          space,
          repo: authority.did,
          collection: GRANT,
          rkey: 'recent-only',
          value: grantFor({
            space,
            subject: reader.did,
            issuedBy: authority.did,
            selector: {
              collection: 'com.example.note',
              condition: { field: '/createdAt', maxAgeSeconds: 3600 },
            },
          }),
        }),
        authority.accessJwt,
      );
      expect(granted.status).toBe(200);

      const listed = await get(
        `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`,
        reader.accessJwt,
      );
      expect(listed.status).toBe(200);
      // The stale record is not named at all — an rkey would say "something is here".
      expect(
        (listed.body['records'] as ReadonlyArray<{ rkey: string }>).map(
          (one) => one.rkey,
        ),
      ).toEqual(['fresh']);

      const one = await get(
        `com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note&rkey=stale`,
        reader.accessJwt,
      );
      // `notFound` answers 400 with atproto's own name for it, the way every other missing record
      // in this host does; the point is that it is absent, not that it is forbidden.
      expect(one.body['error']).toBe('RecordNotFound');
    });
  });

  it('projects a read through the lens the authority publishes', async () => {
    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      const written = await write(
        record({
          space,
          repo: authority.did,
          collection: 'com.example.note',
          rkey: 'one',
          value: {
            $type: 'com.example.note',
            text: 'what the coach must not see',
            startedAt: '2026-11-07T00:00:00.000Z',
          },
        }),
        authority.accessJwt,
      );
      expect(written.status).toBe(200);

      // The lens is a record in the authority's repo, keyed by the nsid of the shape it projects.
      const lens = await write(
        record({
          space,
          repo: authority.did,
          collection: 'ing.lexicon.lens',
          rkey: 'com.example.note',
          value: {
            $type: 'ing.lexicon.lens',
            fields: ['/startedAt'],
            issuedBy: authority.did,
            createdAt: new Date().toISOString(),
          },
        }),
        authority.accessJwt,
      );
      expect(lens.status).toBe(200);
      const lensCid = String(lens.body['cid']);
      expect(lensCid).not.toBe('');

      // The grant names no fields of its own: the shape is the lens's, and the cid pins it.
      const granted = await write(
        record({
          space,
          repo: authority.did,
          collection: GRANT,
          rkey: 'lens-to-bob',
          value: {
            ...grantFor({
              space,
              subject: reader.did,
              issuedBy: authority.did,
              selector: { collection: 'com.example.note' },
            }),
            lens: { nsid: 'com.example.note', cid: lensCid },
          },
        }),
        authority.accessJwt,
      );
      expect(granted.status).toBe(200);

      const listed = await get(
        `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`,
        reader.accessJwt,
      );
      expect(listed.status).toBe(200);
      const records = listed.body['records'] as ReadonlyArray<{
        rkey: string;
        value: Record<string, Schema.Json>;
      }>;
      expect(records.map((one) => one.rkey)).toEqual(['one']);
      expect(records[0]?.value).toEqual({
        $type: 'com.example.note',
        startedAt: '2026-11-07T00:00:00.000Z',
      });
    });
  });

  it('refuses a grant that pins a lens version that is not current', async () => {
    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      const written = await write(
        record({
          space,
          repo: authority.did,
          collection: 'com.example.note',
          rkey: 'one',
          value: { $type: 'com.example.note', text: 'hello' },
        }),
        authority.accessJwt,
      );
      expect(written.status).toBe(200);

      const lens = await write(
        record({
          space,
          repo: authority.did,
          collection: 'ing.lexicon.lens',
          rkey: 'com.example.note',
          value: {
            $type: 'ing.lexicon.lens',
            fields: ['/text'],
            issuedBy: authority.did,
            createdAt: new Date().toISOString(),
          },
        }),
        authority.accessJwt,
      );
      expect(lens.status).toBe(200);

      const granted = await write(
        record({
          space,
          repo: authority.did,
          collection: GRANT,
          rkey: 'stale-lens',
          value: {
            ...grantFor({
              space,
              subject: reader.did,
              issuedBy: authority.did,
              selector: { collection: 'com.example.note' },
            }),
            lens: { nsid: 'com.example.note', cid: A_CID },
          },
        }),
        authority.accessJwt,
      );
      expect(granted.status).toBe(200);

      const listed = await get(
        `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`,
        reader.accessJwt,
      );
      expect(listed.status).toBe(403);
      expect(String(listed.body['message'])).toContain('lens-incompatible');
    });
  });

  it('never lets a public view carry the full calendar event', async () => {
    // Kimbia's discipline, on a shape where it matters: a recorded run leaks the
    // address in its start and finish, an event leaks its attendees, and a
    // `VEVENT` keeps both byte for byte in `raw`. The view is the lens, so the
    // fields that never reach a reader are named once, by the authority.
    const event = {
      $type: 'ing.lexicon.calendar.event',
      raw: [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:planning@example.com',
        'DTSTART:20261107T100000Z',
        'SUMMARY:Planning',
        'ATTENDEE:mailto:bob@example.com',
        'LOCATION:56.9496,24.1052',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
      href: '/calendars/alice/planning.ics',
      uid: 'planning@example.com',
      start: '2026-11-07T10:00:00.000Z',
      end: '2026-11-07T11:00:00.000Z',
      summary: 'Planning',
      organizer: 'mailto:alice@example.com',
      attendees: ['mailto:bob@example.com'],
      recurrenceId: null,
      recurrenceRule: null,
      excluded: [],
      sequence: 0,
      updatedAt: '2026-11-06T00:00:00.000Z',
    };

    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      const written = await write(
        record({
          space,
          repo: authority.did,
          collection: 'ing.lexicon.calendar.event',
          rkey: 'planning',
          value: event,
        }),
        authority.accessJwt,
      );
      expect(written.status).toBe(200);

      const lens = await write(
        record({
          space,
          repo: authority.did,
          collection: 'ing.lexicon.lens',
          rkey: 'ing.lexicon.calendar.event',
          value: {
            $type: 'ing.lexicon.lens',
            fields: ['/uid', '/summary', '/start', '/end'],
            description: 'what a public calendar shows',
            issuedBy: authority.did,
            createdAt: new Date().toISOString(),
          },
        }),
        authority.accessJwt,
      );
      expect(lens.status).toBe(200);

      const granted = await write(
        record({
          space,
          repo: authority.did,
          collection: GRANT,
          rkey: 'public-calendar',
          value: {
            ...grantFor({
              space,
              subject: reader.did,
              issuedBy: authority.did,
              selector: { collection: 'ing.lexicon.calendar.event' },
            }),
            lens: {
              nsid: 'ing.lexicon.calendar.event',
              cid: String(lens.body['cid']),
            },
          },
        }),
        authority.accessJwt,
      );
      expect(granted.status).toBe(200);

      const listed = await get(
        `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=ing.lexicon.calendar.event`,
        reader.accessJwt,
      );
      expect(listed.status).toBe(200);
      const records = listed.body['records'] as ReadonlyArray<{
        value: Record<string, Schema.Json>;
      }>;
      // Exactly the four fields: no `raw` (the whole VEVENT), no `attendees`,
      // no `organizer`, and no `href` (the resource path is the person's).
      expect(records.map((one) => one.value)).toEqual([
        {
          $type: 'ing.lexicon.calendar.event',
          uid: 'planning@example.com',
          summary: 'Planning',
          start: '2026-11-07T10:00:00.000Z',
          end: '2026-11-07T11:00:00.000Z',
        },
      ]);
    });
  });

  it('answers a grant decision for a service fronting the space', async () => {
    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      const ask = (action: 'view' | 'write', jwt: string) =>
        get(
          `com.atproto.space.checkAccess?space=${encodeURIComponent(space)}&action=${action}&collection=com.example.note`,
          jwt,
        );

      // No grant yet: a denial, not an error.
      const denied = await ask('view', reader.accessJwt);
      expect(denied.status).toBe(200);
      expect(denied.body['allow']).toBe(false);
      expect(String(denied.body['reason'])).toContain('no-grant');

      const granted = await write(
        record({
          space,
          repo: authority.did,
          collection: GRANT,
          rkey: 'to-bob',
          value: grantFor({
            space,
            subject: reader.did,
            issuedBy: authority.did,
            selector: { collection: 'com.example.note' },
          }),
        }),
        authority.accessJwt,
      );
      expect(granted.status).toBe(200);

      const allowed = await ask('view', reader.accessJwt);
      expect(allowed.body['allow']).toBe(true);
      // A `view` grant is not a write grant.
      expect((await ask('write', reader.accessJwt)).body['allow']).toBe(false);
      // The authority is not special-cased: the answer is the grant's.
      expect((await ask('view', authority.accessJwt)).body['allow']).toBe(
        false,
      );
    });
  });

  it('refuses a repo that no grant covers', async () => {
    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      await write(
        record({
          space,
          repo: authority.did,
          collection: 'com.example.note',
          rkey: 'one',
          value: note('one'),
        }),
        authority.accessJwt,
      );

      const listed = await get(
        `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`,
        reader.accessJwt,
      );
      expect(listed.status).toBe(403);
      expect(String(listed.body['message'])).toContain('no-grant');
    });
  });

  it('shares one exact record, not its neighbours', async () => {
    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      for (const rkey of ['one', 'two']) {
        await write(
          record({
            space,
            repo: authority.did,
            collection: 'com.example.note',
            rkey,
            value: note(rkey),
          }),
          authority.accessJwt,
        );
      }
      await write(
        record({
          space,
          repo: authority.did,
          collection: GRANT,
          rkey: 'one-only',
          value: grantFor({
            space,
            subject: reader.did,
            issuedBy: authority.did,
            // The cid is not part of matching (the uri is), so any well-formed one will do.
            selector: {
              record: {
                uri: `at://${authority.did}/com.example.note/one`,
                cid: A_CID,
              },
            },
          }),
        }),
        authority.accessJwt,
      );

      const one = await get(
        `com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note&rkey=one`,
        reader.accessJwt,
      );
      expect(one.status).toBe(200);

      const two = await get(
        `com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note&rkey=two`,
        reader.accessJwt,
      );
      expect(two.status).toBe(403);
    });
  });

  it('honours a revocation: the grant is still there, and the log says it is dead', async () => {
    await withGrantedSpace(async ({ space, authority, reader, write, get }) => {
      await write(
        record({
          space,
          repo: authority.did,
          collection: 'com.example.note',
          rkey: 'one',
          value: note('one'),
        }),
        authority.accessJwt,
      );
      const granted = await write(
        record({
          space,
          repo: authority.did,
          collection: GRANT,
          rkey: 'revoked',
          value: grantFor({
            space,
            subject: reader.did,
            issuedBy: authority.did,
            selector: { collection: 'com.example.note' },
          }),
        }),
        authority.accessJwt,
      );
      expect(granted.status).toBe(200);

      await write(
        record({
          space,
          repo: authority.did,
          collection: REVOKE,
          rkey: 'bye',
          value: {
            $type: REVOKE,
            grant: {
              uri: `at://${authority.did}/${GRANT}/revoked`,
              cid: String(granted.body['cid'] ?? A_CID),
            },
            revokedAt: new Date().toISOString(),
          },
        }),
        authority.accessJwt,
      );

      const listed = await get(
        `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`,
        reader.accessJwt,
      );
      expect(listed.status).toBe(403);
      expect(String(listed.body['message'])).toContain('revoked');
    });
  });

  it("ignores a grant written into a member's own repo", async () => {
    // A space the reader can write into, so a self-grant is even possible: only the authority's
    // repo is ever read for grants, so this one changes nothing.
    await withGrantedSpace(
      async ({ space, authority, reader, write, get }) => {
        await write(
          record({
            space,
            repo: authority.did,
            collection: 'com.example.note',
            rkey: 'one',
            value: note('one'),
          }),
          authority.accessJwt,
        );
        const selfGranted = await write(
          record({
            space,
            repo: reader.did,
            collection: GRANT,
            rkey: 'self',
            value: grantFor({
              space,
              subject: reader.did,
              issuedBy: reader.did,
              selector: { collection: 'com.example.note' },
            }),
          }),
          reader.accessJwt,
        );
        expect(selfGranted.status).toBe(200);

        const listed = await get(
          `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`,
          reader.accessJwt,
        );
        expect(listed.status).toBe(403);
        expect(String(listed.body['message'])).toContain('no-grant');
      },
      // `publicWrite` so the self-grant is even possible; `publicRead` stays off, so the only thing
      // that could let bob read is a grant — which is the claim under test.
      {
        $type: 'com.atproto.memberspace.policy',
        publicWrite: true,
      },
    );
  });
});

describe('membership and the space policy', () => {
  /** A PDS with an authority and somebody who is not a member of anything yet. */
  const withMemberspace = async (
    options: {
      readonly policy?: Record<string, Schema.Json>;
      /** Serve Jetstream too, so the HTTP space mode can be read the way a client reads it. */
      readonly jetstream?: boolean;
    },
    run: (params: {
      readonly url: string;
      readonly space: string;
      readonly authority: Account;
      readonly member: Account;
      /** The space's own stream, so a test can hear what a write announced. */
      readonly firehose: Firehose['Service'];
      /** The server, whose `streamOf` is how a socket's handler is reached. */
      readonly server: ReturnType<typeof createPdsServer>;
      readonly call: (
        path: string,
        body: Record<string, Schema.Json>,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
      readonly exportMeta: (jwt: string) => Promise<Uint8Array>;
    }) => Promise<void>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds({
            jetstream: options.jetstream ?? false,
          });
          const authority = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const member = yield* Effect.promise(() =>
            createAccount(pds.url, 'bob.pds.test'),
          );
          const space = `at://${authority.did}/${SPACE_TYPE}/club`;
          const created = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createSpace`,
              authority.accessJwt,
              {
                spaceType: SPACE_TYPE,
                skey: 'club',
                policy: options.policy ?? {
                  $type: 'com.atproto.memberspace.policy',
                },
              },
            ),
          );
          expect(created.status).toBe(200);
          yield* Effect.promise(() =>
            run({
              url: pds.url,
              space,
              authority,
              member,
              firehose: pds.firehose,
              server: pds.server,
              call: (path, body, jwt) =>
                postJson(`${pds.url}/xrpc/${path}`, jwt, body),
              exportMeta: async (jwt) => {
                const response = await fetch(
                  `${pds.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(space)}`,
                  { headers: { authorization: `Bearer ${jwt}` } },
                );
                expect(response.status).toBe(200);
                return new Uint8Array(await response.arrayBuffer());
              },
            }),
          );
        }),
      ),
    );

  const note = (rkey: string) => ({
    $type: 'com.example.note',
    text: rkey,
  });

  /**
   * Read NDJSON frames from a Jetstream stream until `enough` is satisfied, then hang up. A refusal is
   * returned as it arrived — status and text — because that is the whole claim: no frame follows it.
   */
  const readFrames = async (
    url: string,
    jwt: string | undefined,
    enough: (frames: ReadonlyArray<Record<string, Schema.Json>>) => boolean,
  ) => {
    const controller = new AbortController();
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        ...(jwt === undefined
          ? {}
          : { headers: { authorization: `Bearer ${jwt}` } }),
      });
      if (response.status !== 200) {
        return {
          status: response.status,
          frames: [] as Array<Record<string, Schema.Json>>,
          text: await response.text(),
        };
      }
      const frames: Array<Record<string, Schema.Json>> = [];
      const reader = response.body?.getReader();
      let held = '';
      while (reader !== undefined && !enough(frames)) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        held += new TextDecoder().decode(chunk.value);
        const lines = held.split('\n');
        held = lines.pop() ?? '';
        for (const line of lines) {
          if (line !== '') {
            frames.push(JSON.parse(line) as Record<string, Schema.Json>);
          }
        }
      }
      return { status: response.status, frames, text: '' };
    } finally {
      controller.abort();
    }
  };

  const writeAs = (
    call: (
      path: string,
      body: Record<string, Schema.Json>,
      jwt: string,
    ) => Promise<{
      readonly status: number;
      readonly body: Record<string, Schema.Json>;
    }>,
    params: { space: string; did: string; rkey: string; jwt: string },
  ) =>
    call(
      'com.atproto.space.createRecord',
      {
        space: params.space,
        repo: params.did,
        collection: 'com.example.note',
        rkey: params.rkey,
        record: note(params.rkey) as Schema.Json,
      },
      params.jwt,
    );

  it('refuses a member list on a policy that keeps none', async () => {
    await withMemberspace(
      { policy: { $type: 'com.atproto.personalspace.policy' } },
      async ({ space, authority, member, call }) => {
        const put = await call(
          'com.atproto.memberspace.putMember',
          { space, did: member.did, read: true, write: true },
          authority.accessJwt,
        );
        expect(put.status).toBe(400);
        expect(String(put.body['message'])).toContain('keeps no member list');
      },
    );
  });

  it('lets the authority add a member, and write is the flag that grants writing', async () => {
    await withMemberspace({}, async ({ space, authority, member, call }) => {
      const added = await call(
        'com.atproto.memberspace.putMember',
        { space, did: member.did, read: true, write: true },
        authority.accessJwt,
      );
      expect(added.status).toBe(200);

      const wrote = await writeAs(call, {
        space,
        did: member.did,
        rkey: 'one',
        jwt: member.accessJwt,
      });
      expect(wrote.status).toBe(200);

      // The write flag, taken away: the entry stays. `read` is the flag a credential is minted
      // against (space.ts still passes `member: undefined`, so nothing consults it yet); `write` is
      // the one the space asks on every write, which is what this test can see.
      const downgraded = await call(
        'com.atproto.memberspace.putMember',
        { space, did: member.did, read: true, write: false },
        authority.accessJwt,
      );
      expect(downgraded.status).toBe(200);
      const refused = await writeAs(call, {
        space,
        did: member.did,
        rkey: 'two',
        jwt: member.accessJwt,
      });
      expect(refused.status).toBe(403);
      expect(String(refused.body['message'])).toContain('member-has-no-write');

      const listed = await call(
        'com.atproto.memberspace.listMembers',
        { space },
        authority.accessJwt,
      );
      expect(listed.status).toBe(200);
      expect(listed.body['members']).toEqual([
        { did: member.did, read: true, write: false },
      ]);
    });
  });

  it('refuses a non-member, and removing one is a no-op rather than a revision', async () => {
    await withMemberspace(
      {},
      async ({ space, authority, member, call, exportMeta }) => {
        const wrote = await writeAs(call, {
          space,
          did: member.did,
          rkey: 'one',
          jwt: member.accessJwt,
        });
        expect(wrote.status).toBe(403);
        expect(String(wrote.body['message'])).toContain('not-a-member');

        const before = await exportMeta(authority.accessJwt);
        const removed = await call(
          'com.atproto.memberspace.removeMember',
          { space, did: member.did },
          authority.accessJwt,
        );
        expect(removed.status).toBe(200);
        // Nothing to remove means nothing written: the archive a mover carries is unchanged.
        expect(await exportMeta(authority.accessJwt)).toEqual(before);

        // The list is the authority's: somebody else is told the space is not theirs to administer.
        const foreign = await call(
          'com.atproto.memberspace.putMember',
          { space, did: authority.did, read: true, write: true },
          member.accessJwt,
        );
        expect(foreign.status).toBe(400);
        expect(String(foreign.body['error'])).toBe('NotSpaceOwner');
      },
    );
  });

  it("reads another account's repo as a member, and stops when the flag goes away", async () => {
    await withMemberspace({}, async ({ space, authority, member, call }) => {
      expect(
        (
          await writeAs(call, {
            space,
            did: authority.did,
            rkey: 'one',
            jwt: authority.accessJwt,
          })
        ).status,
      ).toBe(200);
      const listed = `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`;

      // `read: true` is the policy saying yes: no grant, no per-collection decision.
      expect(
        (
          await call(
            'com.atproto.memberspace.putMember',
            { space, did: member.did, read: true, write: false },
            authority.accessJwt,
          )
        ).status,
      ).toBe(200);
      const visible = await call(listed, {}, member.accessJwt);
      expect(visible.status).toBe(200);
      expect((visible.body['records'] as ReadonlyArray<unknown>).length).toBe(
        1,
      );

      // The flag is the whole permission: taken away, the same read is refused — and says which
      // answer refused it, because "no grant" alone would be the wrong sentence.
      expect(
        (
          await call(
            'com.atproto.memberspace.putMember',
            { space, did: member.did, read: false, write: true },
            authority.accessJwt,
          )
        ).status,
      ).toBe(200);
      const refused = await call(listed, {}, member.accessJwt);
      expect(refused.status).toBe(403);
      expect(String(refused.body['message'])).toContain('member-has-no-read');
    });
  });

  it('lists the repos that have written, to those who may see the space', async () => {
    await withMemberspace({}, async ({ space, authority, member, call }) => {
      const listed = `com.atproto.space.listRepos?space=${encodeURIComponent(space)}`;
      expect(
        (
          await call(
            'com.atproto.memberspace.putMember',
            { space, did: member.did, read: true, write: true },
            authority.accessJwt,
          )
        ).status,
      ).toBe(200);
      for (const [account, rkey] of [
        [authority, 'one'],
        [member, 'two'],
      ] as const) {
        expect(
          (
            await writeAs(call, {
              space,
              did: account.did,
              rkey,
              jwt: account.accessJwt,
            })
          ).status,
        ).toBe(200);
      }

      // Both repos are there, and this is the write log's answer — the archive's `writers` is empty,
      // because nothing was imported.
      const asAuthority = await call(listed, {}, authority.accessJwt);
      expect(asAuthority.status).toBe(200);
      const repos = asAuthority.body['repos'] as ReadonlyArray<{
        did: string;
        rev: string;
        head: string;
      }>;
      expect(repos.map((one) => one.did)).toEqual(
        [authority.did, member.did].sort(),
      );
      expect(repos.every((one) => one.rev.length > 0)).toBe(true);
      expect(repos.every((one) => one.head.length > 0)).toBe(true);

      // A member reads the list; the read flag taken away takes it away.
      expect((await call(listed, {}, member.accessJwt)).status).toBe(200);
      expect(
        (
          await call(
            'com.atproto.memberspace.putMember',
            { space, did: member.did, read: false, write: true },
            authority.accessJwt,
          )
        ).status,
      ).toBe(200);
      const refused = await call(listed, {}, member.accessJwt);
      expect(refused.status).toBe(403);
      expect(String(refused.body['message'])).toContain('member-has-no-read');
    });
  });

  it('reads a space that publishes its read, with no membership at all', async () => {
    await withMemberspace(
      { policy: { $type: 'com.atproto.memberspace.policy', publicRead: true } },
      async ({ space, authority, member, call }) => {
        expect(
          (
            await writeAs(call, {
              space,
              did: authority.did,
              rkey: 'one',
              jwt: authority.accessJwt,
            })
          ).status,
        ).toBe(200);
        const visible = await call(
          `com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.example.note`,
          {},
          member.accessJwt,
        );
        expect(visible.status).toBe(200);
        // `publicRead` is the policy answering, so the repo list is open to the same reader.
        const repos = await call(
          `com.atproto.space.listRepos?space=${encodeURIComponent(space)}`,
          {},
          member.accessJwt,
        );
        expect(repos.status).toBe(200);
        expect(
          (repos.body['repos'] as ReadonlyArray<{ did: string }>).map(
            (one) => one.did,
          ),
        ).toEqual([authority.did]);
      },
    );
  });

  it('keeps the member list across a policy change of the same kind', async () => {
    await withMemberspace(
      {},
      async ({ space, authority, member, call, exportMeta }) => {
        expect(
          (
            await call(
              'com.atproto.memberspace.putMember',
              { space, did: member.did, read: true, write: true },
              authority.accessJwt,
            )
          ).status,
        ).toBe(200);
        const before = await exportMeta(authority.accessJwt);

        const updated = await call(
          'com.atproto.space.updateSpace',
          {
            space,
            policy: {
              $type: 'com.atproto.memberspace.policy',
              publicWrite: true,
            },
          },
          authority.accessJwt,
        );
        expect(updated.status).toBe(200);

        // The same kind of policy is configuration: the members are the space's, not the policy's.
        const listed = await call(
          'com.atproto.memberspace.listMembers',
          { space },
          authority.accessJwt,
        );
        expect(listed.body['members']).toEqual([
          { did: member.did, read: true, write: true },
        ]);
        const after = await exportMeta(authority.accessJwt);
        expect(after).not.toEqual(before);

        // The same update again is the same archive: a retry is not a revision.
        const again = await call(
          'com.atproto.space.updateSpace',
          {
            space,
            policy: {
              $type: 'com.atproto.memberspace.policy',
              publicWrite: true,
            },
          },
          authority.accessJwt,
        );
        expect(again.status).toBe(200);
        expect(await exportMeta(authority.accessJwt)).toEqual(after);
      },
    );
  });

  it('migrates the space, which discards the member list and its records', async () => {
    await withMemberspace(
      {
        policy: {
          $type: 'com.atproto.memberspace.policy',
          publishMembers: true,
        },
      },
      async ({ space, authority, member, call }) => {
        expect(
          (
            await call(
              'com.atproto.memberspace.putMember',
              { space, did: member.did, read: true, write: true },
              authority.accessJwt,
            )
          ).status,
        ).toBe(200);
        const publishedPath = `com.atproto.space.getRecord?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.atproto.memberspace.member&rkey=${member.did}`;
        expect(
          (await call(publishedPath, {}, authority.accessJwt)).status,
        ).toBe(200);

        const migrated = await call(
          'com.atproto.space.updateSpace',
          { space, policy: { $type: 'com.atproto.personalspace.policy' } },
          authority.accessJwt,
        );
        expect(migrated.status).toBe(200);

        // A member list does not survive a migration…
        const listed = await call(
          'com.atproto.memberspace.listMembers',
          { space },
          authority.accessJwt,
        );
        expect(listed.body['members']).toEqual([]);
        // …the member's write is the authority's again…
        const wrote = await writeAs(call, {
          space,
          did: member.did,
          rkey: 'after-migration',
          jwt: member.accessJwt,
        });
        expect(wrote.status).toBe(403);
        expect(String(wrote.body['message'])).toContain('only-the-authority');
        // …and the record it published is gone with it.
        const gone = await call(publishedPath, {}, authority.accessJwt);
        expect(gone.status).toBe(400);
        expect(String(gone.body['error'])).toBe('RecordNotFound');
      },
    );
  });

  it('refuses a policy it does not implement, and a caller who is not the authority', async () => {
    await withMemberspace({}, async ({ space, authority, member, call }) => {
      const unsupported = await call(
        'com.atproto.space.updateSpace',
        { space, policy: { $type: 'com.example.policy' } },
        authority.accessJwt,
      );
      expect(unsupported.status).toBe(400);
      expect(String(unsupported.body['error'])).toBe('UnsupportedPolicy');

      const foreign = await call(
        'com.atproto.space.updateSpace',
        { space, policy: { $type: 'com.atproto.personalspace.policy' } },
        member.accessJwt,
      );
      expect(foreign.status).toBe(400);
      expect(String(foreign.body['error'])).toBe('NotSpaceOwner');
    });
  });

  it('answers a caller what it is in the space: its grants and its own entry', async () => {
    await withMemberspace({}, async ({ space, authority, member, call }) => {
      const granted = await call(
        'com.atproto.memberspace.putMember',
        { space, did: member.did, read: true, write: true },
        authority.accessJwt,
      );
      expect(granted.status).toBe(200);

      const grant = await call(
        'com.atproto.space.createRecord',
        {
          space,
          repo: authority.did,
          collection: 'ing.lexicon.grant',
          rkey: 'to-bob',
          record: {
            $type: 'ing.lexicon.grant',
            space,
            subject: member.did,
            selectors: [{ collection: 'com.example.note' }],
            actions: ['view'],
            issuedBy: authority.did,
            createdAt: '2026-10-31T00:00:00.000Z',
          },
        },
        authority.accessJwt,
      );
      expect(grant.status).toBe(200);

      // The member's own answer: the entry and the grant naming it, with no second request and no
      // grant over `ing.lexicon.grant` to make the grant readable.
      const own = await call(
        'com.atproto.space.getAccess',
        { space },
        member.accessJwt,
      );
      expect(own.status).toBe(200);
      expect(own.body['did']).toBe(member.did);
      expect(own.body['member']).toEqual({ read: true, write: true });
      const grants = own.body['grants'] as ReadonlyArray<{
        uri: string;
        revoked: boolean;
        value: { subject: string };
      }>;
      expect(grants).toHaveLength(1);
      expect(grants[0]?.uri).toBe(
        `at://${authority.did}/ing.lexicon.grant/to-bob`,
      );
      expect(grants[0]?.revoked).toBe(false);
      expect(grants[0]?.value.subject).toBe(member.did);

      // The authority is nobody's subject: it has no member entry and nothing names it.
      const asAuthority = await call(
        'com.atproto.space.getAccess',
        { space },
        authority.accessJwt,
      );
      expect(asAuthority.status).toBe(200);
      expect(asAuthority.body['member']).toBeUndefined();
      expect(asAuthority.body['grants']).toEqual([]);

      // A revoked grant is still the member's business: it was granted, then revoked, and that is a
      // different sentence from "never granted".
      const revoked = await call(
        'com.atproto.space.createRecord',
        {
          space,
          repo: authority.did,
          collection: 'ing.lexicon.grant.revoke',
          rkey: 'bye',
          record: {
            $type: 'ing.lexicon.grant.revoke',
            grant: {
              uri: `at://${authority.did}/ing.lexicon.grant/to-bob`,
              cid: String(
                (grant.body as { cid: string }).cid ??
                  'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              ),
            },
            revokedAt: '2026-10-31T00:01:00.000Z',
          },
        },
        authority.accessJwt,
      );
      expect(revoked.status).toBe(200);
      const after = await call(
        'com.atproto.space.getAccess',
        { space },
        member.accessJwt,
      );
      expect(after.status).toBe(200);
      const still = after.body['grants'] as ReadonlyArray<{
        revoked: boolean;
      }>;
      expect(still).toHaveLength(1);
      expect(still[0]?.revoked).toBe(true);
    });
  });

  it("removes the member's entry and the writer row in one write", async () => {
    await withMemberspace(
      {},
      async ({ url, space, authority, member, call, exportMeta }) => {
        // The archive an import leaves: a member and the writer row that came with them.
        const bytes = await metaArchive({
          space,
          policy: MEMBER_POLICY,
          state: [memberState(member.did)],
          writers: [
            {
              did: member.did,
              rev: tid(1),
              data: new Uint8Array(32),
              spaceRev: tid(1),
            },
          ],
        });
        const imported = await postRaw(
          `${url}/xrpc/com.atproto.space.importSpaceMeta`,
          bytes,
          authority.accessJwt,
        );
        expect(imported.status).toBe(200);

        const listed = await call(
          'com.atproto.memberspace.listMembers',
          { space },
          authority.accessJwt,
        );
        expect(listed.body['members']).toEqual([
          { did: member.did, read: true, write: false },
        ]);

        const removed = await call(
          'com.atproto.memberspace.removeMember',
          { space, did: member.did },
          authority.accessJwt,
        );
        expect(removed.status).toBe(200);

        const archive = await Effect.runPromise(
          parseSpaceMetaStar(await exportMeta(authority.accessJwt)),
        );
        expect(archive.policyState).toEqual([]);
        expect(archive.writers).toEqual([]);
      },
    );
  });

  it('puts exactly one frame on the space stream for each write action', async () => {
    await withMemberspace({}, async ({ space, authority, call, firehose }) => {
      // The position before the first write: what replays after it is these three ops and nothing
      // else, so the count is the claim.
      const from = await Effect.runPromise(firehose.head);
      expect(
        (
          await writeAs(call, {
            space,
            did: authority.did,
            rkey: 'one',
            jwt: authority.accessJwt,
          })
        ).status,
      ).toBe(200);
      const updated = await call(
        'com.atproto.space.applyWrites',
        {
          space,
          repo: authority.did,
          writes: [
            {
              $type: 'com.atproto.space.applyWrites#update',
              collection: 'com.example.note',
              rkey: 'one',
              value: note('one, revised') as Schema.Json,
            },
          ],
        },
        authority.accessJwt,
      );
      expect(updated.status).toBe(200);
      const removed = await call(
        'com.atproto.space.deleteRecord',
        {
          space,
          repo: authority.did,
          collection: 'com.example.note',
          rkey: 'one',
        },
        authority.accessJwt,
      );
      expect(removed.status).toBe(200);

      const frames = [
        ...(await Effect.runPromise(
          firehose
            .subscribeSpaces({ spaces: [space], cursor: from.timeUs })
            .pipe(Stream.take(3), Stream.runCollect),
        )),
      ];
      expect(frames.map((frame) => frame.action)).toEqual([
        'create',
        'update',
        'delete',
      ]);
      expect(frames.map((frame) => frame.rkey)).toEqual(['one', 'one', 'one']);
      // The record rides the frame as JSON; a delete leaves nothing to carry.
      expect(frames[0]?.value).toEqual({
        $type: 'com.example.note',
        text: 'one',
      });
      expect(frames[1]?.value).toEqual({
        $type: 'com.example.note',
        text: 'one, revised',
      });
      expect(frames[2]?.value).toBeUndefined();
    });
  });

  it('serves the space stream to a reader of the space, and refuses one with a frame', async () => {
    await withMemberspace(
      {},
      async ({ space, authority, member, call, server }) => {
        expect(
          (
            await writeAs(call, {
              space,
              did: authority.did,
              rkey: 'one',
              jwt: authority.accessJwt,
            })
          ).status,
        ).toBe(200);

        const stream = server.streamOf('com.atproto.space.subscribeRepos');
        if (stream === undefined) {
          throw new Error('the space stream is not registered');
        }
        const framesOf = async (jwt: string | undefined) => {
          const frames = await Effect.runPromise(
            stream({
              params: { space, cursor: '0' },
              nsid: 'com.atproto.space.subscribeRepos',
              method: 'GET',
              url: `/xrpc/com.atproto.space.subscribeRepos?space=${encodeURIComponent(space)}&cursor=0`,
              headers:
                jwt === undefined ? {} : { authorization: `Bearer ${jwt}` },
            }).pipe(Stream.take(1), Stream.runCollect),
          );
          return [...frames].map(
            (frame) =>
              JSON.parse(new TextDecoder().decode(frame)) as Record<
                string,
                Schema.Json
              >,
          );
        };

        // The authority reads the space, so its subscription replays the write that just landed —
        // the record as JSON, which is the whole frame: no CAR to unpack.
        const heard = await framesOf(authority.accessJwt);
        expect(heard).toHaveLength(1);
        expect(heard[0]).toMatchObject({
          kind: 'space',
          space,
          did: authority.did,
          action: 'create',
          rkey: 'one',
          value: { text: 'one' },
        });

        // And somebody who is not in the space is told why in one frame, because a socket has no
        // status to carry it.
        const refused = await framesOf(member.accessJwt);
        expect(String(refused[0]?.['error'])).toBe('NotAuthorized');
        expect(String(refused[0]?.['message'])).toContain('not-a-member');
      },
    );
  });

  it('serves a space over Jetstream, replays it from a cursor, and keeps it off the public stream', async () => {
    await withMemberspace(
      { jetstream: true },
      async ({ url, space, authority, call, firehose }) => {
        const from = await Effect.runPromise(firehose.head);
        expect(
          (
            await writeAs(call, {
              space,
              did: authority.did,
              rkey: 'one',
              jwt: authority.accessJwt,
            })
          ).status,
        ).toBe(200);
        // A public write after the space's, so the public stream has a frame to stop at: if the
        // space's write leaked, it would arrive first.
        const published = await call(
          'com.atproto.repo.createRecord',
          {
            repo: authority.did,
            collection: 'app.example.note',
            record: { $type: 'app.example.note', text: 'public' },
          },
          authority.accessJwt,
        );
        expect(published.status).toBe(200);

        const spaceStream = await readFrames(
          `${url}/jetstream/subscribe?space=${encodeURIComponent(space)}&cursor=${from.timeUs}`,
          authority.accessJwt,
          (frames) => frames.length >= 1,
        );
        expect(spaceStream.status).toBe(200);
        expect(spaceStream.frames[0]).toMatchObject({
          kind: 'space',
          space,
          did: authority.did,
          action: 'create',
          rkey: 'one',
          value: { text: 'one' },
        });
        // Replayed from the cursor it was given: the write happened before the stream was opened.
        expect(Number(spaceStream.frames[0]?.['timeUs'])).toBeGreaterThan(
          from.timeUs,
        );

        const publicStream = await readFrames(
          `${url}/jetstream/subscribe?cursor=${from.timeUs}`,
          undefined,
          (frames) => frames.some((frame) => frame['kind'] === 'commit'),
        );
        expect(publicStream.frames.map((frame) => frame['kind'])).not.toContain(
          'space',
        );
      },
    );
  });

  it('refuses Jetstream space mode before the body when the caller is missing or unwelcome', async () => {
    await withMemberspace(
      { jetstream: true },
      async ({ url, space, member }) => {
        const unauthenticated = await readFrames(
          `${url}/jetstream/subscribe?space=${encodeURIComponent(space)}`,
          undefined,
          () => false,
        );
        // A status and a sentence, no frame: the same rule as a refused cursor.
        expect(unauthenticated.status).toBe(401);
        expect(unauthenticated.frames).toEqual([]);
        expect(unauthenticated.text).toContain('credential');

        const unwelcome = await readFrames(
          `${url}/jetstream/subscribe?space=${encodeURIComponent(space)}`,
          member.accessJwt,
          () => false,
        );
        expect(unwelcome.status).toBe(403);
        expect(unwelcome.frames).toEqual([]);
        // A refusal names the space it is about, so a client can drop the right one.
        expect(unwelcome.text).toContain(space);
      },
    );
  });

  it('follows several spaces in one Jetstream stream, in the window order', async () => {
    await withMemberspace(
      { jetstream: true },
      async ({ url, space, authority, call, firehose }) => {
        const annex = `at://${authority.did}/${SPACE_TYPE}/annex`;
        expect(
          (
            await call(
              'com.atproto.space.createSpace',
              {
                spaceType: SPACE_TYPE,
                skey: 'annex',
                policy: { $type: 'com.atproto.memberspace.policy' },
              },
              authority.accessJwt,
            )
          ).status,
        ).toBe(200);

        const from = await Effect.runPromise(firehose.head);
        for (const [one, rkey] of [
          [space, 'club'],
          [annex, 'annex'],
        ] as const) {
          expect(
            (
              await writeAs(call, {
                space: one,
                did: authority.did,
                rkey,
                jwt: authority.accessJwt,
              })
            ).status,
          ).toBe(200);
        }

        const heard = await readFrames(
          `${url}/jetstream/subscribe?space=${encodeURIComponent(space)}&space=${encodeURIComponent(annex)}&cursor=${from.timeUs}`,
          authority.accessJwt,
          (frames) => frames.length >= 2,
        );
        expect(heard.status).toBe(200);
        expect(heard.frames.map((frame) => frame['space'])).toEqual([
          space,
          annex,
        ]);
        // One window, one order: the two spaces' frames do not interleave by stream.
        const times = heard.frames.map((frame) => Number(frame['timeUs']));
        expect(times).toEqual([...times].sort((left, right) => left - right));
      },
    );
  });
});

describe('the publication records', () => {
  /** The record at `collection/rkey` in the authority's repo, as the authority reads it. */
  const read = (
    call: (
      path: string,
      body: Record<string, Schema.Json>,
      jwt: string,
    ) => Promise<{
      readonly status: number;
      readonly body: Record<string, Schema.Json>;
    }>,
    params: {
      readonly space: string;
      readonly repo: string;
      readonly collection: string;
      readonly rkey: string;
      readonly jwt: string;
    },
  ) =>
    call(
      `com.atproto.space.getRecord?space=${encodeURIComponent(params.space)}&repo=${params.repo}&collection=${params.collection}&rkey=${params.rkey}`,
      {},
      params.jwt,
    );

  const published = {
    $type: 'com.atproto.memberspace.policy',
    publishPolicy: true,
    publishMembers: true,
  };

  it('publishes the member list and the policy, and takes the member back on removal', async () => {
    // The same fixture as the member tests, with the two publication switches on.
    const withPublication = async (
      run: (params: {
        readonly space: string;
        readonly authority: Account;
        readonly member: Account;
        readonly call: (
          path: string,
          body: Record<string, Schema.Json>,
          jwt: string,
        ) => Promise<{
          readonly status: number;
          readonly body: Record<string, Schema.Json>;
        }>;
      }) => Promise<void>,
    ) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pds = yield* startMemoryPds();
            const authority = yield* Effect.promise(() =>
              createAccount(pds.url, 'alice.pds.test'),
            );
            const member = yield* Effect.promise(() =>
              createAccount(pds.url, 'bob.pds.test'),
            );
            const space = `at://${authority.did}/${SPACE_TYPE}/club`;
            const created = yield* Effect.promise(() =>
              postJson(
                `${pds.url}/xrpc/com.atproto.space.createSpace`,
                authority.accessJwt,
                {
                  spaceType: SPACE_TYPE,
                  skey: 'club',
                  policy: published as Schema.Json,
                },
              ),
            );
            expect(created.status).toBe(200);
            yield* Effect.promise(() =>
              run({
                space,
                authority,
                member,
                call: (path, body, jwt) =>
                  postJson(`${pds.url}/xrpc/${path}`, jwt, body),
              }),
            );
          }),
        ),
      );

    await withPublication(async ({ space, authority, member, call }) => {
      const added = await call(
        'com.atproto.memberspace.putMember',
        { space, did: member.did, read: true, write: true },
        authority.accessJwt,
      );
      expect(added.status).toBe(200);

      // The member, as a record a reader can find — the point of the switch.
      const entry = await read(call, {
        space,
        repo: authority.did,
        collection: 'com.atproto.memberspace.member',
        rkey: member.did,
        jwt: authority.accessJwt,
      });
      expect(entry.status).toBe(200);
      expect(entry.body['value']).toEqual({
        $type: 'com.atproto.memberspace.member',
        read: true,
        write: true,
      });

      // …and the policy beside it, because the same policy asked for that too.
      const policy = await read(call, {
        space,
        repo: authority.did,
        collection: 'com.atproto.space.policy',
        rkey: 'self',
        jwt: authority.accessJwt,
      });
      expect(policy.status).toBe(200);
      expect(
        (policy.body['value'] as { policy: Record<string, Schema.Json> })
          .policy['$type'],
      ).toBe('com.atproto.memberspace.policy');

      const removed = await call(
        'com.atproto.memberspace.removeMember',
        { space, did: member.did },
        authority.accessJwt,
      );
      expect(removed.status).toBe(200);

      // A removed member left behind as a record would be stale access: it is deleted.
      const gone = await read(call, {
        space,
        repo: authority.did,
        collection: 'com.atproto.memberspace.member',
        rkey: member.did,
        jwt: authority.accessJwt,
      });
      expect(gone.status).toBe(400);
      expect(String(gone.body['error'])).toBe('RecordNotFound');
    });
  });

  it('publishes nothing when the policy does not ask', async () => {
    const program = Effect.gen(function* () {
      const pds = yield* startMemoryPds();
      const authority = yield* Effect.promise(() =>
        createAccount(pds.url, 'alice.pds.test'),
      );
      const member = yield* Effect.promise(() =>
        createAccount(pds.url, 'bob.pds.test'),
      );
      const space = `at://${authority.did}/${SPACE_TYPE}/quiet`;
      expect(
        (yield* Effect.promise(() =>
          postJson(
            `${pds.url}/xrpc/com.atproto.space.createSpace`,
            authority.accessJwt,
            {
              spaceType: SPACE_TYPE,
              skey: 'quiet',
              policy: { $type: 'com.atproto.memberspace.policy' },
            },
          ),
        )).status,
      ).toBe(200);
      expect(
        (yield* Effect.promise(() =>
          postJson(
            `${pds.url}/xrpc/com.atproto.memberspace.putMember`,
            authority.accessJwt,
            { space, did: member.did, read: true, write: true },
          ),
        )).status,
      ).toBe(200);
      const listed = yield* Effect.promise(async () => {
        const response = await fetch(
          `${pds.url}/xrpc/com.atproto.space.listRecords?space=${encodeURIComponent(space)}&repo=${authority.did}&collection=com.atproto.memberspace.member`,
          { headers: { authorization: `Bearer ${authority.accessJwt}` } },
        );
        return {
          status: response.status,
          body: (await response.json()) as Record<string, Schema.Json>,
        };
      });
      return listed;
    });
    const listed = await Effect.runPromise(Effect.scoped(program));
    // Nothing was published, so the authority has no repo in this space at all — the strongest
    // statement "nothing was written" can make.
    expect(listed.status).toBe(400);
    expect(String(listed.body['error'])).toBe('RepoNotFound');
  });
});

describe('space blobs', () => {
  const GRANT = 'ing.lexicon.grant';

  /** One grant naming a collection, as the authority writes it into its own repo in the space. */
  const grant = (params: {
    readonly space: string;
    readonly subject: string;
    readonly issuedBy: string;
    readonly collection: string;
  }) => ({
    $type: GRANT,
    space: params.space,
    subject: params.subject,
    selectors: [{ collection: params.collection }],
    actions: ['view'],
    issuedBy: params.issuedBy,
    createdAt: new Date().toISOString(),
  });

  /**
   * A space of alice's with an outsider bob. Blobs are uploaded to the *account* (that is where the
   * store keys them); what the space adds is which CIDs its records name, and the read gate asks
   * about those records.
   */
  const withBlobs = async (
    run: (params: {
      readonly url: string;
      readonly space: string;
      readonly authority: Account;
      readonly reader: Account;
      readonly write: (
        body: Record<string, Schema.Json>,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
      readonly upload: (bytes: Uint8Array, jwt: string) => Promise<string>;
      readonly blob: (
        cid: string,
        jwt: string,
      ) => Promise<{
        readonly status: number;
        readonly bytes: Uint8Array;
        readonly body: Record<string, Schema.Json>;
      }>;
      readonly list: (jwt: string) => Promise<{
        readonly status: number;
        readonly body: Record<string, Schema.Json>;
      }>;
    }) => Promise<void>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pds = yield* startMemoryPds();
          const authority = yield* Effect.promise(() =>
            createAccount(pds.url, 'alice.pds.test'),
          );
          const reader = yield* Effect.promise(() =>
            createAccount(pds.url, 'bob.pds.test'),
          );
          const space = `at://${authority.did}/${SPACE_TYPE}/pictures`;
          const created = yield* Effect.promise(() =>
            postJson(
              `${pds.url}/xrpc/com.atproto.space.createSpace`,
              authority.accessJwt,
              {
                spaceType: SPACE_TYPE,
                skey: 'pictures',
                policy: { $type: 'com.atproto.personalspace.policy' },
              },
            ),
          );
          expect(created.status).toBe(200);
          const query = (method: string, extra = '') =>
            `${pds.url}/xrpc/com.atproto.space.${method}?space=${encodeURIComponent(space)}&repo=${authority.did}${extra}`;
          yield* Effect.promise(() =>
            run({
              url: pds.url,
              space,
              authority,
              reader,
              write: (body, jwt) =>
                postJson(
                  `${pds.url}/xrpc/com.atproto.space.createRecord`,
                  jwt,
                  body,
                ),
              upload: async (bytes, jwt) => {
                const response = await fetch(
                  `${pds.url}/xrpc/com.atproto.repo.uploadBlob`,
                  {
                    method: 'POST',
                    headers: {
                      authorization: `Bearer ${jwt}`,
                      'content-type': 'image/png',
                    },
                    body: Buffer.from(bytes),
                  },
                );
                expect(response.status).toBe(200);
                const body = (await response.json()) as {
                  blob: { ref: { $link: string } };
                };
                return body.blob.ref.$link;
              },
              blob: async (cid, jwt) => {
                const response = await fetch(
                  query('getBlob', `&cid=${encodeURIComponent(cid)}`),
                  { headers: { authorization: `Bearer ${jwt}` } },
                );
                return response.ok
                  ? {
                      status: response.status,
                      bytes: new Uint8Array(await response.arrayBuffer()),
                      body: {},
                    }
                  : {
                      status: response.status,
                      bytes: new Uint8Array(),
                      body: (await response.json()) as Record<
                        string,
                        Schema.Json
                      >,
                    };
              },
              list: async (jwt) => {
                const response = await fetch(query('listBlobs'), {
                  headers: { authorization: `Bearer ${jwt}` },
                });
                return {
                  status: response.status,
                  body: (await response.json()) as Record<string, Schema.Json>,
                };
              },
            }),
          );
        }),
      ),
    );

  const picture = (params: {
    readonly type: string;
    readonly cid: string;
    readonly size: number;
  }) => ({
    $type: 'blob',
    ref: { $link: params.cid },
    mimeType: 'image/png',
    size: params.size,
  });

  it('serves a blob a grant covers, hides the one it does not, and lists only the visible', async () => {
    await withBlobs(
      async ({ space, authority, reader, write, upload, blob, list }) => {
        const shared = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const hidden = new Uint8Array([9, 8, 7]);
        const orphan = new Uint8Array([4, 4, 4]);
        const sharedCid = await upload(shared, authority.accessJwt);
        const hiddenCid = await upload(hidden, authority.accessJwt);
        const orphanCid = await upload(orphan, authority.accessJwt);

        // Two records, two collections: the grant will name one of them.
        for (const [collection, cid, size, text] of [
          ['com.example.note', sharedCid, shared.length, 'shared'],
          ['com.example.private', hiddenCid, hidden.length, 'not shared'],
        ] as const) {
          const written = await write(
            {
              space,
              repo: authority.did,
              collection,
              rkey: 'one',
              record: {
                $type: collection,
                text,
                image: picture({ type: collection, cid, size }),
              } as Schema.Json,
            },
            authority.accessJwt,
          );
          expect(written.status).toBe(200);
        }

        // Nothing is visible to an outsider yet, and the list says why rather than answering empty.
        const refused = await list(reader.accessJwt);
        expect(refused.status).toBe(403);
        expect(String(refused.body['message'])).toContain('no-grant');

        // The owner sees the whole repo without a grant.
        const own = await list(authority.accessJwt);
        expect(own.status).toBe(200);
        expect(own.body['cids']).toEqual([hiddenCid, sharedCid].sort());

        const granted = await write(
          {
            space,
            repo: authority.did,
            collection: GRANT,
            rkey: 'to-bob',
            record: grant({
              space,
              subject: reader.did,
              issuedBy: authority.did,
              collection: 'com.example.note',
            }) as Schema.Json,
          },
          authority.accessJwt,
        );
        expect(granted.status).toBe(200);

        // The picture behind the granted record arrives byte for byte…
        const visible = await blob(sharedCid, reader.accessJwt);
        expect(visible.status).toBe(200);
        expect(visible.bytes).toEqual(shared);
        // …the one behind a record the grant does not name does not…
        const secret = await blob(hiddenCid, reader.accessJwt);
        expect(secret.status).toBe(403);
        expect(String(secret.body['message'])).toContain(
          'no grant covers a record carrying',
        );
        // …and a blob no record names is not in this space at all.
        const nowhere = await blob(orphanCid, reader.accessJwt);
        expect(nowhere.status).toBe(400);
        expect(String(nowhere.body['error'])).toBe('BlobNotFound');

        const subset = await list(reader.accessJwt);
        expect(subset.status).toBe(200);
        expect(subset.body['cids']).toEqual([sharedCid]);
      },
    );
  });
});
