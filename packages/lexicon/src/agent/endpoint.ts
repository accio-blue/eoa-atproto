// Hand-typed from lexicons/ing/lexicon/agent/endpoint.json; the agent lexicon
// test walks the JSON against sample records so the two cannot drift silently.

export const AGENT_ENDPOINT_NSID = 'ing.lexicon.agent.endpoint';

export const AGENT_ENDPOINT_RKEY = 'self';

/** How the agent is reachable over ACP. */
export type AgentEndpointTransport = 'stdio' | 'websocket' | 'http' | 'sse';

/** One MCP server the agent provides over the ACP connection. */
export type AgentMcpServer = {
  readonly serverId: string;
  readonly name: string;
};

export type AgentEndpoint = {
  readonly $type: typeof AGENT_ENDPOINT_NSID;
  /** Where the agent is reachable over ACP, and the protocol version it speaks. */
  readonly acp: {
    readonly transport: AgentEndpointTransport;
    readonly url?: string;
    readonly protocolVersion?: number;
  };
  /** The MCP servers the agent provides, so a client can declare them. */
  readonly mcpServers?: ReadonlyArray<AgentMcpServer>;
  readonly createdAt: string;
};

/** `at://<did>/ing.lexicon.agent.endpoint/self` */
export const agentEndpointUri = (did: string): string =>
  `at://${did}/${AGENT_ENDPOINT_NSID}/${AGENT_ENDPOINT_RKEY}`;
