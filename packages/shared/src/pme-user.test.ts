import { describe, expect, it } from 'vitest';
import { pmeDisplayName } from './pme-user.ts';

describe('nombre visible del usuario de PME', () => {
  it('toma el último tramo del IdentityId', () => {
    expect(pmeDisplayName('internal:database:e9ce4532-85d8-44be-b8cf-54e629a107f1:supervisor')).toBe('supervisor');
  });

  it('deja tal cual un valor sin esa forma', () => {
    expect(pmeDisplayName('jperez')).toBe('jperez');
    expect(pmeDisplayName('raro:')).toBe('raro:');
  });
});
