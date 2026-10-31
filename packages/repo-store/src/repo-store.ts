import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Head, StoredBlock, StoredRecord } from './types.js';
import { Kv, deleteOp, putOp } from '@eoa/kv';
import type { KvError, Sequence, Value } from '@eoa/kv';
import { CorruptRow } from './types.js';

/** How many rows a single scan will read; a streaming iterator is the next step. */
const SCAN_LIMIT = 10_000;

/** The head of a repo: the commit it is at, and the revision. */
const headKey = (did: string) => `h/${did}`;

/** A record, under its collection and record key. */
const recordsUnder = (did: string) => `R/${did}/`;

const recordKey = (did: string, key: string) => `${recordsUnder(did)}${key}`;

/** A node's block, under its own CID — the same way a subtree links to it. */
const nodesUnder = (did: string) => `M/${did}/`;

const nodeKey = (did: string, cid: string) => `${nodesUnder(did)}${cid}`;

/** A commit's block, under its own CID: the repo's name at a revision. */
const commitsUnder = (did: string) => `C/${did}/`;

/** What a moderator took down, kept so a reversal can put it back. */
const takedownsUnder = (did: string) => `T/${did}/`;

const takedownKey = (did: string, key: string) =>
  `${takedownsUnder(did)}${key}`;

const commitKey = (did: string, cid: string) => `${commitsUnder(did)}${cid}`;

const HeadSchema = Schema.Struct({ root: Schema.String, rev: Schema.String });

const decodeHead = Schema.decodeUnknownOption(
  Schema.fromJsonString(HeadSchema),
);
const encodeHead = Schema.encodeSync(Schema.fromJsonString(HeadSchema));

/** A node that branches on nothing: a leaf, whose rows are the records. */
const utf8 = (value: string) => new TextEncoder().encode(value);

const text = (value: Uint8Array) => new TextDecoder().decode(value);

/** A repo as a cold read finds it: the head, and every interior node. */
export interface Loaded {
  readonly head: Option.Option<Head>;
  readonly nodes: ReadonlyArray<StoredBlock>;
}

/**
 * The repo model on the KV (the Effect-PDS map, `5cyc`).
 *
 * Four row families, and one rule that makes the third smaller than it looks:
 *
 * - `h/{did}` — the head: the commit the repo is at, and its revision.
 * - `R/{did}/{collection}/{rkey}` — a record, as the bytes it is.
 * - `M/{did}/{cid}` — an **interior** node's block. A node that branches on
 *   nothing is a leaf, and leaves are never stored: their keys *and* values are
 *   the `R/` rows in their range, so the tree costs rows only where it branches.
 * - `C/{did}/{cid}` — a commit's block, so a revision can be served.
 *
 * A cold repo is the head plus **one `M/` scan** — which is why the layout
 * keeps every node under one prefix rather than spreading it across the tree.
 */
