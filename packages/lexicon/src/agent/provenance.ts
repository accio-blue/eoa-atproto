// Hand-typed from lexicons/ing/lexicon/agent/provenance.json; the agent lexicon
// test walks the JSON against sample records so the two cannot drift silently.

export const AGENT_PROVENANCE_NSID = 'ing.lexicon.agent.provenance';

/** One provenance record per agent, at the literal rkey `self`. */
export const AGENT_PROVENANCE_RKEY = 'self';

export type AgentProvenance = {
  readonly $type: typeof AGENT_PROVENANCE_NSID;
  /** The DID of the account this agent acts for. */
  readonly account: string;
  readonly operator?: string;
  readonly createdAt: string;
};
