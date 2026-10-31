import { AccountStore, accountStoreLayer } from './account-store.js';
import { BlobStore, blobStoreLayer } from './blob-store.js';
import { DpopReplay, dpopReplayLayer } from './dpop-replay.js';
import { Effect, Layer, Option, Schema } from 'effect';
import { Firehose, firehoseLayer } from './firehose.js';
import { RepoStore, repoStoreLayer } from '@eoa/repo-store';
import { SpaceStore, spaceStoreLayer } from './space-store.js';
import { createDIDKey, generateES256KeyPair } from '@eoa/crypto';
import { createProof, dpopKeyThumbprint } from '@eoa/oauth';
import { describe, expect, it } from 'vitest';
import { generateTokenKeys, issueAccessToken } from '@eoa/oauth-provider';
import { HandleDnsError } from './handle-dns.js';
import { type MailMessage } from './mail.js';
import { SUBSCRIBE_PATH } from './subscribe.js';
import { WebSocket } from 'ws';
import { createPdsServer } from './server.js';
import { createServer } from 'node:http';
import { encodeCbor } from '@eoa/core';
import { kvMemoryLayer } from '@eoa/kv';

const DOMAIN = 'pds.example';

const HANDLE = `alice.${DOMAIN}`;

const PASSWORD = 'correct horse battery staple';

const SessionSchema = Schema.Struct({
  accessJwt: Schema.String,
  refreshJwt: Schema.String,
  handle: Schema.String,
  did: Schema.String,
});

const GetSessionSchema = Schema.Struct({
  handle: Schema.String,
  did: Schema.String,
  active: Schema.Boolean,
});

const CommitSchema = Schema.Struct({
  cid: Schema.String,
  rev: Schema.String,
});

const RecordSchema = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  value: Schema.Struct({ text: Schema.String }),
});

const ListSchema = Schema.Struct({ records: Schema.Array(RecordSchema) });

const RepoSchema = Schema.Struct({
  did: Schema.String,
  handle: Schema.String,
  handleIsCorrect: Schema.Boolean,
  collections: Schema.Array(Schema.String),
});

const StatusSchema = Schema.Struct({
  did: Schema.String,
  active: Schema.Boolean,
  status: Schema.String,
  rev: Schema.String,
});

const AppPasswordSchema = Schema.Struct({
  name: Schema.String,
  password: Schema.String,
  createdAt: Schema.String,
  privileged: Schema.Boolean,
});

const AppPasswordListSchema = Schema.Struct({
  passwords: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      createdAt: Schema.String,
      privileged: Schema.Boolean,
    }),
  ),
});

const InviteSchema = Schema.Struct({ code: Schema.String });

const ErrorSchema = Schema.Struct({ error: Schema.String });

const BlobRefSchema = Schema.Struct({
  $type: Schema.String,
  ref: Schema.Struct({ $link: Schema.String }),
  mimeType: Schema.String,
  size: Schema.Number,
});

const UploadSchema = Schema.Struct({ blob: BlobRefSchema });

const RecordWithBlobSchema = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  value: Schema.Struct({
    text: Schema.String,
    embed: Schema.Struct({
      $type: Schema.String,
      images: Schema.Array(
        Schema.Struct({ image: BlobRefSchema, alt: Schema.String }),
      ),
    }),
  }),
});

const ListBlobsSchema = Schema.Struct({ cids: Schema.Array(Schema.String) });

const ResolveHandleSchema = Schema.Struct({ did: Schema.String });

const LatestCommitSchema = Schema.Struct({
  cid: Schema.String,
  rev: Schema.String,
});

const CredentialsSchema = Schema.Struct({
  alsoKnownAs: Schema.Array(Schema.String),
  rotationKeys: Schema.optional(Schema.Array(Schema.String)),
  verificationMethods: Schema.Struct({
    atproto: Schema.String,
    atproto_kem: Schema.optionalKey(Schema.String),
  }),
  services: Schema.Struct({
    atproto_pds: Schema.Struct({
      type: Schema.String,
      endpoint: Schema.String,
    }),
  }),
});

const sessionOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(SessionSchema),
);
const getSessionOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(GetSessionSchema),
);
const commitOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ commit: CommitSchema })),
);
const recordOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(RecordSchema),
);
const listOf = Schema.decodeUnknownOption(Schema.fromJsonString(ListSchema));
const repoOf = Schema.decodeUnknownOption(Schema.fromJsonString(RepoSchema));
const statusOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(StatusSchema),
);
const appPasswordOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(AppPasswordSchema),
);
const appPasswordListOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(AppPasswordListSchema),
);
const inviteOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(InviteSchema),
);
const errorOf = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorSchema));
/** The same refusal with its reason: some guards are told apart only by the message. */
const errorMessageOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.String, message: Schema.String }),
  ),
);
const uploadOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(UploadSchema),
);
const recordWithBlobOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(RecordWithBlobSchema),
);
const listReposOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      cursor: Schema.optional(Schema.String),
      repos: Schema.Array(
        Schema.Struct({
          did: Schema.String,
          head: Schema.String,
          rev: Schema.String,
        }),
      ),
    }),
  ),
);

const listBlobsOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(ListBlobsSchema),
);
const resolveHandleOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(ResolveHandleSchema),
);
const credentialsOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(CredentialsSchema),
);

/** The signed operation a PDS hands back, and the parts a test checks. */
const SignedOperationSchema = Schema.Struct({
  type: Schema.String,
  prev: Schema.NullOr(Schema.String),
  rotationKeys: Schema.mutable(Schema.Array(Schema.String)),
  verificationMethods: Schema.Struct({
    atproto: Schema.String,
    atproto_kem: Schema.optionalKey(Schema.String),
  }),
  alsoKnownAs: Schema.mutable(Schema.Array(Schema.String)),
  sig: Schema.String,
  services: Schema.Struct({
    atproto_pds: Schema.Struct({
      type: Schema.String,
      endpoint: Schema.String,
    }),
  }),
});

const operationOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ operation: SignedOperationSchema })),
);

/** What a migration reads off both servers before it moves a DID. */
const AccountStatusSchema = Schema.Struct({
  activated: Schema.Boolean,
  validDid: Schema.Boolean,
  repoCommit: Schema.String,
  repoRev: Schema.String,
  indexedRecords: Schema.Number,
});

const accountStatusOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(AccountStatusSchema),
);

/** The blobs a repo's records name and the store does not hold. */
const MissingBlobsSchema = Schema.Struct({
  blobs: Schema.Array(
    Schema.Struct({ cid: Schema.String, recordUri: Schema.String }),
  ),
});

const missingOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(MissingBlobsSchema),
);
const latestCommitOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(LatestCommitSchema),
);

