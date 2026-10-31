import { Context, Effect } from 'effect';

/** Resolves a DID to the handle it currently claims. Injected so this package
 *  stays free of the directory: the host knows where identities live. */
export interface HandleResolverShape {
  /** The handle `did` claims, or `undefined` when it claims none. Never fails:
   *  a handle we could not resolve is a fallback to the DID, not a dead read. */
  readonly handleOf: (did: string) => Effect.Effect<string | undefined>;
  /** The DID a handle currently belongs to, or `undefined` when none does. */
  readonly didOf: (handle: string) => Effect.Effect<string | undefined>;
}

export class HandleResolver extends Context.Service<
  HandleResolver,
  HandleResolverShape
>()('@eoa/appview/HandleResolver') {}
