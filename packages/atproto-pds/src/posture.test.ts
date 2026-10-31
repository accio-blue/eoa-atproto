import { describe, expect, it } from 'vitest';
import { postureVars } from './posture.js';

// A posture is the whole of a deployment's network posture: the preset says whether the network is
// reachable, and nothing else -- identity, doors and registration stay the deployment's own.

describe('atproto-pds: postures', () => {
  it('sends a public deployment to the PLC directory, with the stream on', () => {
    expect(postureVars('public')).toEqual({
      PDS_PLC_DIRECTORY_URL: 'https://plc.directory',
      JETSTREAM: 'on',
    });
  });

  it('keeps a closed deployment off the registry and off the stream', () => {
    const vars = postureVars('intranet');
    expect(vars).toEqual({});
    expect(vars.PDS_PLC_DIRECTORY_URL).toBeUndefined();
    expect(vars.JETSTREAM).toBeUndefined();
  });

  it('never decides who may register', () => {
    // Invites are the deployment's call: cssints is public and closed, prod is closed and open.
    for (const posture of ['public', 'intranet'] as const) {
      expect(Object.keys(postureVars(posture))).not.toContain(
        'PDS_INVITE_REQUIRED',
      );
    }
  });

  it('never names an identity', () => {
    // A posture is shared by deployments with different hosts: naming one here would make every
    // deployment that used the preset answer as the first one.
    for (const posture of ['public', 'intranet'] as const) {
      expect(Object.keys(postureVars(posture)).sort()).toEqual(
        posture === 'public' ? ['JETSTREAM', 'PDS_PLC_DIRECTORY_URL'] : [],
      );
    }
  });
});
