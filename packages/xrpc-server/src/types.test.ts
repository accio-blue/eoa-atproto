import { createErrorResponse, createJsonResponse } from './types.js';
import { describe, expect, it } from 'vitest';

describe('createJsonResponse', () => {
  it('serialises the body with status 200 by default', async () => {
    const response = createJsonResponse({ ok: true });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('applies a custom status code', async () => {
    const response = createJsonResponse({ created: true }, 201);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ created: true });
  });
});

describe('createErrorResponse', () => {
  it('serialises the error message and name with status 500', async () => {
    const response = createErrorResponse(new Error('boom'));

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({
      error: 'boom',
      code: 'Error',
    });
  });

  it('uses the error name as the code and honours a custom status', async () => {
    const error = new Error('nope');
    error.name = 'SyncError';
    const response = createErrorResponse(error, 400);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'nope',
      code: 'SyncError',
    });
  });
});
