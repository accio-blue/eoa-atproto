import {
  type CollectionRecord,
  type RepoSurfaceDeps,
  collectionOf,
} from './repo.js';
import {
  type HandlerContext,
  type XrpcError,
  type XrpcServer,
} from '@eoa/xrpc-server';
import { Effect } from 'effect';
import { authenticateAccess } from './pds.js';

/**
 * A method a **plugin** adds to this PDS.
 *
 * The PDS keeps knowing nothing about the CMS: a deployment composes the methods it wants from a
 * package that does (`@eoa/pds-cms`), and this is the seam that lets it. Two things are the
 * seam's whole job and neither is the plugin's to get wrong:
 *
 * - **The caller is authenticated here.** A plugin gets the DID, never a token; it cannot answer
 *   an anonymous call, and it cannot invent an account.
 * - **The records are the caller's own.** `collection(name)` reads the account's repo, not any
 *   repo named in the request, so a method written for "my editor" cannot be pointed at somebody
 *   else's content.
 *
 * A handler answers with whatever the lexicon says, or fails with an `XrpcError`; there is no
 * third way to answer, which is what keeps a plugin from becoming a second opinion about status
 * codes.
 */
export interface PluginMethodInput {
  /** The call as it arrived: query params, headers, the body's bytes. */
  readonly ctx: HandlerContext;
  /** Who is calling, already proved. */
  readonly did: string;
  /** One of the caller's collections, whole — `com.atproto.repo.listRecords` without the pages. */
  readonly collection: (
    name: string,
  ) => Effect.Effect<ReadonlyArray<CollectionRecord>, XrpcError>;
}

export interface PluginMethod {
  readonly nsid: string;
  readonly handler: (
    input: PluginMethodInput,
  ) => Effect.Effect<unknown, XrpcError>;
}

/** Registers each plugin method on the server, with authentication and the caller's repo around it. */
export const registerPluginMethods = (
  server: XrpcServer,
  deps: RepoSurfaceDeps,
  methods: ReadonlyArray<PluginMethod>,
): void => {
  for (const method of methods) {
    server.method(method.nsid, {}, (ctx) =>
      Effect.gen(function* () {
        const caller = yield* authenticateAccess(deps, ctx);
        const did = caller.account.did;
        return yield* method.handler({
          ctx,
          did,
          collection: (name) => collectionOf(deps, did, name),
        });
      }),
    );
  }
};
