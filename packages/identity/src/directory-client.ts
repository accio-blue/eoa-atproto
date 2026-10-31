import { Effect, Option, Schema } from 'effect';
import {
  type PlcData,
  PlcDataSchema,
  type PlcSignedOperation,
  PlcSignedOperationSchema,
} from './plc-operation.js';

/**
 * The directory, as this PDS talks to it: read a DID's chain, submit an
 * operation.
 *
 * Two calls, and between them they are the identity half of a migration. A
 * `did:plc` is the chain of its operations, so the head is what a new operation
 * has to point at (`prev`), and the head is not in this PDS — it is in the
 * directory, which is why signing reads before it writes.
 *
 * The payload is decoded with the operation schema at this boundary, so a
 * malformed log is refused by name rather than half-read.
 */

/** The little of an audit-log entry this PDS needs: the operation's CID. */
const AuditEntrySchema = Schema.Struct({ cid: Schema.String });

const AuditLogSchema = Schema.Array(AuditEntrySchema);

/** The directory could not be reached, or refused what it was given. */
export class PlcDirectoryError extends Schema.TaggedError<PlcDirectoryError>()(
  'PlcDirectoryError',
  { message: Schema.String, status: Schema.optional(Schema.Number) },
) {}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'unknown cause';

const call = (params: {
  readonly plcUrl: string;
  readonly did: string;
  readonly path: string;
  readonly init?: RequestInit;
}) =>
  Effect.tryPromise({
    try: () =>
      fetch(`${params.plcUrl}/${params.did}${params.path}`, params.init),
    catch: (cause) =>
      new PlcDirectoryError({
        message: `the directory could not be reached: ${describe(cause)}`,
      }),
  });

/**
 * The CID of the DID's newest operation, or none when the directory has never
 * heard of it.
 *
 * None is not an error: a chain with no head is exactly what a genesis
 * operation needs, so the caller decides whether that is legal here.
 */
export const currentOperationCid = (params: {
  readonly plcUrl: string;
  readonly did: string;
}) =>
  Effect.gen(function* () {
    const response = yield* call({ ...params, path: '/log/audit' });
    if (response.status === 404) {
      return Option.none<string>();
    }
    if (!response.ok) {
      return yield* Effect.fail(
        new PlcDirectoryError({
          message: `the directory answered ${response.status} for the audit log`,
          status: response.status,
        }),
      );
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new PlcDirectoryError({ message: 'the audit log is not JSON' }),
    });
    const decoded = Schema.decodeUnknownOption(AuditLogSchema)(body);
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(
        new PlcDirectoryError({
          message: 'the audit log is not a list of operations',
        }),
      );
    }
    const head = decoded.value.at(-1);
    return head === undefined ? Option.none<string>() : Option.some(head.cid);
  });

/**
 * The DID's current state, as `<did>/data` serves it: the fields every later
 * operation has to carry.
 *
 * A PLC operation is the *whole* document, not a patch, so anything that adds a
 * field has to read what is there first — otherwise the operation would drop the
 * aliases, the rotation keys, or a verification method it never saw.
 */
export const currentOperationData = (params: {
  readonly plcUrl: string;
  readonly did: string;
}) =>
  Effect.gen(function* () {
    const response = yield* call({ ...params, path: '/data' });
    if (response.status === 404) {
      return Option.none<PlcData>();
    }
    if (!response.ok) {
      return yield* Effect.fail(
        new PlcDirectoryError({
          message: `the directory answered ${response.status} for the DID data`,
          status: response.status,
        }),
      );
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new PlcDirectoryError({ message: 'the DID data is not JSON' }),
    });
    const decoded = Schema.decodeUnknownOption(PlcDataSchema)(body);
    return Option.isNone(decoded)
      ? yield* Effect.fail(
          new PlcDirectoryError({
            message: 'the DID data is not a PLC operation state',
          }),
        )
      : decoded;
  });

/** Submits a signed operation. The directory decides whether it is legal. */
export const submitOperation = (params: {
  readonly plcUrl: string;
  readonly did: string;
  readonly operation: PlcSignedOperation;
}) =>
  Effect.gen(function* () {
    // Encoded through the schema, not `JSON.stringify`: the payload crosses a
    // trust boundary in both directions, so what leaves is validated too.
    const body = yield* Effect.try({
      try: () =>
        Schema.encodeSync(Schema.fromJsonString(PlcSignedOperationSchema))(
          params.operation,
        ),
      catch: () =>
        new PlcDirectoryError({ message: 'the operation does not encode' }),
    });
    const response = yield* call({
      plcUrl: params.plcUrl,
      did: params.did,
      path: '',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    });
    if (!response.ok) {
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          new PlcDirectoryError({
            message: `the directory refused the operation (${response.status})`,
            status: response.status,
          }),
      });
      return yield* Effect.fail(
        new PlcDirectoryError({
          message: `the directory refused the operation (${response.status}): ${text.slice(0, 200)}`,
          status: response.status,
        }),
      );
    }
    return response.status;
  });