export class RepoStore extends Context.Service<
  RepoStore,
  {
    readonly head: (
      did: string,
    ) => Effect.Effect<Option.Option<Head>, CorruptRow | KvError>;
    readonly setHead: (
      did: string,
      head: Head,
    ) => Effect.Effect<Sequence, KvError>;
    readonly record: (
      did: string,
      key: string,
    ) => Effect.Effect<Option.Option<Value>, KvError>;
    readonly putRecords: (
      did: string,
      records: ReadonlyArray<StoredRecord>,
    ) => Effect.Effect<Sequence, KvError>;
    /** Remove records, in one commit — what a delete writes. */
    readonly deleteRecords: (
      did: string,
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<Sequence, KvError>;
    /** A node's block, by CID — every node the tree points at. */
    readonly node: (
      did: string,
      cid: string,
    ) => Effect.Effect<Option.Option<Value>, KvError>;
    /**
     * Store a node's block — **every** node the tree points at, including one
     * that holds only leaves. The reference writes those too, and a CAR that
     * omits them cannot be walked: a reader has the tree, not the records, so it
     * cannot rebuild what the pointers name.
     */
    readonly putNode: (
      did: string,
      cid: string,
      bytes: Value,
    ) => Effect.Effect<Sequence, KvError>;
    /** A commit's block, as it was signed. */
    readonly commit: (
      did: string,
      cid: string,
    ) => Effect.Effect<Option.Option<Value>, KvError>;
    readonly putCommit: (
      did: string,
      cid: string,
      bytes: Value,
    ) => Effect.Effect<Sequence, KvError>;
    /**
     * The records strictly between two keys — the leaves a parent's gap
     * rebuilds, in the order the tree wants them.
     */
    readonly leaves: (
      did: string,
      from: string,
      to: string,
    ) => Effect.Effect<ReadonlyArray<StoredRecord>, KvError>;
    /** A cold repo: its head, and every interior node by one `M/` scan. */
    readonly load: (did: string) => Effect.Effect<Loaded, CorruptRow | KvError>;
    /** Keep a record a moderator took down, so a reversal can put it back. */
    readonly takeDown: (
      did: string,
      key: string,
      bytes: Value,
    ) => Effect.Effect<Sequence, KvError>;
    readonly takenDown: (
      did: string,
      key: string,
    ) => Effect.Effect<Option.Option<Value>, KvError>;
    readonly deleteTakedown: (
      did: string,
      key: string,
    ) => Effect.Effect<Sequence, KvError>;
    /**
     * Everything one commit stores, as **one** batch: the records it changed, the interior nodes,
     * the commit and the head.
     *
     * Separate calls would each be their own storage commit, and a Durable Object is billed per row
     * read and written -- the bookkeeping row (`kv.head`) and the head read that goes with it would
     * be paid four times for one record. One batch also makes the write atomic, which the old
     * "records, then nodes, then commit, then head" order only approximated.
     */
    readonly commitAll: (params: {
      readonly did: string;
      readonly puts: ReadonlyArray<StoredRecord>;
      readonly deletes: ReadonlyArray<string>;
      readonly nodes: ReadonlyArray<{
        readonly cid: string;
        readonly bytes: Value;
      }>;
      readonly commit: { readonly cid: string; readonly bytes: Value };
      readonly head: Head;
    }) => Effect.Effect<Sequence, KvError>;
    /** Remove a repo: its head, records, interior nodes, commits and takedowns. */
    readonly deleteRepo: (did: string) => Effect.Effect<Sequence, KvError>;
  }
>()('@eoa/repo-store/RepoStore') {}

export const repoStoreLayer = Layer.effect(
  RepoStore,
  Effect.gen(function* () {
    const kv = yield* Kv;

    const head = (did: string) =>
      Effect.gen(function* () {
        const found = yield* kv.get(headKey(did));
        if (Option.isNone(found)) {
          return Option.none<Head>();
        }
        const decoded = decodeHead(text(found.value.value));
        return Option.isNone(decoded)
          ? yield* Effect.fail(new CorruptRow({ key: headKey(did) }))
          : Option.some(decoded.value);
      });

    const setHead = (did: string, value: Head) =>
      kv.put(headKey(did), utf8(encodeHead(value)));

    const record = (did: string, key: string) =>
      kv
        .get(recordKey(did, key))
        .pipe(Effect.map(Option.map((found) => found.value)));

    const putRecords = (did: string, records: ReadonlyArray<StoredRecord>) =>
      kv.batch(
        records.map((one) =>
          putOp({ key: recordKey(did, one.key), value: one.value }),
        ),
      );

    const deleteRecords = (did: string, keys: ReadonlyArray<string>) =>
      kv.batch(keys.map((key) => deleteOp({ key: recordKey(did, key) })));

    const commitAll: RepoStore['Service']['commitAll'] = (params) =>
      kv.batch([
        ...params.puts.map((one) =>
          putOp({ key: recordKey(params.did, one.key), value: one.value }),
        ),
        ...params.deletes.map((key) =>
          deleteOp({ key: recordKey(params.did, key) }),
        ),
        ...params.nodes.map((one) =>
          putOp({ key: nodeKey(params.did, one.cid), value: one.bytes }),
        ),
        putOp({
          key: commitKey(params.did, params.commit.cid),
          value: params.commit.bytes,
        }),
        putOp({
          key: headKey(params.did),
          value: utf8(encodeHead(params.head)),
        }),
      ]);

    const node = (did: string, cid: string) =>
      kv
        .get(nodeKey(did, cid))
        .pipe(Effect.map(Option.map((found) => found.value)));

    const putNode = (did: string, cid: string, bytes: Value) =>
      kv.put(nodeKey(did, cid), bytes);

    const commit = (did: string, cid: string) =>
      kv
        .get(commitKey(did, cid))
        .pipe(Effect.map(Option.map((found) => found.value)));

    const putCommit = (did: string, cid: string, bytes: Value) =>
      kv.put(commitKey(did, cid), bytes);

    const leaves = (did: string, from: string, to: string) =>
      kv
        .scan({
          prefix: recordsUnder(did),
          start: recordKey(did, from),
          end: recordKey(did, to),
          limit: SCAN_LIMIT,
        })
        .pipe(
          Effect.map((page) =>
            page.entries
              .filter((entry) => entry.key > recordKey(did, from))
              .map((entry) => ({
                key: entry.key.slice(recordsUnder(did).length),
                value: entry.value,
              })),
          ),
        );

    const load = (did: string) =>
      Effect.gen(function* () {
        const found = yield* head(did);
        const page = yield* kv.scan({
          prefix: nodesUnder(did),
          limit: SCAN_LIMIT,
        });
        return {
          head: found,
          nodes: page.entries.map((entry) => ({
            cid: entry.key.slice(nodesUnder(did).length),
            bytes: entry.value,
          })),
        };
      });

    /**
     * Remove a repo — every row family it owns, in one batch, so a reader never
     * sees a repo half gone.
     *
     * // ponytail: one scan per family, so a repo past the scan limit would be
     * // left partly deleted. Page it when a repo can be that big.
     */
    const takeDown = (did: string, key: string, bytes: Value) =>
      kv.put(takedownKey(did, key), bytes);

    const takenDown = (did: string, key: string) =>
      kv
        .get(takedownKey(did, key))
        .pipe(Effect.map(Option.map((found) => found.value)));

    const deleteTakedown = (did: string, key: string) =>
      kv.delete(takedownKey(did, key));

    const deleteRepo = (did: string) =>
      Effect.gen(function* () {
        const families = [
          recordsUnder(did),
          nodesUnder(did),
          commitsUnder(did),
          takedownsUnder(did),
        ];
        const keys: string[] = [headKey(did)];
        for (const prefix of families) {
          const page = yield* kv.scan({ prefix, limit: SCAN_LIMIT });
          keys.push(...page.entries.map((entry) => entry.key));
        }
        return yield* kv.batch(keys.map((key) => deleteOp({ key })));
      });

    return RepoStore.of({
      head,
      setHead,
      record,
      putRecords,
      deleteRecords,
      commitAll,
      node,
      putNode,
      commit,
      putCommit,
      leaves,
      load,
      takeDown,
      takenDown,
      deleteTakedown,
      deleteRepo,
    });
  }),
);