/** Wait until a condition holds, rather than guessing how long it takes. */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
async function until(holds: () => boolean, left: number) {
  if (holds()) {
    return;
  }
  if (left <= 0) {
    throw new Error('a condition never held');
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  await until(holds, left - 1);
}

/** Fail with the step that hung, rather than with the whole test's timeout. */
const within = (promise: Promise<unknown>, what: string) =>
  Promise.race([
    promise,
    new Promise((_unused, reject) => {
      setTimeout(
        () => reject(new Error(`timed out waiting for ${what}`)),
        4000,
      );
    }),
  ]);

/** Wait until the listener answers, rather than guessing how long it takes. */
// Recursive, so TypeScript cannot infer the return type (TS7023).
// oxlint-disable-next-line diff-check/no-explicit-function-return-type
async function waitFor(url: string, left: number) {
  try {
    await fetch(url);
  } catch (cause) {
    if (left <= 0) {
      throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    await waitFor(url, left - 1);
  }
}

const answer = async <A>(
  url: string,
  decode: (text: string) => Option.Option<A>,
  init: RequestInit,
) => {
  const response = await fetch(url, init);
  const text = await response.text();
  const decoded = decode(text);
  if (Option.isNone(decoded)) {
    throw new Error(`unexpected body from ${url}: ${text}`);
  }
  return { status: response.status, body: decoded.value };
};

/** A PDS of its own, with its own port and its own empty store. */
const startPds = async (
  options: {
    recoveryDidKey?: string;
    recoveryToken?: string;
    handleDns?: boolean;
    failingHandleDns?: boolean;
  } = {},
) => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const stack = Layer.mergeAll(
    repoStoreLayer,
    accountStoreLayer,
    blobStoreLayer,
    dpopReplayLayer,
    firehoseLayer(),
    spaceStoreLayer,
  ).pipe(Layer.provide(kvMemoryLayer));
  const services = await Effect.runPromise(
    Effect.all({
      repo: RepoStore,
      accounts: AccountStore,
      blobs: BlobStore,
      replay: DpopReplay,
      firehose: Firehose,
      spaces: SpaceStore,
    }).pipe(Effect.provide(stack)),
  );
  const keys = await Effect.runPromise(generateES256KeyPair());
  // The PLC rotation key: naming it in `rotationKeys` is what makes this PDS a
  // `did:plc` destination rather than a `did:web` server that cannot move.
  const rotation = await Effect.runPromise(generateES256KeyPair());
  const rotationDidKey = await Effect.runPromise(
    createDIDKey(rotation.publicKey),
  );
  // The authorization server this PDS trusts, and the client the tests act as.
  const issuerKeys = await Effect.runPromise(generateTokenKeys);
  const issuer = 'https://as.pds.example';
  const issuerJwk = issuerKeys.jwks.keys[0];
  if (issuerJwk === undefined) {
    throw new Error('the generated issuer has no key');
  }
  // The messages this PDS would send, kept rather than posted: a test has to be
  // able to read the token that was mailed.
  const mails: MailMessage[] = [];
  const mail = {
    send: (message: MailMessage) =>
      Effect.sync(() => {
        mails.push(message);
      }),
  };
  // The moderator list the PDS reads and the test writes: an operator names the
  // DIDs, and a test has to be able to name the account it just made.
  const admins: string[] = [];
  // A directory of one DID, in memory: the head the PDS points its operation at,
  // and the submissions it sends. Kept rather than faked, because a test has to
  // read what left; the body is asserted as text, so nothing here parses it.
  const headCid =
    'bafyreidfayvfuwqa4xokwj2gmwzdsv4v5w5ndp7zq2qk5v2n5w2w5w5w5w4';
  const submissions: string[] = [];
  // What `/<did>/data` says the DID currently is. A handover reads it before it signs, because the
  // recovery key has to be listed *before* the switch — so a stub that only answers the audit log is
  // a stub that cannot rehearse an exit.
  let current: Record<string, unknown> | undefined;
  const directory = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        (request.url ?? '').endsWith('/data')
          ? JSON.stringify(current ?? {})
          : `[{"cid":"${headCid}"}]`,
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
  // An ephemeral port, not a formula: the PDS picks its own the same way, and
  // two formulas in one range collide under a parallel run.
  await new Promise<void>((resolve) => {
    directory.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const directoryAddress = directory.address();
  const directoryPort =
    typeof directoryAddress === 'object' && directoryAddress !== null
      ? directoryAddress.port
      : 0;
  // What was written to DNS, in order: a handle's `_atproto` record is the one thing here that is
  // not in the PDS's own store, so it has to be visible to be checked.
  const dnsCalls: Array<string> = [];
  const handleDns =
    options.failingHandleDns === true
      ? {
          publish: ({ handle }: { readonly handle: string }) =>
            Effect.fail(
              new HandleDnsError({
                handle,
                reason: 'the zone is rate-limited',
              }),
            ),
          remove: ({ handle }: { readonly handle: string }) =>
            Effect.fail(
              new HandleDnsError({
                handle,
                reason: 'the zone is rate-limited',
              }),
            ),
        }
      : options.handleDns === true
        ? {
            publish: ({
              handle,
              did,
            }: {
              readonly handle: string;
              readonly did: string;
            }) =>
              Effect.sync(() => {
                dnsCalls.push(`publish:${handle}:${did}`);
              }) as Effect.Effect<void>,
            remove: ({ handle }: { readonly handle: string }) =>
              Effect.sync(() => {
                dnsCalls.push(`remove:${handle}`);
              }) as Effect.Effect<void>,
          }
        : undefined;
  const server = createPdsServer({
    config: {
      did: `did:web:${DOMAIN}`,
      domain: DOMAIN,
      signingKey: keys.privateKey,
      clockId: 0,
      // An operator who takes only images, which is what makes the type limit
      // a thing to test rather than a thing to trust.
      allowedBlobTypes: ['image/'],
      oauth: { issuer, jwk: issuerJwk },
      adminDids: admins,
      plcDirectoryUrl: `http://127.0.0.1:${directoryPort}`,
      plcRotationKey: rotation.privateKey,
      ...(options.recoveryDidKey === undefined
        ? {}
        : { plcRecoveryDidKey: options.recoveryDidKey }),
      ...(options.recoveryToken === undefined
        ? {}
        : { recoveryToken: options.recoveryToken }),
    },
    repo: services.repo,
    accounts: services.accounts,
    blobs: services.blobs,
    replay: services.replay,
    firehose: services.firehose,
    mail,
    spaces: services.spaces,
    ...(handleDns === undefined ? {} : { handleDns }),
  });
  // The state a handover reads: the keys the chain has now, and where it points.
  current = {
    did: `did:web:${DOMAIN}`,
    rotationKeys: [rotationDidKey],
    verificationMethods: { atproto: rotationDidKey },
    alsoKnownAs: [],
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: `https://${DOMAIN}`,
      },
    },
  };
  Effect.runFork(
    Effect.scoped(
      server
        .start({ port, hostname: '127.0.0.1' })
        .pipe(Effect.andThen(Effect.never)),
    ),
  );
  await waitFor(`${base}/xrpc/com.atproto.server.describeServer`, 40);

  const query = <A>(
    path: string,
    decode: (text: string) => Option.Option<A>,
    token?: string,
  ) =>
    answer(
      `${base}${path}`,
      decode,
      token === undefined
        ? {}
        : { headers: { Authorization: `Bearer ${token}` } },
    );

  const call = <A>(
    method: string,
    body: Schema.Json,
    decode: (text: string) => Option.Option<A>,
    token?: string,
  ) =>
    answer(`${base}/xrpc/${method}`, decode, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  const raw = <A>(
    method: string,
    bytes: Uint8Array,
    contentType: string,
    decode: (text: string) => Option.Option<A>,
    token?: string,
  ) =>
    answer(`${base}/xrpc/${method}`, decode, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: Uint8Array.from(bytes),
    });

  const oauthCall = <A>(
    method: string,
    body: Schema.Json,
    decode: (text: string) => Option.Option<A>,
    token: string,
    proof?: string,
  ) =>
    answer(`${base}/xrpc/${method}`, decode, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DPoP ${token}`,
        ...(proof === undefined ? {} : { DPoP: proof }),
      },
      body: JSON.stringify(body),
    });

  const createAccount = async (
    handle: string,
    inviteCode?: string,
    email?: string,
  ) => {
    const body = await call(
      'com.atproto.server.createAccount',
      {
        handle,
        password: PASSWORD,
        ...(email === undefined ? {} : { email }),
        ...(inviteCode === undefined ? {} : { inviteCode }),
      },
      sessionOf,
    );
    return body;
  };

  return {
    base,
    ws: `ws://127.0.0.1:${port}`,
    did: `did:web:${DOMAIN}`,
    query,
    call,
    raw,
    oauthCall,
    createAccount,
    admins,
    mails,
    issuer,
    issuerKeys,
    rotationDidKey,
    headCid,
    submissions,
    dnsCalls,
  };
};

describe('the way back in', () => {
  // `com.atproto.admin.resetPassword` is the only door a deployment with no mailbox has, and it shipped
  // comparing a digest against the plaintext token — so it refused every token on every deployment.
  // Nothing failed until an operator needed it in the middle of a real move (`ek1d`).
  it('opens with the recovery token itself, and refuses everything else', async () => {
    const pds = await startPds({ recoveryToken: 'the-operator-token' });
    const created = await pds.createAccount(HANDLE);
    const alice = created.body.did;
    const empty = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({})),
    );

    const refused = await pds.call(
      'com.atproto.admin.resetPassword',
      { did: alice, password: 'a-new-password' },
      errorOf,
      'not-the-token',
    );
    expect(refused.status).toBe(401);

    // A refusal changes nothing: the old password still opens the account.
    expect(
      (
        await pds.call(
          'com.atproto.server.createSession',
          { identifier: HANDLE, password: PASSWORD },
          sessionOf,
        )
      ).status,
    ).toBe(200);

    const accepted = await pds.call(
      'com.atproto.admin.resetPassword',
      { did: alice, password: 'a-new-password' },
      empty,
      'the-operator-token',
    );
    expect(accepted.status).toBe(200);

    // The new password opens the account, which is the point of the call.
    const after = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: 'a-new-password' },
      sessionOf,
    );
    expect(after.status).toBe(200);
    expect(after.body.did).toBe(alice);
  });

  it('does not answer at all when the deployment names no token', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const empty = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({})),
    );

    const answer = await pds.call(
      'com.atproto.admin.resetPassword',
      { did: created.body.did, password: 'a-new-password' },
      empty,
      'anything',
    );
    expect(answer.status).toBe(400);
  });
});

