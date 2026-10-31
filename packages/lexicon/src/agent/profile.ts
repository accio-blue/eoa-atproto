// Hand-typed from lexicons/ing/lexicon/agent/profile.json; the agent lexicon
// test walks the JSON against sample records so the two cannot drift silently.

export const AGENT_PROFILE_NSID = 'ing.lexicon.agent.profile';

/** An agent has exactly one profile, at the literal rkey `self`. */
export const AGENT_PROFILE_RKEY = 'self';

export type AgentProfile = {
  readonly $type: typeof AGENT_PROFILE_NSID;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: string;
};

/** The AT-URI of an agent's profile record. */
export const agentProfileUri = (did: string): string =>
  `at://${did}/${AGENT_PROFILE_NSID}/${AGENT_PROFILE_RKEY}`;
