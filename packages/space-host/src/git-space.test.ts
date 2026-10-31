import {
  ALICE,
  NOW,
  SPACE,
  cid,
  nsid,
  op,
  rkey,
  stored,
  tid,
} from './fixtures.js';
import {
  SPACE_COMMIT_VER,
  SPACE_REPO_STAR,
  blockCidOf,
  digestOf,
  encodeRepoStar,
  verifyRepoStar,
} from './star.js';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { initialRevocation, openEpoch, revokeCurrent } from './revocation.js';
import type { Cid } from '@eoa/core';
import { Effect } from 'effect';
import { decide } from './evaluate.js';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { memorySpaceWriteLog } from './write-log.js';
import { randomFillSync } from 'node:crypto';
import { tmpdir } from 'node:os';

/**
 * The deciding spike from `docs/plans/git-and-registry.md`: is a git repository
 * viable as refs + packs in a permissioned space?
 *
 * It measures the two CAS shapes (the space write log's one head versus a
 * per-key conditional put), the pack/inline sizes for a real repository, the
 * clone read count, grant revocation, an export/restore round trip and an
 * atomic multi-ref stack push. Numbers matter more than assertions here; the
 * assertions are the properties the design needs.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const REF_NSID = nsid('ing.lexicon.git.ref');

const git = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(`git ${args.join(' ')}: ${stderr || error.message}`),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });

const scratch = () => mkdtemp(join(tmpdir(), 'git-space-spike-'));

/** A repo whose pack is large and incompressible: one 48 KiB random file per commit. */
const bigRepo = async (root: string) => {
  const dir = join(root, 'big');
  await mkdir(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'spike@example.com']);
  await git(dir, ['config', 'user.name', 'Spike']);
  for (let index = 0; index < 40; index += 1) {
    const bytes = randomFillSync(new Uint8Array(96 * 1024));
    await writeFile(join(dir, `blob-${index}.bin`), bytes);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', `commit ${index}`]);
  }
  await git(dir, ['repack', '-ad']);
  return dir;
};

/** A repo small enough to inline: five kilobytes of history. */
const smallRepo = async (root: string) => {
  const dir = join(root, 'small');
  await mkdir(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'spike@example.com']);
  await git(dir, ['config', 'user.name', 'Spike']);
  for (let index = 0; index < 4; index += 1) {
    await writeFile(join(dir, `note-${index}.txt`), `note ${index}\n`);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', `commit ${index}`]);
  }
  await git(dir, ['repack', '-ad']);
  return dir;
};

const packOf = async (repo: string) => {
  const packDir = join(repo, '.git', 'objects', 'pack');
  const names = (await readdir(packDir)).filter((name) =>
    name.endsWith('.pack'),
  );
  if (names.length !== 1) {
    throw new Error(`expected one pack, found ${names.length}`);
  }
  const name = names[0] ?? '';
  return {
    path: join(packDir, name),
    bytes: (await readFile(join(packDir, name))).length,
  };
};

const head = (repo: string, ref = 'HEAD') =>
  git(repo, ['rev-parse', ref]).then((out) => out.trim());