describe('the account surface', () => {
  it('creates an account, signs in, and writes a record it owns', async () => {
    const pds = await startPds();

    // createAccount is the spec's `create` then `activate`: a live account.
    const created = await pds.createAccount(HANDLE);
    expect(created.status).toBe(200);
    expect(created.body.handle).toBe(HANDLE);
    expect(created.body.did).toMatch(/^did:web:pds\.example:/u);
    const alice = created.body.did;

    // The handle is taken now, and a taken handle leaves the account absent —
    // so the second attempt is refused and nothing was created.
    const again = await pds.call(
      'com.atproto.server.createAccount',
      { handle: HANDLE, password: PASSWORD },
      errorOf,
    );
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: 'InvalidRequest' });
    expect(
      (
        await pds.call(
          'com.atproto.server.createAccount',
          {
            handle: `bob.${DOMAIN}`,
            password: PASSWORD,
            inviteCode: 'not-a-real-code',
          },
          errorOf,
        )
      ).body,
    ).toEqual({ error: 'InvalidRequest' });

    // Signing in, by handle, with the password.
    const session = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: PASSWORD },
      sessionOf,
    );
    expect(session.status).toBe(200);
    expect(session.body.did).toBe(alice);

    const wrong = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: 'not the password' },
      errorOf,
    );
    expect(wrong.status).toBe(401);

    const token = session.body.accessJwt;
    const about = await pds.query(
      '/xrpc/com.atproto.server.getSession',
      getSessionOf,
      token,
    );
    expect(about.status).toBe(200);
    expect(about.body.handle).toBe(HANDLE);

    // A write needs the token, and it lands on the account's own repo.
    const written = await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
        record: { text: 'hello' },
      },
      commitOf,
      token,
    );
    expect(written.status).toBe(200);

    const anonymous = await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'two',
        record: { text: 'not mine' },
      },
      errorOf,
    );
    expect(anonymous.status).toBe(401);

    // Another account's token is not this repo's.
    const bob = await pds.createAccount(`bob.${DOMAIN}`);
    const intruder = await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'three',
        record: { text: 'not mine either' },
      },
      errorOf,
      bob.body.accessJwt,
    );
    expect(intruder.status).toBe(403);

    // Reads are open, and a repo is addressable by handle.
    const read = await pds.query(
      `/xrpc/com.atproto.repo.getRecord?repo=${HANDLE}&collection=app.bsky.feed.post&rkey=one`,
      recordOf,
    );
    expect(read.status).toBe(200);
    expect(read.body.value).toEqual({ text: 'hello' });

    const listed = await pds.query(
      `/xrpc/com.atproto.repo.listRecords?repo=${alice}&collection=app.bsky.feed.post`,
      listOf,
    );
    expect(listed.body.records.map((one) => one.uri)).toEqual([
      `at://${alice}/app.bsky.feed.post/one`,
    ]);

    const described = await pds.query(
      `/xrpc/com.atproto.repo.describeRepo?repo=${HANDLE}`,
      repoOf,
    );
    expect(described.body.handle).toBe(HANDLE);
    expect(described.body.handleIsCorrect).toBe(true);
    expect(described.body.collections).toEqual(['app.bsky.feed.post']);

    const status = await pds.query(
      `/xrpc/com.atproto.sync.getRepoStatus?did=${alice}`,
      statusOf,
    );
    expect(status.body.active).toBe(true);

    // A deleted session stops speaking at once, not at expiry.
    const ended = await pds.call(
      'com.atproto.server.deleteSession',
      {},
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({}))),
      session.body.refreshJwt,
    );
    expect(ended.status).toBe(200);
    const afterEnd = await pds.query(
      '/xrpc/com.atproto.server.getSession',
      errorOf,
      token,
    );
    expect(afterEnd.status).toBe(401);
  });

  it('hands a robot a credential of its own', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const alice = created.body.did;

    const made = await pds.call(
      'com.atproto.server.createAppPassword',
      { name: 'robot' },
      appPasswordOf,
      token,
    );
    expect(made.status).toBe(200);
    expect(made.body.password).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/u);
    expect(made.body.privileged).toBe(false);

    const listed = await pds.query(
      '/xrpc/com.atproto.server.listAppPasswords',
      appPasswordListOf,
      token,
    );
    expect(listed.body.passwords.map((one) => one.name)).toEqual(['robot']);

    // The app password opens a session of its own — no account password needed.
    const session = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: made.body.password },
      sessionOf,
    );
    expect(session.status).toBe(200);
    expect(session.body.did).toBe(alice);

    // Revoking it takes that away, and leaves the account's own password alone.
    const revoked = await pds.call(
      'com.atproto.server.revokeAppPassword',
      { name: 'robot' },
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({}))),
      token,
    );
    expect(revoked.status).toBe(200);

    const refused = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: made.body.password },
      errorOf,
    );
    expect(refused.status).toBe(401);

    const stillMine = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: PASSWORD },
      sessionOf,
    );
    expect(stillMine.status).toBe(200);
  });

  it('changes the password, ends the sessions the old one opened, and refuses a robot', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;

    // A second session, opened with the password: the change must end it.
    const other = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: PASSWORD },
      sessionOf,
    );
    expect(other.status).toBe(200);

    // A robot's session cannot rotate the account's password.
    const made = await pds.call(
      'com.atproto.server.createAppPassword',
      { name: 'robot' },
      appPasswordOf,
      token,
    );
    const robot = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: made.body.password },
      sessionOf,
    );
    expect(robot.status).toBe(200);
    const refused = await pds.call(
      'com.atproto.server.updatePassword',
      { password: 'a password a robot chose' },
      errorOf,
      robot.body.accessJwt,
    );
    expect(refused.status).toBe(403);

    const changed = await pds.call(
      'com.atproto.server.updatePassword',
      { password: 'a different horse, a different staple' },
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({}))),
      token,
    );
    expect(changed.status).toBe(200);

    // The old password opens nothing, the new one opens a session.
    const old = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: PASSWORD },
      errorOf,
    );
    expect(old.status).toBe(401);
    const fresh = await pds.call(
      'com.atproto.server.createSession',
      {
        identifier: HANDLE,
        password: 'a different horse, a different staple',
      },
      sessionOf,
    );
    expect(fresh.status).toBe(200);

    // The session the old password opened is gone; the caller's own still answers.
    const ended = await pds.query(
      '/xrpc/com.atproto.server.getSession',
      errorOf,
      other.body.accessJwt,
    );
    expect(ended.status).toBe(401);
    const kept = await pds.query(
      '/xrpc/com.atproto.server.getSession',
      getSessionOf,
      token,
    );
    expect(kept.status).toBe(200);

    // A short password is refused rather than written.
    const short = await pds.call(
      'com.atproto.server.updatePassword',
      { password: 'short' },
      errorOf,
      token,
    );
    expect(short.status).toBe(400);
  });

  it('follows the spec: suspend stops the tokens, reinstate brings them back, delete releases the handle', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const alice = created.body.did;

    const invite = await pds.call(
      'com.atproto.server.createInviteCode',
      { useCount: 1 },
      inviteOf,
      token,
    );
    expect(invite.status).toBe(200);
    expect(invite.body.code).toMatch(/^[a-z2-7]{5}(-[a-z2-7]{5}){4}$/u);

    // A code that does not exist is refused; the account stays absent.
    const refused = await pds.call(
      'com.atproto.server.createAccount',
      {
        handle: `carol.${DOMAIN}`,
        password: PASSWORD,
        inviteCode: 'zzzzz-zzzzz-zzzzz-zzzzz-zzzzz',
      },
      errorOf,
    );
    expect(refused.status).toBe(400);

    // A good code creates the account it was made for.
    const withInvite = await pds.createAccount(
      `carol.${DOMAIN}`,
      invite.body.code,
    );
    expect(withInvite.status).toBe(200);

    // suspend: a suspended account's tokens stop working without being touched.
    const off = await pds.call(
      'com.atproto.server.deactivateAccount',
      {},
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({}))),
      token,
    );
    expect(off.status).toBe(200);
    const dark = await pds.query(
      '/xrpc/com.atproto.server.getSession',
      errorOf,
      token,
    );
    expect(dark.status).toBe(401);
    const noLogin = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: PASSWORD },
      errorOf,
    );
    expect(noLogin.body).toEqual({ error: 'AccountTakedown' });
    const suspended = await pds.query(
      `/xrpc/com.atproto.sync.getRepoStatus?did=${alice}`,
      statusOf,
    );
    expect(suspended.body.active).toBe(false);
    expect(suspended.body.status).toBe('suspended');

    // reinstate: proof of ownership is the way back, since a suspended account
    // cannot hold a session to ask with.
    const back = await pds.call(
      'com.atproto.server.activateAccount',
      { identifier: HANDLE, password: PASSWORD },
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({}))),
    );
    expect(back.status).toBe(200);
    const again = await pds.call(
      'com.atproto.server.createSession',
      { identifier: HANDLE, password: PASSWORD },
      sessionOf,
    );
    expect(again.status).toBe(200);

    // deleteAccount releases the handle, so a fresh account can take it.
    const gone = await pds.call(
      'com.atproto.server.deleteAccount',
      { did: alice, password: PASSWORD },
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({}))),
    );
    expect(gone.status).toBe(200);
    const noRepo = await pds.query(
      `/xrpc/com.atproto.sync.getRepoStatus?did=${alice}`,
      errorOf,
    );
    expect(noRepo.status).toBe(400);
    expect(noRepo.body).toEqual({ error: 'RepoNotFound' });

    // The handle is free again, and the account that takes it is a *new* one:
    // the deleted row is terminal, so the same DID can never come back.
    const reclaimed = await pds.createAccount(HANDLE);
    expect(reclaimed.status).toBe(200);
    expect(reclaimed.body.handle).toBe(HANDLE);
    expect(reclaimed.body.did).not.toBe(alice);
  });

  it('takes a blob, gives it back, and lets a record hold its reference', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const alice = created.body.did;

    // A blob arrives as bytes, not as JSON.
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const uploaded = await pds.raw(
      'com.atproto.repo.uploadBlob',
      image,
      'image/png',
      uploadOf,
      token,
    );
    expect(uploaded.status).toBe(200);
    const reference = uploaded.body.blob;
    expect(reference.$type).toBe('blob');
    expect(reference.ref.$link).toMatch(/^bafkrei/u);
    expect(reference.mimeType).toBe('image/png');
    expect(reference.size).toBe(image.length);

    // The reference is exactly what a record holds.
    const written = await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'with-image',
        record: {
          text: 'a picture',
          embed: {
            $type: 'app.bsky.embed.images',
            images: [{ image: reference, alt: 'a test' }],
          },
        },
      },
      commitOf,
      token,
    );
    expect(written.status).toBe(200);

    const read = await pds.query(
      `/xrpc/com.atproto.repo.getRecord?repo=${HANDLE}&collection=app.bsky.feed.post&rkey=with-image`,
      recordWithBlobOf,
    );
    expect(read.body.value.embed.images[0]?.image).toEqual(reference);

    // The bytes come back as bytes, with the type they were stored under.
    const fetched = await fetch(
      `${pds.base}/xrpc/com.atproto.sync.getBlob?did=${alice}&cid=${reference.ref.$link}`,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(image);

    // Listing is the owner's, and only the owner's.
    const listed = await pds.query(
      `/xrpc/com.atproto.sync.listBlobs?did=${alice}`,
      listBlobsOf,
      token,
    );
    expect(listed.body.cids).toEqual([reference.ref.$link]);

    const bob = await pds.createAccount(`bob.${DOMAIN}`);
    const theirs = await pds.query(
      `/xrpc/com.atproto.sync.listBlobs?did=${alice}`,
      errorOf,
      bob.body.accessJwt,
    );
    expect(theirs.status).toBe(403);

    // Over the limit: refused, and the store is untouched — the spec's
    // "a failed upload retains no bytes".
    const tooBig = await pds.raw(
      'com.atproto.repo.uploadBlob',
      new Uint8Array(6 * 1024 * 1024),
      'image/png',
      errorOf,
      token,
    );
    expect(tooBig.status).toBe(400);
    expect(tooBig.body).toEqual({ error: 'BlobTooLarge' });
    const after = await pds.query(
      `/xrpc/com.atproto.sync.listBlobs?did=${alice}`,
      listBlobsOf,
      token,
    );
    expect(after.body.cids).toEqual([reference.ref.$link]);

    // A type this PDS does not take, and an upload with no identity at all.
    const text = await pds.raw(
      'com.atproto.repo.uploadBlob',
      new TextEncoder().encode('just words'),
      'text/plain',
      errorOf,
      token,
    );
    expect(text.status).toBe(400);
    expect(text.body).toEqual({ error: 'BlobTypeNotAllowed' });

    const anonymous = await pds.raw(
      'com.atproto.repo.uploadBlob',
      image,
      'image/png',
      errorOf,
    );
    expect(anonymous.status).toBe(401);
  });

  it('takes an OAuth access token, and only from the key it was issued to', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const alice = created.body.did;

    // The client's own key, and the token the provider binds to it.
    const client = await Effect.runPromise(generateES256KeyPair());
    const jkt = await Effect.runPromise(dpopKeyThumbprint(client.privateKey));
    const now = Math.floor(Date.now() / 1000);
    const token = await Effect.runPromise(
      issueAccessToken({
        keys: pds.issuerKeys,
        issuer: pds.issuer,
        audience: pds.did,
        did: alice,
        scope: 'atproto',
        credential: 'session:test',
        jkt,
        now,
      }),
    );

    const writeUrl = `${pds.base}/xrpc/com.atproto.repo.createRecord`;
    const write = (rkey: string) => ({
      repo: HANDLE,
      collection: 'app.bsky.feed.post',
      rkey,
      record: { text: 'written with a token' },
    });
    const proofFor = (htu: string, key = client.privateKey) =>
      Effect.runPromise(
        createProof({ key, htm: 'POST', htu, accessToken: token }),
      );

    // A write as alice with no session at all: a token, and a proof.
    const proof = await proofFor(writeUrl);
    const written = await pds.oauthCall(
      'com.atproto.repo.createRecord',
      write('one'),
      commitOf,
      token,
      proof,
    );
    expect(written.status).toBe(200);

    const read = await pds.query(
      `/xrpc/com.atproto.repo.getRecord?repo=${HANDLE}&collection=app.bsky.feed.post&rkey=one`,
      recordOf,
    );
    expect(read.status).toBe(200);
    expect(read.body.value).toEqual({ text: 'written with a token' });

    // The same proof again is a replay — the spec's `NoReplay`.
    const replayed = await pds.oauthCall(
      'com.atproto.repo.createRecord',
      write('two'),
      errorOf,
      token,
      proof,
    );
    expect(replayed.status).toBe(401);

    // A fresh proof still works: the refusal was about that proof, not the caller.
    const second = await pds.oauthCall(
      'com.atproto.repo.createRecord',
      write('two'),
      commitOf,
      token,
      await proofFor(writeUrl),
    );
    expect(second.status).toBe(200);

    // A proof made with a key the token was *not* issued to.
    const thief = await Effect.runPromise(generateES256KeyPair());
    const stolen = await pds.oauthCall(
      'com.atproto.repo.createRecord',
      write('three'),
      errorOf,
      token,
      await proofFor(writeUrl, thief.privateKey),
    );
    expect(stolen.status).toBe(401);

    // A proof for another endpoint does not open this one.
    const elsewhere = await pds.oauthCall(
      'com.atproto.repo.createRecord',
      write('four'),
      errorOf,
      token,
      await proofFor(`${pds.base}/xrpc/com.atproto.repo.deleteRecord`),
    );
    expect(elsewhere.status).toBe(401);

    // A token with no proof at all is not a caller.
    const bare = await pds.oauthCall(
      'com.atproto.repo.createRecord',
      write('five'),
      errorOf,
      token,
    );
    expect(bare.status).toBe(401);

    // And a token minted for another server is not for this one.
    const elsewhereToken = await Effect.runPromise(
      issueAccessToken({
        keys: pds.issuerKeys,
        issuer: pds.issuer,
        audience: 'did:web:elsewhere.example',
        did: alice,
        scope: 'atproto',
        credential: 'session:test',
        jkt,
        now,
      }),
    );
    const wrongServer = await pds.oauthCall(
      'com.atproto.repo.createRecord',
      write('six'),
      errorOf,
      elsewhereToken,
      await Effect.runPromise(
        createProof({
          key: client.privateKey,
          htm: 'POST',
          htu: writeUrl,
          accessToken: elsewhereToken,
        }),
      ),
    );
    expect(wrongServer.status).toBe(401);

    // Nothing any of the refusals tried to write is there.
    const listed = await pds.query(
      `/xrpc/com.atproto.repo.listRecords?repo=${HANDLE}&collection=app.bsky.feed.post`,
      listOf,
    );
    expect(listed.body.records.map((one) => one.uri.slice(-3))).toEqual([
      'one',
      'two',
    ]);
  });

  it('resolves a handle, moves it, and publishes what a client should serve', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const alice = created.body.did;
    const done = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({})),
    );

    // Public, and it is the question another implementation asks to find us.
    const resolved = await pds.query(
      `/xrpc/com.atproto.identity.resolveHandle?handle=${HANDLE}`,
      resolveHandleOf,
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ did: alice });

    const unknown = await pds.query(
      '/xrpc/com.atproto.identity.resolveHandle?handle=nobody.pds.example',
      errorOf,
    );
    expect(unknown.body).toEqual({ error: 'HandleNotFound' });

    // What a client should publish for the account.
    const credentials = await pds.query(
      '/xrpc/com.atproto.identity.getRecommendedDidCredentials',
      credentialsOf,
      token,
    );
    expect(credentials.status).toBe(200);
    expect(credentials.body.alsoKnownAs).toEqual([`at://${HANDLE}`]);
    expect(credentials.body.verificationMethods.atproto).toMatch(/^did:key:z/u);
    // The account's own KEM key (spaces alpha, 2026-10-22, §7): a client
    // publishes it beside `atproto`, and it is never the signing key reused.
    expect(credentials.body.verificationMethods.atproto_kem).toMatch(
      /^did:key:z/u,
    );
    expect(credentials.body.verificationMethods.atproto_kem).not.toBe(
      credentials.body.verificationMethods.atproto,
    );
    expect(credentials.body.services.atproto_pds.type).toBe(
      'AtprotoPersonalDataServer',
    );
    expect(credentials.body.services.atproto_pds.endpoint).toBe(
      `https://${DOMAIN}`,
    );
    // A `did:plc` move needs this PDS named in `rotationKeys` — the field a
    // `did:web` leaves out and the reason this PDS can be a destination at all.
    expect(credentials.body.rotationKeys).toEqual([pds.rotationDidKey]);

    // A rename is a swap of one row: the DID does not move with the handle,
    // because it was never derived from it.
    const renamed = await pds.call(
      'com.atproto.identity.updateHandle',
      { handle: `ali.${DOMAIN}` },
      done,
      token,
    );
    expect(renamed.status).toBe(200);
    const now = await pds.query(
      `/xrpc/com.atproto.identity.resolveHandle?handle=ali.${DOMAIN}`,
      resolveHandleOf,
    );
    expect(now.body).toEqual({ did: alice });
    const released = await pds.query(
      `/xrpc/com.atproto.identity.resolveHandle?handle=${HANDLE}`,
      errorOf,
    );
    expect(released.body).toEqual({ error: 'HandleNotFound' });
    // ...and the repo is still the account's, under its new name.
    const about = await pds.query(
      `/xrpc/com.atproto.repo.describeRepo?repo=${alice}`,
      repoOf,
    );
    expect(about.body.handle).toBe(`ali.${DOMAIN}`);

    // A handle someone else holds is refused, and the old one still works —
    // the claim and the release are one batch, so there is no gap between them.
    await pds.createAccount(`bob.${DOMAIN}`);
    const taken = await pds.call(
      'com.atproto.identity.updateHandle',
      { handle: `bob.${DOMAIN}` },
      errorOf,
      token,
    );
    expect(taken.status).toBe(400);
    const still = await pds.query(
      `/xrpc/com.atproto.identity.resolveHandle?handle=ali.${DOMAIN}`,
      resolveHandleOf,
    );
    expect(still.body).toEqual({ did: alice });

    // A handle that is not ours, a rename to the name it already has, and a
    // caller who is nobody at all.
    const offDomain = await pds.call(
      'com.atproto.identity.updateHandle',
      { handle: 'alice.elsewhere.example' },
      errorOf,
      token,
    );
    expect(offDomain.status).toBe(400);
    const same = await pds.call(
      'com.atproto.identity.updateHandle',
      { handle: `ali.${DOMAIN}` },
      done,
      token,
    );
    expect(same.status).toBe(200);
    const anonymous = await pds.call(
      'com.atproto.identity.updateHandle',
      { handle: `x.${DOMAIN}` },
      errorOf,
    );
    expect(anonymous.status).toBe(401);
  });

  it('signs a PLC operation at the directory head, and submits it', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const done = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({})),
    );

    // Signing reads the head from the directory and points `prev` at it: a
    // did:plc *is* its chain, so an operation that does not name the head is a
    // different identifier's operation entirely.
    const signed = await pds.call(
      'com.atproto.identity.signPlcOperation',
      { alsoKnownAs: [`at://${HANDLE}`] },
      operationOf,
      token,
    );
    expect(signed.status).toBe(200);
    expect(signed.body.operation.prev).toBe(pds.headCid);
    expect(signed.body.operation.rotationKeys).toEqual([pds.rotationDidKey]);
    expect(signed.body.operation.services.atproto_pds.endpoint).toBe(
      `https://${DOMAIN}`,
    );
    expect(signed.body.operation.sig).toMatch(/^[A-Za-z0-9_-]+$/u);

    // Submitting forwards it, and the operation really left: the directory has
    // the body, and it names this PDS.
    const submitted = await pds.call(
      'com.atproto.identity.submitPlcOperation',
      { operation: signed.body.operation },
      done,
      token,
    );
    expect(submitted.status).toBe(200);
    await until(() => pds.submissions.length === 1, 40);
    expect(pds.submissions[0]).toContain(pds.rotationDidKey);

    // An operation that does not name this PDS is refused before anything is
    // sent, because a submission that pointed the DID elsewhere is a footgun.
    const refused = await pds.call(
      'com.atproto.identity.submitPlcOperation',
      {
        operation: {
          ...signed.body.operation,
          rotationKeys: ['did:key:zDnaerDaBcDeFgHiJkLmNoPqRsTuVwXyZ'],
        },
      },
      errorOf,
      token,
    );
    expect(refused.status).toBe(400);
    expect(pds.submissions).toHaveLength(1);
  });

  it('stores a KEM key for a did:web account, and publishes nothing', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);

    // The key exists and is the account's own: a client publishing a `did:web`
    // document lists it, and a syncer reads it from there.
    const credentials = await pds.query(
      '/xrpc/com.atproto.identity.getRecommendedDidCredentials',
      credentialsOf,
      created.body.accessJwt,
    );
    expect(credentials.body.verificationMethods.atproto_kem).toMatch(
      /^did:key:zDna/u,
    );

    // Nothing was sent anywhere: a `did:web` has no directory chain, so there is
    // no operation to submit and no `#identity` event to emit. The owner's own
    // document is theirs to update.
    expect(pds.submissions).toHaveLength(0);
  });

  it('refuses an operation whose KEM key is not the one it holds', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;

    // A signed operation carries this account's KEM key by default — the same
    // rule as `atproto`, because a move must not retract the key.
    const signed = await pds.call(
      'com.atproto.identity.signPlcOperation',
      { alsoKnownAs: [`at://${HANDLE}`] },
      operationOf,
      token,
    );
    expect(signed.status).toBe(200);
    const held = signed.body.operation.verificationMethods.atproto_kem;
    expect(held).toMatch(/^did:key:zDna/u);

    // Somebody else's key would leave us unable to decapsulate for anyone who
    // resolved the document, so it is refused before the directory sees it.
    const other = await Effect.runPromise(
      generateES256KeyPair().pipe(
        Effect.flatMap((one) => createDIDKey(one.publicKey)),
      ),
    );
    const wrong = await pds.call(
      'com.atproto.identity.submitPlcOperation',
      {
        operation: {
          ...signed.body.operation,
          verificationMethods: {
            ...signed.body.operation.verificationMethods,
            atproto_kem: other,
          },
        },
      },
      errorMessageOf,
      token,
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toContain('Incorrect KEM key');

    // Nor is an operation that drops the key a match: the document would go back
    // to having none.
    const dropped = await pds.call(
      'com.atproto.identity.submitPlcOperation',
      {
        operation: {
          ...signed.body.operation,
          verificationMethods: {
            atproto: signed.body.operation.verificationMethods.atproto,
          },
        },
      },
      errorMessageOf,
      token,
    );
    expect(dropped.status).toBe(400);
    expect(dropped.body.message).toContain('Incorrect KEM key');
    expect(pds.submissions).toHaveLength(0);

    // The operation that names the held key still goes through, and carries it.
    const done = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({})),
    );
    const submitted = await pds.call(
      'com.atproto.identity.submitPlcOperation',
      { operation: signed.body.operation },
      done,
      token,
    );
    expect(submitted.status).toBe(200);
    await until(() => pds.submissions.length === 1, 40);
    expect(pds.submissions[0]).toContain(held);
  });

  it('lists the operator first, and still needs our own key named', async () => {
    // The network's operator holds an offline recovery key (`dhs6`), listed
    // *ahead* of ours: the order is the authority, and only a key before the
    // signer may nullify its operation — so a move stays undoable by the
    // operator and not by us.
    const operator = await Effect.runPromise(
      generateES256KeyPair().pipe(
        Effect.flatMap((one) => createDIDKey(one.publicKey)),
      ),
    );
    const pds = await startPds({ recoveryDidKey: operator });
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;

    const credentials = await pds.query(
      '/xrpc/com.atproto.identity.getRecommendedDidCredentials',
      credentialsOf,
      token,
    );
    expect(credentials.status).toBe(200);
    expect(credentials.body.rotationKeys).toEqual([
      operator,
      pds.rotationDidKey,
    ]);

    // And the operation we sign when the caller names no keys of its own —
    // which is the operation a mover hands the source to sign.
    const signed = await pds.call(
      'com.atproto.identity.signPlcOperation',
      { alsoKnownAs: [`at://${HANDLE}`] },
      operationOf,
      token,
    );
    expect(signed.status).toBe(200);
    expect(signed.body.operation.rotationKeys).toEqual([
      operator,
      pds.rotationDidKey,
    ]);

    // The operator's key is not ours, and an operation that still points *here* while naming only
    // the operator is one nobody could submit: refused, because it is a mistake rather than a
    // request. (Not because the list lacks our key — a handover never has ours in it.)
    const onlyOperator = await pds.call(
      'com.atproto.identity.signPlcOperation',
      { alsoKnownAs: [`at://${HANDLE}`], rotationKeys: [operator] },
      errorMessageOf,
      token,
    );
    expect(onlyOperator.status).toBe(400);
    expect(onlyOperator.body.message).toContain(
      'or the operation must point elsewhere',
    );

    // The same list with a different endpoint is a handover, and it signs: the account is leaving,
    // the destination's key is the one that will submit, and the operator's recovery key is listed
    // ahead of it so the move stays undoable by the operator.
    const leaving = await pds.call(
      'com.atproto.identity.signPlcOperation',
      {
        alsoKnownAs: [`at://${HANDLE}`],
        rotationKeys: [operator],
        services: {
          atproto_pds: {
            type: 'AtprotoPersonalDataServer',
            endpoint: 'https://pds.elsewhere.example',
          },
        },
      },
      operationOf,
      token,
    );
    expect(leaving.status).toBe(200);
    expect(leaving.body.operation.rotationKeys).toEqual([operator]);
    expect(leaving.body.operation.services.atproto_pds.endpoint).toBe(
      'https://pds.elsewhere.example',
    );

    // And the operation before it was signed and submitted here, because a switch nobody could undo
    // is not a switch a mover should be able to ask for by forgetting a step: the operator's key is
    // added ahead of ours while the DID still points at this PDS.
    expect(pds.submissions.length).toBe(1);
    const prepare = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          rotationKeys: Schema.Array(Schema.String),
          services: Schema.Struct({
            atproto_pds: Schema.Struct({ endpoint: Schema.String }),
          }),
        }),
      ),
    )(pds.submissions[0] ?? '{}');
    expect(prepare.rotationKeys).toEqual([operator, pds.rotationDidKey]);
    expect(prepare.services.atproto_pds.endpoint).toBe(`https://${DOMAIN}`);
  });

  it('publishes the handle it created, follows a rename, and removes it on delete', async () => {
    // The `_atproto` record is what makes a handle resolve where `/.well-known/atproto-did` cannot be
    // reached — a handle three labels deep under the PDS's own name has no host of its own.
    const pds = await startPds({ handleDns: true });
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const did = created.body.did;

    expect(pds.dnsCalls).toEqual([`publish:${HANDLE}:${did}`]);

    const renamed = await pds.call(
      'com.atproto.identity.updateHandle',
      { handle: `moved.${DOMAIN}` },
      (text) => Option.some(text),
      token,
    );
    expect(renamed.status).toBe(200);
    // The new name answers, and the old one stops: a resolver that still found the previous handle
    // would send clients to an account that has moved on.
    expect(pds.dnsCalls).toEqual([
      `publish:${HANDLE}:${did}`,
      `publish:moved.${DOMAIN}:${did}`,
      `remove:${HANDLE}`,
    ]);

    const removed = await pds.call(
      'com.atproto.server.deleteAccount',
      { did, password: PASSWORD },
      (text) => Option.some(text),
    );
    expect(removed.status).toBe(200);
    expect(pds.dnsCalls).toEqual([
      `publish:${HANDLE}:${did}`,
      `publish:moved.${DOMAIN}:${did}`,
      `remove:${HANDLE}`,
      `remove:moved.${DOMAIN}`,
    ]);
  });

  it('does not fail the account when DNS does', async () => {
    // The account is the authority and a record can be published again; a login that failed because
    // a zone API was rate-limited would be the worse trade.
    const pds = await startPds({ failingHandleDns: true });
    const created = await pds.createAccount(HANDLE);

    expect(created.status).toBe(200);
    expect(created.body.did).toBeTruthy();
  });

  it('refuses a recovery key that is not a did:key, rather than signing it in', async () => {
    // A key the directory would refuse is worth refusing here, where it is one
    // config line — not after the source has signed it into an operation.
    const pds = await startPds({ recoveryDidKey: 'did:key:nonsense' });
    const created = await pds.createAccount(HANDLE);

    const refused = await pds.query(
      '/xrpc/com.atproto.identity.getRecommendedDidCredentials',
      errorOf,
      created.body.accessJwt,
    );
    expect(refused.status).toBe(500);
  });

  it('answers what a migration asks both servers: the head, and how much', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const did = created.body.did;
    const done = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({})),
    );

    const before = await pds.call(
      'com.atproto.server.checkAccountStatus',
      {},
      accountStatusOf,
      token,
    );
    expect(before.status).toBe(200);
    expect(before.body.activated).toBe(true);
    expect(before.body.validDid).toBe(true);
    // The count is what the two sides are compared on, so it starts at nothing.
    expect(before.body.indexedRecords).toBe(0);

    await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: did,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
        record: { text: 'moved' },
      },
      done,
      token,
    );

    const after = await pds.call(
      'com.atproto.server.checkAccountStatus',
      {},
      accountStatusOf,
      token,
    );
    expect(after.body.indexedRecords).toBe(1);
    expect(after.body.repoRev).not.toBe('');

    // Nobody anonymous may ask: it is an account's own state.
    const anonymous = await pds.call(
      'com.atproto.server.checkAccountStatus',
      {},
      errorOf,
    );
    expect(anonymous.status).toBe(401);
  });

  it('lets nobody claim an identity this PDS does not hold, and creates nothing while refusing', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    // A DID this PDS mints is ours to hand out: it needs nothing said about it.
    expect(created.body.did).toMatch(/^did:web:pds\.example:/u);

    // A foreign DID with nothing to show. The refusal comes before the account exists, so no
    // account is left behind and the handle is still free.
    const bare = await pds.call(
      'com.atproto.server.createAccount',
      {
        handle: `bob.${DOMAIN}`,
        password: PASSWORD,
        did: 'did:web:pds.elsewhere:abc',
      },
      errorOf,
    );
    expect(bare.status).toBe(401);
    expect(bare.body).toEqual({ error: 'AuthRequired' });

    // An identity there is no document for at all: refused for the same reason and in the same
    // place, rather than trusted because a resolver cannot be asked.
    const unresolvable = await pds.call(
      'com.atproto.server.createAccount',
      {
        handle: `carol.${DOMAIN}`,
        password: PASSWORD,
        did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      },
      errorOf,
    );
    expect(unresolvable.status).toBe(401);

    // Neither refusal claimed the handle.
    const own = await pds.call(
      'com.atproto.server.createAccount',
      { handle: `bob.${DOMAIN}`, password: PASSWORD },
      sessionOf,
    );
    expect(own.status).toBe(200);
  });

  it('keeps private state, which is not a record and does not ride a repo', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const prefsOf = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({ preferences: Schema.Array(Schema.Json) }),
      ),
    );
    // `putPreferences` answers with an empty object, so the decoder has to accept one.
    const accepted = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({})),
    );

    // A fresh account has written nothing, and an empty list is what a client expects of one.
    const empty = await pds.query(
      '/xrpc/app.bsky.actor.getPreferences',
      prefsOf,
      token,
    );
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ preferences: [] });

    const written = [
      {
        $type: 'app.bsky.actor.defs#savedFeedsPrefV2',
        items: [{ type: 'feed', value: 'at://feed' }],
      },
      { $type: 'app.bsky.actor.defs#adultContentPref', enabled: true },
    ];
    const put = await pds.call(
      'app.bsky.actor.putPreferences',
      { preferences: written },
      accepted,
      token,
    );
    expect(put.status).toBe(200);

    // It comes back as it went in: the *shape* of a preference is the app's, not this PDS's.
    const back = await pds.query(
      '/xrpc/app.bsky.actor.getPreferences',
      prefsOf,
      token,
    );
    expect(back.body).toEqual({ preferences: written });

    // Nobody anonymous may read or write it: it is the account's own state.
    const anonymous = await pds.query(
      '/xrpc/app.bsky.actor.getPreferences',
      errorOf,
    );
    expect(anonymous.status).toBe(401);

    // And there is a ceiling a client can read, rather than one it fails into.
    const huge = await pds.call(
      'app.bsky.actor.putPreferences',
      {
        preferences: [
          { $type: 'app.bsky.actor.defs#x', big: 'y'.repeat(70_000) },
        ],
      },
      errorOf,
      token,
    );
    expect(huge.status).toBe(400);
    expect(huge.body).toMatchObject({ error: 'InvalidRequest' });
  });

  it('walks a collection with the cursor it hands back, instead of looping over page one', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const did = created.body.did;
    const accepted = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({})),
    );
    for (const rkey of ['one', 'two', 'three']) {
      await pds.call(
        'com.atproto.repo.createRecord',
        {
          repo: did,
          collection: 'app.bsky.feed.post',
          rkey,
          record: { text: rkey },
        },
        accepted,
        token,
      );
    }
    const pageOf = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({
          records: Schema.Array(
            Schema.Struct({ uri: Schema.String, cid: Schema.String }),
          ),
          cursor: Schema.optionalKey(Schema.String),
        }),
      ),
    );
    const at = (cursor?: string) =>
      `/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}&collection=${'app.bsky.feed.post'}&limit=2` +
      (cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`);

    const first = await pds.query(at(), pageOf, token);
    expect(first.status).toBe(200);
    expect(first.body.records).toHaveLength(2);
    expect(first.body.cursor).toBeDefined();

    // The second page is the rest of the collection -- the same first page twice is what the missing
    // cursor used to give, and it is why a client that pages loops.
    const second = await pds.query(at(first.body.cursor ?? ''), pageOf, token);
    expect(second.body.records).toHaveLength(1);
    const seen = [...first.body.records, ...second.body.records].map(
      (one) => one.uri,
    );
    expect(new Set(seen).size).toBe(3);
    // The end of a collection has no cursor to hand back.
    expect(second.body.cursor).toBeUndefined();
  });

  it('names the blobs the records reference and the store does not hold', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const did = created.body.did;
    const done = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({})),
    );

    const uploaded = await pds.raw(
      'com.atproto.repo.uploadBlob',
      new TextEncoder().encode('a picture'),
      'image/png',
      uploadOf,
      token,
    );
    expect(uploaded.status).toBe(200);
    const held = uploaded.body.blob;

    // A record naming a blob this repo holds: nothing is missing.
    await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: did,
        collection: 'app.bsky.feed.post',
        rkey: 'held',
        record: { text: 'has media', image: held },
      },
      done,
      token,
    );
    const none = await pds.call(
      'com.atproto.repo.listMissingBlobs',
      {},
      missingOf,
      token,
    );
    expect(none.status).toBe(200);
    expect(none.body.blobs).toEqual([]);

    // A blob that exists, but belongs to another account: this repo's records
    // name it and this repo does not hold it, which is what "missing" means —
    // and the malformed reference a migration cannot send is why the CID is real.
    const other = await pds.createAccount(`bob.${DOMAIN}`);
    const elsewhere = await pds.raw(
      'com.atproto.repo.uploadBlob',
      new TextEncoder().encode('elsewhere'),
      'image/png',
      uploadOf,
      other.body.accessJwt,
    );
    await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: did,
        collection: 'app.bsky.feed.post',
        rkey: 'gone',
        record: { text: 'lost media', image: elsewhere.body.blob },
      },
      done,
      token,
    );

    const some = await pds.call(
      'com.atproto.repo.listMissingBlobs',
      {},
      missingOf,
      token,
    );
    expect(some.body.blobs).toEqual([
      {
        cid: elsewhere.body.blob.ref.$link,
        recordUri: `at://${did}/app.bsky.feed.post/gone`,
      },
    ]);

    // Nobody anonymous may ask it: it is a repo's own state.
    const anonymous = await pds.call(
      'com.atproto.repo.listMissingBlobs',
      {},
      errorOf,
    );
    expect(anonymous.status).toBe(401);
  });

  it('serves the backfill: the latest commit, and the repo as a CAR', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;
    const alice = created.body.did;

    const carOf = async (repo: string) => {
      const response = await fetch(
        `${pds.base}/xrpc/com.atproto.sync.getRepo?did=${repo}`,
      );
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    };

    const empty = await carOf(HANDLE);
    expect(empty.status).toBe(200);
    expect(empty.type).toBe('application/vnd.ipld.car');
    expect(empty.bytes.length).toBeGreaterThan(0);

    const latest = await pds.query(
      `/xrpc/com.atproto.sync.getLatestCommit?did=${alice}`,
      latestCommitOf,
    );
    expect(latest.status).toBe(200);
    expect(latest.body.cid).toMatch(/^bafy/u);
    expect(latest.body.rev.length).toBeGreaterThan(0);

    // Who lives here, with the head a backup sweep needs: a list typed in by hand would miss the
    // next account.
    const listed = await pds.query(
      '/xrpc/com.atproto.sync.listRepos',
      listReposOf,
    );
    expect(listed.status).toBe(200);
    const mine = listed.body.repos.find((one) => one.did === alice);
    expect(mine?.rev).toBe(latest.body.rev);
    expect(mine?.head).toMatch(/^bafy/u);

    // A page is a page: the cursor is the last DID served, and the next call starts after it.
    const one = await pds.query(
      '/xrpc/com.atproto.sync.listRepos?limit=1',
      listReposOf,
    );
    expect(one.body.repos.length).toBe(1);
    if (one.body.cursor !== undefined) {
      const next = await pds.query(
        `/xrpc/com.atproto.sync.listRepos?limit=1&cursor=${encodeURIComponent(one.body.cursor)}`,
        listReposOf,
      );
      expect(next.body.repos[0]?.did).not.toBe(one.body.repos[0]?.did);
    }

    // A write makes the backfill bigger: the CAR carries what the stream carries.
    const written = await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
        record: { text: 'a record for the relay' },
      },
      commitOf,
      token,
    );
    expect(written.status).toBe(200);
    const after = await carOf(HANDLE);
    expect(after.bytes.length).toBeGreaterThan(empty.bytes.length);

    // A handle resolves here too, and a repo that is not here is not found.
    const unknown = await pds.query(
      '/xrpc/com.atproto.sync.getRepo?did=nobody.pds.example',
      errorOf,
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: 'RepoNotFound' });
  });

  it('mails a deletion token, and takes it to delete the account', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(
      HANDLE,
      undefined,
      `alice@${DOMAIN}`,
    );
    const session = created.body.accessJwt;
    const did = created.body.did;

    const asked = await pds.call(
      'com.atproto.server.requestAccountDelete',
      { did },
      (text) => Option.some(text),
      session,
    );
    expect(asked.status).toBe(200);

    // The message went out, and the token is in it — which is the only way a
    // token reaches the person it belongs to.
    expect(pds.mails).toHaveLength(1);
    const token = (pds.mails[0]?.body ?? '').split(': ').at(-1) ?? '';
    expect(token.length).toBeGreaterThan(20);

    // A token that is wrong proves nothing, and does not spend the real one.
    const wrong = await pds.call(
      'com.atproto.server.deleteAccount',
      { did, token: 'not-the-token' },
      (text) => Option.some(text),
      session,
    );
    expect(wrong.status).toBe(401);

    const deleted = await pds.call(
      'com.atproto.server.deleteAccount',
      { did, token },
      (text) => Option.some(text),
      session,
    );
    expect(deleted.status).toBe(200);

    // The repo went with the account, which is what deleting means here.
    const gone = await pds.query(
      `/xrpc/com.atproto.sync.getRepoStatus?did=${did}`,
      (text) => Option.some(text),
    );
    expect(gone.status).toBe(400);
  });

  it('an operator deletes an account: the repo goes, and the handle is free to claim', async () => {
    const pds = await startPds();
    const moderator = await pds.createAccount('moderator.pds.example');
    const member = await pds.createAccount('member.pds.example');
    const memberDid = member.body.did;

    // A caller who does not moderate cannot delete an account — deletion is the sharpest move
    // there is, and it is the operator's.
    const refused = await pds.call(
      'com.atproto.admin.deleteAccount',
      { did: memberDid },
      (text) => Option.some(text),
      member.body.accessJwt,
    );
    expect(refused.status).toBe(403);

    pds.admins.push(moderator.body.did);
    const deleted = await pds.call(
      'com.atproto.admin.deleteAccount',
      { did: memberDid },
      (text) => Option.some(text),
      moderator.body.accessJwt,
    );
    expect(deleted.status).toBe(200);

    // The repo is gone with it...
    const car = await pds.query(
      `/xrpc/com.atproto.sync.getRepo?did=${memberDid}`,
      (text) => Option.some(text),
    );
    expect(car.status).toBe(400);

    // ...and the handle is free, which is the part a deletion has to leave behind: the spec
    // releases it so somebody else can take it, and a new account means a new DID.
    const reclaimed = await pds.createAccount('member.pds.example');
    expect(reclaimed.status).toBe(200);
    expect(reclaimed.body.did).not.toBe(memberDid);
  });

  it('takes an account down so a reader stops seeing it, and puts it back', async () => {
    const pds = await startPds();
    const member = await pds.createAccount(HANDLE);
    const moderator = await pds.createAccount(`mod.${DOMAIN}`);
    const memberDid = member.body.did;

    const written = await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
        record: { text: 'before the takedown' },
      },
      (text) => Option.some(text),
      member.body.accessJwt,
    );
    expect(written.status).toBe(200);

    const reading = `/xrpc/com.atproto.repo.getRecord?repo=${HANDLE}&collection=app.bsky.feed.post&rkey=one`;
    const visible = await pds.query(reading, (text) => Option.some(text));
    expect(visible.status).toBe(200);

    // A caller who does not moderate cannot take an account down.
    const refused = await pds.call(
      'com.atproto.admin.moderateAccount',
      { account: memberDid, action: 'takedown' },
      (text) => Option.some(text),
      moderator.body.accessJwt,
    );
    expect(refused.status).toBe(403);

    // An operator's moderator can — and a reader stops seeing the account, which
    // is the whole of what a takedown is.
    pds.admins.push(moderator.body.did);
    const taken = await pds.call(
      'com.atproto.admin.moderateAccount',
      { account: memberDid, action: 'takedown' },
      (text) => Option.some(text),
      moderator.body.accessJwt,
    );
    expect(taken.status).toBe(200);

    const hidden = await pds.query(reading, (text) => Option.some(text));
    expect(hidden.status).toBe(400);
    const car = await pds.query(
      `/xrpc/com.atproto.sync.getRepo?did=${memberDid}`,
      (text) => Option.some(text),
    );
    expect(car.status).toBe(400);

    // The member cannot speak either: a session is a predicate over the status.
    const silenced = await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'two',
        record: { text: 'while taken down' },
      },
      (text) => Option.some(text),
      member.body.accessJwt,
    );
    expect(silenced.status).toBe(401);

    // And reinstating brings it back untouched.
    const back = await pds.call(
      'com.atproto.admin.moderateAccount',
      { account: memberDid, action: 'reinstate' },
      (text) => Option.some(text),
      moderator.body.accessJwt,
    );
    expect(back.status).toBe(200);

    const again = await pds.query(reading, (text) => Option.some(text));
    expect(again.status).toBe(200);
  });

  it('mails a verification token, and takes it to confirm the address', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(
      HANDLE,
      undefined,
      `alice@${DOMAIN}`,
    );
    const session = created.body.accessJwt;

    // Nothing is confirmed to start with.
    const before = await pds.call(
      'com.atproto.server.getSession',
      {},
      (one) => Option.some(one),
      session,
    );
    expect(before.body).toContain('"emailConfirmed":false');

    const asked = await pds.call(
      'com.atproto.server.requestEmailVerification',
      {},
      (one) => Option.some(one),
      session,
    );
    expect(asked.status).toBe(200);

    // The token reaches the person it belongs to by mail, and only by mail.
    expect(pds.mails).toHaveLength(1);
    const token = (pds.mails[0]?.body ?? '').split(': ').at(-1) ?? '';
    expect(token.length).toBeGreaterThan(20);

    // A token that is wrong proves nothing, and does not spend the real one.
    const wrong = await pds.call(
      'com.atproto.server.confirmEmail',
      { email: `alice@${DOMAIN}`, token: 'not-the-token' },
      (one) => Option.some(one),
      session,
    );
    expect(wrong.status).toBe(400);

    const confirmed = await pds.call(
      'com.atproto.server.confirmEmail',
      { email: `alice@${DOMAIN}`, token },
      (one) => Option.some(one),
      session,
    );
    expect(confirmed.status).toBe(200);

    const after = await pds.call(
      'com.atproto.server.getSession',
      {},
      (one) => Option.some(one),
      session,
    );
    expect(after.body).toContain('"emailConfirmed":true');
  });

  it('takes a record down so a reader stops finding it, and puts it back', async () => {
    const pds = await startPds();
    const member = await pds.createAccount(HANDLE);
    const moderator = await pds.createAccount(`mod.${DOMAIN}`);
    pds.admins.push(moderator.body.did);
    const session = member.body.accessJwt;

    const written = await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
        record: { text: 'before the takedown' },
      },
      (one) => Option.some(one),
      session,
    );
    expect(written.status).toBe(200);

    const reading = `/xrpc/com.atproto.repo.getRecord?repo=${HANDLE}&collection=app.bsky.feed.post&rkey=one`;
    const cidOf = (text: string) =>
      Schema.decodeUnknownOption(Schema.Struct({ cid: Schema.String }))(
        JSON.parse(text),
      );
    const before = await pds.query(reading, cidOf);
    expect(before.status).toBe(200);

    const takedown = await pds.call(
      'com.atproto.admin.moderateRecord',
      {
        uri: `at://${member.body.did}/app.bsky.feed.post/one`,
        action: 'takedown',
      },
      (one) => Option.some(one),
      moderator.body.accessJwt,
    );
    expect(takedown.status).toBe(200);

    // A takedown *removes* the record rather than hiding it: a reader that has
    // the CID finds nothing, which is the correct outcome.
    const gone = await fetch(`${pds.base}${reading}`);
    expect(gone.status).toBe(400);

    const reverse = await pds.call(
      'com.atproto.admin.moderateRecord',
      {
        uri: `at://${member.body.did}/app.bsky.feed.post/one`,
        action: 'reverse',
      },
      (one) => Option.some(one),
      moderator.body.accessJwt,
    );
    expect(reverse.status).toBe(200);

    // And it comes back as it was — the bytes are the record's identity, so the
    // CID is the one it had before.
    const again = await pds.query(reading, cidOf);
    expect(again.status).toBe(200);
    expect(again.body.cid).toBe(before.body.cid);

    // A blob is public because it is content-addressed, but not from an account
    // that was taken down: that stops being served too.
    const picture = new TextEncoder().encode('a picture');
    const uploaded = await pds.raw(
      'com.atproto.repo.uploadBlob',
      picture,
      'image/png',
      (one) => Option.some(one),
      session,
    );
    const blobCid = /"\$link":"([^"]+)"/u.exec(uploaded.body)?.[1] ?? '';
    const reachable = await fetch(
      `${pds.base}/xrpc/com.atproto.sync.getBlob?did=${member.body.did}&cid=${blobCid}`,
    );
    expect(reachable.status).toBe(200);

    const taken = await pds.call(
      'com.atproto.admin.moderateAccount',
      { account: member.body.did, action: 'takedown' },
      (one) => Option.some(one),
      moderator.body.accessJwt,
    );
    expect(taken.status).toBe(200);
    const hidden = await fetch(
      `${pds.base}/xrpc/com.atproto.sync.getBlob?did=${member.body.did}&cid=${blobCid}`,
    );
    expect(hidden.status).toBe(400);
  });

  it('imports a repo exported from another store, and reads the same', async () => {
    const source = await startPds();
    const target = await startPds();

    const from = await source.createAccount(HANDLE);
    const to = await target.createAccount(HANDLE);

    // The records read the same, and — the stronger claim a migration needs —
    // they keep their CIDs: a record's identity *is* its bytes, and the CAR's
    // bytes go to the store as they are (bean mluh).
    const textOf = (text: string) =>
      Schema.decodeUnknownOption(
        Schema.Struct({
          cid: Schema.String,
          value: Schema.Struct({ text: Schema.String }),
        }),
      )(JSON.parse(text));

    for (const [rkey, text] of [
      ['one', 'first'],
      ['two', 'second'],
    ] as const) {
      const written = await source.call(
        'com.atproto.repo.createRecord',
        {
          repo: HANDLE,
          collection: 'app.bsky.feed.post',
          rkey,
          record: { text },
        },
        (one) => Option.some(one),
        from.body.accessJwt,
      );
      expect(
        written.status,
        `createRecord: ${JSON.stringify(written.body)}`,
      ).toBe(200);
    }

    // The stream is watched before the import, because the trail is half of
    // what a migration is: a relay has to learn the repo is here.
    const frames: Uint8Array[] = [];
    const watching = new WebSocket(`${target.ws}${SUBSCRIBE_PATH}`);
    watching.on('message', (data) => {
      frames.push(new Uint8Array(data as Buffer));
    });
    await new Promise((resolve) => {
      watching.on('open', resolve);
    });

    // The CAR the source answers with is the whole repo.
    const exported = await fetch(
      `${source.base}/xrpc/com.atproto.sync.getRepo?did=${from.body.did}`,
    );
    expect(exported.status).toBe(200);
    const car = new Uint8Array(await exported.arrayBuffer());
    expect(car.length).toBeGreaterThan(0);

    // Read the source's records while it is still serving — a deactivated
    // account is not served, so everything read from the source has to happen
    // before `deactivateAccount`, and that includes what we compare against.
    const before = new Map<string, { cid: string; text: string }>();
    for (const rkey of ['one', 'two']) {
      const held = await source.query(
        `/xrpc/com.atproto.repo.getRecord?repo=${from.body.did}&collection=app.bsky.feed.post&rkey=${rkey}`,
        textOf,
      );
      expect(held.status).toBe(200);
      before.set(rkey, { cid: held.body.cid, text: held.body.value.text });
    }

    // A blob goes the same way a repo does: fetched from the source, uploaded to
    // the destination — and a blob's identity is its bytes, so the CID matches.
    const picture = new TextEncoder().encode('a picture');
    const uploaded = await source.raw(
      'com.atproto.repo.uploadBlob',
      picture,
      'image/png',
      (one) => Option.some(one),
      from.body.accessJwt,
    );
    expect(uploaded.status).toBe(200);
    // A blob answers with `{$type, ref: {$link}, mimeType, size}` — the CID is
    // the link, the same way a record's is.
    const blobCid = /"\$link":"([^"]+)"/u.exec(uploaded.body)?.[1] ?? '';
    expect(blobCid.length).toBeGreaterThan(10);

    const fetched = await fetch(
      `${source.base}/xrpc/com.atproto.sync.getBlob?did=${from.body.did}&cid=${blobCid}`,
    );
    expect(fetched.status).toBe(200);
    const carried = await target.raw(
      'com.atproto.repo.uploadBlob',
      new Uint8Array(await fetched.arrayBuffer()),
      'image/png',
      (one) => Option.some(one),
      to.body.accessJwt,
    );
    expect(carried.status).toBe(200);
    expect(carried.body).toContain(blobCid);

    // And the source is taken down *after* it has been read: a deactivated
    // account is not served, so the export has to come first. That order is the
    // flow, and it is why the ticket asks for both verbs.
    const off = await source.call(
      'com.atproto.server.deactivateAccount',
      {},
      (one) => Option.some(one),
      from.body.accessJwt,
    );
    expect(off.status).toBe(200);

    const gone = await fetch(
      `${source.base}/xrpc/com.atproto.sync.getRepo?did=${from.body.did}`,
    );
    expect(gone.status).toBe(400);
    const silenced = await source.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'three',
        record: { text: 'after the move' },
      },
      (one) => Option.some(one),
      from.body.accessJwt,
    );
    expect(silenced.status).toBe(401);

    // A CAR arrives as a body, not as JSON: this is the raw one.
    const imported = await fetch(
      `${target.base}/xrpc/com.atproto.repo.importRepo`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.ipld.car',
          Authorization: `Bearer ${to.body.accessJwt}`,
        },
        body: car,
      },
    );
    if (imported.status !== 200) {
      throw new Error(
        `importRepo: ${imported.status} ${await imported.text()}`,
      );
    }

    for (const rkey of ['one', 'two']) {
      const after = await target.query(
        `/xrpc/com.atproto.repo.getRecord?repo=${to.body.did}&collection=app.bsky.feed.post&rkey=${rkey}`,
        textOf,
      );
      expect(
        after.status,
        `getRecord ${rkey}: ${JSON.stringify(after.body)}`,
      ).toBe(200);
      const was = before.get(rkey);
      expect(after.body.value.text).toBe(was?.text);
      expect(after.body.cid, `cid ${rkey} survives the import`).toBe(was?.cid);
    }

    // And the move is on the stream: a `#commit`, not silence.
    await expect
      .poll(() => frames.length, { timeout: 5000 })
      .toBeGreaterThan(0);
    const header = Buffer.from(encodeCbor({ op: 1, t: '#commit' }));
    expect(
      Buffer.from(frames[0] ?? new Uint8Array()).subarray(0, header.length),
    ).toEqual(header);
    watching.close();

    // An import arrives into an account that has not been written to, so a
    // second one is refused rather than merged over a live repo.
    const again = await fetch(
      `${target.base}/xrpc/com.atproto.repo.importRepo`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.ipld.car',
          Authorization: `Bearer ${to.body.accessJwt}`,
        },
        body: car,
      },
    );
    expect(again.status).toBe(400);
  });

  it('serves the firehose on a socket, as sync 1.1 frames', async () => {
    const pds = await startPds();
    const created = await pds.createAccount(HANDLE);
    const token = created.body.accessJwt;

    const opened = new WebSocket(`${pds.ws}${SUBSCRIBE_PATH}`);
    const frames: Uint8Array[] = [];
    opened.on('message', (data) => {
      frames.push(new Uint8Array(data as Buffer));
    });
    await within(
      new Promise((resolve) => opened.on('open', resolve)),
      'the socket to open',
    );

    // A write it caused comes out as one `#commit` frame: the CBOR header, then
    // the CBOR body, back to back — which is the whole of sync 1.1.
    const written = await pds.call(
      'com.atproto.repo.createRecord',
      {
        repo: HANDLE,
        collection: 'app.bsky.feed.post',
        rkey: 'one',
        record: { text: 'over the wire' },
      },
      commitOf,
      token,
    );
    expect(written.status).toBe(200);
    await until(() => frames.length > 0, 40);

    const first = Buffer.from(frames[0] ?? new Uint8Array());
    const header = Buffer.from(encodeCbor({ op: 1, t: '#commit' }));
    expect(first.subarray(0, header.length)).toEqual(header);
    // ...and the body carries the block for the record the write touched.
    expect(
      first.includes(Buffer.from(new TextEncoder().encode('over the wire'))),
    ).toBe(true);

    opened.close();

    // A cursor we cannot honour is said out loud before any frame, so a client
    // that resumes from one knows to start over rather than to wait.
    // The stream counts microseconds, so a cursor a second ahead of it is past
    // the head — which is the one refusal a fresh client can actually ask for.
    const refused = new WebSocket(
      `${pds.ws}${SUBSCRIBE_PATH}?cursor=${Date.now() * 1000 + 1_000_000}`,
    );
    const said: Uint8Array[] = [];
    refused.on('message', (data) => {
      said.push(new Uint8Array(data as Buffer));
    });
    await within(
      new Promise((resolve) => refused.on('close', resolve)),
      'the refusal to close the socket',
    );

    const info = Buffer.from(encodeCbor({ op: 1, t: '#info' }));
    expect(
      Buffer.from(said[0] ?? new Uint8Array()).subarray(0, info.length),
    ).toEqual(info);
  });
});
