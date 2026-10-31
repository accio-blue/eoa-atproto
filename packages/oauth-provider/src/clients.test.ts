import { describe, expect, it, vi } from 'vitest';
import {
  httpClientMetadata,
  loopbackClientMetadata,
  redirectUriMatches,
} from './clients.js';
import { Effect } from 'effect';

const SCOPE = 'atproto repo:com.example.thing';
const CALLBACK = 'http://127.0.0.1:49832/callback';

const loopbackId = (params: Record<string, string>) =>
  `http://localhost?${new URLSearchParams(params).toString()}`;

describe('loopback client ids', () => {
  it('synthesises the metadata from the query without fetching', async () => {
    const fetch = vi.fn();
    const clientId = loopbackId({
      redirect_uri: CALLBACK,
      scope: SCOPE,
    });

    const metadata = await Effect.runPromise(
      httpClientMetadata(fetch).get(clientId),
    );

    expect(metadata).toEqual({
      clientId,
      redirectUris: [CALLBACK],
      scope: SCOPE,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves anything that is not the loopback form to the document fetch', async () => {
    const cases = [
      `https://localhost?redirect_uri=${encodeURIComponent(CALLBACK)}&scope=${encodeURIComponent(SCOPE)}`,
      `http://localhost:8080?redirect_uri=${encodeURIComponent(CALLBACK)}&scope=${encodeURIComponent(SCOPE)}`,
      `http://127.0.0.1?redirect_uri=${encodeURIComponent(CALLBACK)}&scope=${encodeURIComponent(SCOPE)}`,
      `http://localhost/path?redirect_uri=${encodeURIComponent(CALLBACK)}&scope=${encodeURIComponent(SCOPE)}`,
      `http://localhost?scope=${encodeURIComponent(SCOPE)}`,
      `http://localhost?redirect_uri=${encodeURIComponent(CALLBACK)}`,
      `http://localhost?redirect_uri=${encodeURIComponent(CALLBACK)}&scope=${encodeURIComponent('repo:com.example.thing')}`,
      `http://localhost?redirect_uri=not-a-url&scope=${encodeURIComponent(SCOPE)}`,
      `http://localhost?redirect_uri=${encodeURIComponent(CALLBACK)}&scope=${encodeURIComponent(SCOPE)}#fragment`,
    ];

    for (const clientId of cases) {
      expect(loopbackClientMetadata(clientId), clientId).toBeUndefined();
    }
  });

  it('a loopback-looking id with a port is still fetched as a document', async () => {
    const clientId = 'http://localhost:8080/client-metadata.json';
    const fetch = vi.fn(() =>
      Promise.resolve(
        Response.json({
          client_id: clientId,
          redirect_uris: [CALLBACK],
        }),
      ),
    );

    const metadata = await Effect.runPromise(
      httpClientMetadata(fetch).get(clientId),
    );

    expect(metadata.redirectUris).toEqual([CALLBACK]);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('redirect URI matching', () => {
  it('matches a loopback redirect across ports', () => {
    expect(
      redirectUriMatches(CALLBACK, 'http://127.0.0.1:55555/callback'),
    ).toBe(true);
  });

  it('keeps non-loopback redirects exact', () => {
    expect(
      redirectUriMatches(
        'https://app.example/callback',
        'https://app.example:8443/callback',
      ),
    ).toBe(false);
    expect(
      redirectUriMatches(
        'https://app.example/callback',
        'https://app.example/callback',
      ),
    ).toBe(true);
  });

  it('does not match a different host, path or query', () => {
    expect(redirectUriMatches(CALLBACK, 'http://127.0.0.1:55555/other')).toBe(
      false,
    );
    expect(
      redirectUriMatches(CALLBACK, 'http://localhost:55555/callback'),
    ).toBe(false);
    expect(
      redirectUriMatches(CALLBACK, 'http://127.0.0.1:55555/callback?x=1'),
    ).toBe(false);
  });
});