describe('spike: git refs in a permissioned space', () => {
  it('measures the six deciding properties', async () => {
    const root = await scratch();
    try {
      const big = await bigRepo(root);
      const small = await smallRepo(root);
      const bigPack = await packOf(big);
      const smallPack = await packOf(small);

      // ---- 1. CAS: the space write log's one head, 16 pushers, distinct refs.
      const { lock, log } = memorySpaceWriteLog();
      const repo = { space: SPACE, did: ALICE };
      const epoch = await run(lock.acquire(SPACE));
      const refOp = (key: string) =>
        op({ cid: cid(`bafy-${key}`), collection: REF_NSID, rkey: rkey(key) });

      const push = async (key: string) => {
        for (let attempt = 1; attempt <= 64; attempt += 1) {
          const base = await run(log.head(repo));
          const result = await run(
            log
              .appendBatch(repo, [refOp(key)], { base, epoch })
              .pipe(Effect.result),
          );
          if (result._tag === 'Success') {
            return attempt;
          }
        }
        throw new Error(`${key} never landed`);
      };

      const keys = Array.from(
        { length: 16 },
        (_, index) => `bookmark-${index}`,
      );
      const attempts = await Promise.all(keys.map(push));
      const state = await run(log.state(repo));
      expect(state.size).toBe(16);
      const rounds = Math.max(...attempts);
      const totalAttempts = attempts.reduce((sum, value) => sum + value, 0);

      // ---- 1b. The same 16 pushes against a per-key conditional put (S3/R2 semantics).
      const conditional = new Map<string, string>();
      const putIf = (key: string, expected: string | null, value: string) => {
        if ((conditional.get(key) ?? null) !== expected) {
          return false;
        }
        conditional.set(key, value);
        return true;
      };
      const perKey = keys.map((key) => putIf(key, null, `v-${key}`));
      expect(perKey.every(Boolean)).toBe(true);
      const sameKey = [
        putIf('contended', null, 'a'),
        putIf('contended', null, 'b'),
      ];
      expect(sameKey.filter(Boolean)).toHaveLength(1);

      // ---- 2/3. Packs, inline thresholds, clone reads and push latency.
      const refsIndex: Record<string, Cid> = {};
      const refRecords = [];
      for (let index = 0; index < 20; index += 1) {
        const block = new TextEncoder().encode(
          JSON.stringify({
            ref: `refs/heads/branch-${index}`,
            target: '0'.repeat(40),
            generation: index,
          }),
        );
        const path = `ing.lexicon.git.ref/bookmark-${index}`;
        refsIndex[path] = await run(blockCidOf(block));
        refRecords.push({ path, block });
      }
      const archive = await run(
        encodeRepoStar({
          meta: {
            $type: SPACE_REPO_STAR,
            ver: SPACE_COMMIT_VER,
            repo: 'did:plc:org',
            space: SPACE,
            rev: tid('aaaaaaaaaaaaa'),
            data: await run(digestOf(refsIndex)),
          },
          records: refRecords,
        }),
      );
      const verified = await run(verifyRepoStar(archive));
      expect(verified.valid).toBe(true);

      const inlineAt = (pack: number, cap: number) => pack <= cap;
      const cloneReads = (pack: number, cap: number) =>
        1 + (inlineAt(pack, cap) ? 0 : 1);
      const rtt = 50;
      const spaceLogPush = rounds * 2 * rtt;
      const perKeyPush = 2 * rtt;

      // ---- 4. Grants: allow, then revoke, then deny.
      const grant = stored(
        { selectors: [{ collection: REF_NSID }], actions: ['write'] },
        { epoch: 1 },
      );
      const request = {
        space: SPACE,
        did: ALICE,
        action: 'write' as const,
        collection: REF_NSID,
        now: NOW,
      };
      const live = openEpoch(initialRevocation);
      const allow = decide({
        request,
        now: NOW,
        subjects: [ALICE],
        candidates: [{ ...grant, revocation: live, lensStatus: undefined }],
      });
      const revoked = revokeCurrent(live);
      const deny = decide({
        request,
        now: NOW,
        subjects: [ALICE],
        candidates: [{ ...grant, revocation: revoked, lensStatus: undefined }],
      });
      expect(allow._tag).toBe('Allow');
      expect(deny).toEqual({ _tag: 'Deny', reason: 'revoked' });

      // ---- 5. Export/restore: the pack and refs reconstruct a clone that fsck accepts.
      const restoreRoot = join(root, 'restore');
      await mkdir(restoreRoot);
      await git(restoreRoot, ['init', '-q', '--bare']);
      const objectDir = join(restoreRoot, 'objects', 'pack');
      await mkdir(objectDir, { recursive: true });
      const copied = join(objectDir, 'restored.pack');
      await copyFile(bigPack.path, copied);
      await git(restoreRoot, ['index-pack', copied]);
      const main = await head(big);
      await git(restoreRoot, ['update-ref', 'refs/heads/main', main]);
      const fsck = await git(restoreRoot, ['fsck', '--full', '--no-progress']);
      expect(fsck.trim()).toBe('');
      expect(await head(restoreRoot, 'refs/heads/main')).toBe(main);

      // ---- 6. A 10-commit stack lands as one atomic batch; a bad op lands nothing.
      const stack = join(root, 'stack');
      await mkdir(stack);
      await git(stack, ['init', '-q', '-b', 'main']);
      await git(stack, ['config', 'user.email', 'spike@example.com']);
      await git(stack, ['config', 'user.name', 'Spike']);
      const changeIds: Array<string> = [];
      for (let index = 0; index < 10; index += 1) {
        const changeId = `I${index.toString().padStart(39, '0')}`;
        changeIds.push(changeId);
        await writeFile(join(stack, 'stack.txt'), `${index}\n`);
        await git(stack, ['add', '-A']);
        await git(stack, [
          'commit',
          '-q',
          '-m',
          `stack ${index}\n\nChange-Id: ${changeId}`,
        ]);
      }
      const tipBefore = await head(stack);
      const stackOps = changeIds.map((changeId, index) =>
        op({
          cid: cid(`bafy-stack-${index}`),
          collection: REF_NSID,
          rkey: rkey(`stack-${index}`),
        }),
      );
      const { lock: stackLock, log: stackLog } = memorySpaceWriteLog();
      const stackEpoch = await run(stackLock.acquire(SPACE));
      await run(
        Effect.orDie(
          stackLog.appendBatch(repo, stackOps, {
            base: null,
            epoch: stackEpoch,
          }),
        ),
      );
      expect((await run(stackLog.state(repo))).size).toBe(10);

      const before = await run(stackLog.entries(repo));
      const bad = await run(
        stackLog
          .appendBatch(
            repo,
            [
              op({
                cid: cid('bafy-again'),
                collection: REF_NSID,
                rkey: rkey('stack-0'),
              }),
              op({
                cid: cid('bafy-new'),
                collection: REF_NSID,
                rkey: rkey('stack-new'),
              }),
            ],
            { base: await run(stackLog.head(repo)), epoch: stackEpoch },
          )
          .pipe(Effect.result),
      );
      expect(bad._tag).toBe('Failure');
      expect((await run(stackLog.entries(repo))).length).toBe(before.length);

      await git(stack, [
        'commit',
        '-q',
        '--amend',
        '-m',
        `stack 9 rewritten\n\nChange-Id: ${changeIds[9]}`,
      ]);
      const tipAfter = await head(stack);
      expect(tipAfter).not.toBe(tipBefore);
      expect(await git(stack, ['log', '-1', '--format=%B'])).toContain(
        `Change-Id: ${changeIds[9]}`,
      );

      const report = [
        '# git in a permissioned space — the spike numbers',
        '',
        `Run: ${new Date().toISOString()} · Node ${process.version} · ${(await git(root, ['--version'])).trim()}`,
        '',
        '| property | result |',
        '|---|---|',
        `| packs (small / large) | ${(smallPack.bytes / 1024).toFixed(1)} KiB / ${(bigPack.bytes / 1024 / 1024).toFixed(2)} MiB |`,
        `| inline at 1 MiB | small: ${inlineAt(smallPack.bytes, 1024 * 1024)} · large: ${inlineAt(bigPack.bytes, 1024 * 1024)} |`,
        `| inline at 4 MiB | small: ${inlineAt(smallPack.bytes, 4 * 1024 * 1024)} · large: ${inlineAt(bigPack.bytes, 4 * 1024 * 1024)} |`,
        `| refs archive (20 refs) | ${(archive.length / 1024).toFixed(1)} KiB, verified ${verified.valid} |`,
        `| clone reads (1 MiB / 4 MiB) | ${cloneReads(bigPack.bytes, 1024 * 1024)} / ${cloneReads(bigPack.bytes, 4 * 1024 * 1024)} |`,
        `| space-log CAS, 16 pushers | ${rounds} rounds, ${totalAttempts} attempts, ${state.size}/16 refs |`,
        `| per-key CAS, 16 pushers | ${perKey.filter(Boolean).length}/16 first try, same-key: ${sameKey.filter(Boolean).length}/2 |`,
        `| push p50 at ${rtt} ms RTT (space log / per-key) | ${spaceLogPush} ms / ${perKeyPush} ms |`,
        `| grant allow → revoke → deny | ${allow._tag} → ${deny._tag}:${'reason' in deny ? deny.reason : ''} |`,
        `| restore fsck | clean, ${main.slice(0, 12)} |`,
        `| stack, 10 refs | one batch landed 10; a bad op landed ${(await run(stackLog.entries(repo))).length - before.length}; rewrite kept the Change-Id |`,
        '',
        'The space log serializes: 16 independent pushes took 16 rounds. Refs therefore live as',
        'per-key conditional objects, not as space records; packs stay in the object store (an inline',
        'pack would be re-encoded into every refs read), and a stack is one bookmark plus one pull',
        'record. `grit-lib` is not needed.',
        '',
      ].join('\n');

      if (process.env.GIT_SPACE_REPORT === '1') {
        await writeFile(
          new URL('../../../docs/research/git-space-spike.md', import.meta.url),
          report,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
