import { describe, expect, it } from 'vitest';
import { isSharedSpec, specRelToOutRel } from '../src/layout';

describe('specs workspace layout', () => {
  it('maps a service spec to its generated model path', () => {
    expect(specRelToOutRel('specs/pds/repo-write.qnt')).toBe(
      'src/pds/repo-write.model.generated.json',
    );
    expect(specRelToOutRel('specs/space-host/grant-lifecycle.qnt')).toBe(
      'src/space-host/grant-lifecycle.model.generated.json',
    );
  });

  it('accepts either path separator', () => {
    expect(specRelToOutRel('specs\\pds\\repo-write.qnt')).toBe(
      'src/pds/repo-write.model.generated.json',
    );
  });

  it('treats shared modules as not generated', () => {
    expect(isSharedSpec('specs/shared/cbor.qnt')).toBe(true);
    expect(isSharedSpec('specs/shared/nested/base.qnt')).toBe(true);
    expect(isSharedSpec('specs/pds/repo-write.qnt')).toBe(false);
  });
});
