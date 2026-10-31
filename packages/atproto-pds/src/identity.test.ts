import {
  HandleResolutionError,
  type HandleTransportShape,
} from '@eoa/identity';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { handleClaimedBy } from './identity.js';

/** kocharin's DID: the account whose handle is its own domain, not ours. */
const DID = 'did:plc:5itbtooiegem6wyg3rq5ukf4';

const HANDLE = 'kocharin.art';

const absent = (what: string) =>
  new HandleResolutionError({
    handle: HANDLE,
    reason: 'not found',
    message: `no ${what}`,
  });

/**
 * A transport that answers what a test says, and fails where a real one would.
 *
 * The failures matter as much as the answers: a domain with no `_atproto` record
 * and no `/.well-known/atproto-did` is the ordinary case, not an exceptional one,
 * and it must read as "not claimed" rather than as an error the caller has to
 * handle.
 */
const transportOf = (params: {
  readonly txt?: readonly string[];
  readonly wellKnown?: string;
}): HandleTransportShape => ({
  lookupTxt: () =>
    params.txt === undefined
      ? Effect.fail(absent('TXT record'))
      : Effect.succeed(params.txt),
  fetchWellKnown: () =>
    params.wellKnown === undefined
      ? Effect.fail(absent('well-known document'))
      : Effect.succeed(params.wellKnown),
});

const claimed = (transport: HandleTransportShape) =>
  Effect.runPromise(handleClaimedBy({ handle: HANDLE, did: DID, transport }));

describe('a handle outside our domain', () => {
  it('is ours when its `_atproto` TXT record names this DID', async () => {
    // The shape a zone publishes: `_atproto.kocharin.art` → `did=…`. The quoting
    // DoH answers with is dropped by the transport before this sees it, which is
    // where it belongs — the parser reads records, not DNS presentation.
    expect(await claimed(transportOf({ txt: [`did=${DID}`] }))).toBe(true);
  });

  it('is ours when its well-known document names this DID', async () => {
    expect(await claimed(transportOf({ wellKnown: `${DID}\n` }))).toBe(true);
    // A TXT record for somebody else does not stop the document from being
    // asked: the two are the same claim published two ways.
    expect(
      await claimed(
        transportOf({
          txt: ['v=spf1 -all'],
          wellKnown: DID,
        }),
      ),
    ).toBe(true);
  });

  it('is not ours when the network names somebody else', async () => {
    expect(
      await claimed(
        transportOf({
          txt: ['did=did:plc:someoneelse'],
          wellKnown: 'did:plc:someoneelse',
        }),
      ),
    ).toBe(false);
  });

  it('is not ours when the network says nothing at all', async () => {
    // Neither record: the ordinary case for a domain that is not a handle.
    expect(await claimed(transportOf({}))).toBe(false);
    // A well-known that is not a DID — a web page, an HTML error page.
    expect(
      await claimed(transportOf({ wellKnown: '<html>not found</html>' })),
    ).toBe(false);
  });
});
