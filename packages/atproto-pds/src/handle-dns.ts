import { Effect, Schema } from 'effect';

/**
 * Where a handle's external answer lives (`a34b`): the `_atproto.<handle>` TXT record.
 *
 * atproto resolves a handle two ways, and only one of them is ours to serve. `/.well-known/atproto-did`
 * is a host — reachable when the handle **is** a hostname we run, and not when it is three labels under
 * a PDS's own name (`alice.pds.example.com` is two levels down: no universal certificate, and a
 * wildcard TXT cannot carry a different DID per account). The `_atproto` record is the other way, it
 * works at any depth, and it is one record per account — which is exactly what this port publishes.
 *
 * It is a port and not a client in the PDS because the authority belongs to the deployment that owns
 * the zone: the core says *when* a handle's answer changes, and the host says *where* to write it.
 */
export class HandleDnsError extends Schema.TaggedError<HandleDnsError>()(
  'HandleDnsError',
  {
    handle: Schema.String,
    reason: Schema.String,
  },
) {}

export interface HandleDns {
  /** `_atproto.<handle> TXT "did=<did>"` — created or replaced. */
  readonly publish: (params: {
    readonly handle: string;
    readonly did: string;
  }) => Effect.Effect<void, HandleDnsError>;
  /** The record goes away with the handle. Missing is a success: that is the state asked for. */
  readonly remove: (params: {
    readonly handle: string;
  }) => Effect.Effect<void, HandleDnsError>;
}

/**
 * Announce a handle, and **never fail the call that changed it**.
 *
 * An account is the authority; a DNS record is a convenience that can be published again. A login
 * that failed because a zone API was rate-limited would be the worse trade, so the failure is said
 * out loud in the log and the request stands.
 */
export const announceHandle = (
  dns: HandleDns | undefined,
  params: { readonly handle: string; readonly did: string },
): Effect.Effect<void> =>
  dns === undefined
    ? Effect.void
    : dns
        .publish(params)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `the handle ${params.handle} was not published to DNS: ${error.reason}`,
            ),
          ),
        );

/** The same, for a handle that is gone. */
export const forgetHandle = (
  dns: HandleDns | undefined,
  params: { readonly handle: string },
): Effect.Effect<void> =>
  dns === undefined
    ? Effect.void
    : dns
        .remove(params)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `the handle ${params.handle} was not removed from DNS: ${error.reason}`,
            ),
          ),
        );
