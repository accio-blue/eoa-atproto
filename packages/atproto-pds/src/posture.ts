/**
 * A posture: what a deployment is willing to be, as one word rather than a handful of flags.
 *
 * The two that exist are the two this org runs, and they differ in whether the *network* is
 * reachable, not in who may register:
 *
 * - **`public`** — the atproto network is reachable. Accounts are `did:plc`, so the PLC directory is
 *   named (a public identity is one the ecosystem can resolve, and one that can move); the commit
 *   stream is on, because a public PDS whose commits nobody can read is a private one with extra
 *   steps.
 * - **`intranet`** — a closed network. The identity is `did:web` (the host *is* the document, so
 *   there is no registry to ask and nothing to leave), and no stream is served: there is no
 *   ecosystem to fan out to.
 *
 * Registration is deliberately **not** part of a posture: invites are a decision about who joins this
 * deployment today, and the same posture is run closed (`cssints`) and open (`prod`). A deployment
 * keeps `PDS_INVITE_REQUIRED` as its own.
 *
 * The values are environment variables because that is how the surface reads them (`configOf`); the
 * preset exists so a deployment names the posture once instead of spelling the consequences out.
 */
export type Posture = 'public' | 'intranet';

/** What a posture contributes to a deployment's environment. */
export interface PostureVars {
  /** The registry a `did:plc` is read at; only a posture that reaches the network names one. */
  readonly PDS_PLC_DIRECTORY_URL?: string;
  /** `'on'` serves the commit stream. */
  readonly JETSTREAM?: 'on';
}

/**
 * The presets. A deployment may not override these: the posture it names is the whole of the
 * network posture, and an override would be a deployment calling itself public while serving no
 * stream.
 */
const postures: Readonly<Record<Posture, PostureVars>> = {
  public: { PDS_PLC_DIRECTORY_URL: 'https://plc.directory', JETSTREAM: 'on' },
  intranet: {},
};

/** The environment a posture contributes. */
export const postureVars = (posture: Posture): PostureVars => postures[posture];
