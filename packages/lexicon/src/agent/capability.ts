import type { Schema } from 'effect';

// Hand-typed from lexicons/ing/lexicon/agent/capability.json; the agent lexicon
// test walks the JSON against sample records so the two cannot drift silently.

export const AGENT_CAPABILITY_NSID = 'ing.lexicon.agent.capability';

export interface AgentCapabilityUriParams {
  readonly did: string;
  readonly rkey: string;
}

/** `at://<did>/ing.lexicon.agent.capability/<rkey>` — the record is `tid`-keyed. */
export const agentCapabilityUri = ({
  did,
  rkey,
}: AgentCapabilityUriParams): string =>
  `at://${did}/${AGENT_CAPABILITY_NSID}/${rkey}`;

export type AgentCapability = {
  readonly $type: typeof AGENT_CAPABILITY_NSID;
  readonly name: string;
  readonly description?: string;
  /** A JSON-Schema-shaped argument object, opaque to the network. */
  readonly inputSchema?: Schema.Json;
  readonly createdAt: string;
};
