import { Effect, Tracer } from 'effect';
import { describe, expect, it } from 'vitest';
import type { FetchHandler } from './types.js';
import { makeXrpcClient } from './client.js';

/** A transport that answers 200 without touching the network. */
const okFetch: FetchHandler = () =>
  Effect.succeed({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    json: () => Effect.succeed({ ok: true }),
    text: () => Effect.succeed(''),
  });

/** Collect every span the instrumented function opens. */
const capturingTracer = () => {
  const spans: Array<Tracer.Span> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { tracer, spans };
};

describe('xrpc.call span', () => {
  it('records the nsid and the HTTP method', async () => {
    const { tracer, spans } = capturingTracer();
    const client = makeXrpcClient({
      service: 'https://api.example',
      fetch: okFetch,
    });

    await Effect.runPromise(
      client
        .call('com.example.getThing', { q: '1' })
        .pipe(Effect.withTracer(tracer)),
    );

    const span = spans.find((candidate) => candidate.name === 'xrpc.call');
    expect(span).toBeDefined();
    expect(span?.attributes.get('xrpc.nsid')).toBe('com.example.getThing');
    expect(span?.attributes.get('http.request.method')).toBe('GET');
  });
});
