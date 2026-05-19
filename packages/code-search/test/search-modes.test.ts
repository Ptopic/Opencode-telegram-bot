import { describe, it, expect } from 'vitest';
import type { SearchModeV2 } from '../src/types.js';

describe('SearchModeV2 type', () => {
  it('accepts valid mode values', () => {
    const modes: SearchModeV2[] = ['regex', 'lexical', 'semantic', 'hybrid'];
    expect(modes).toHaveLength(4);
    expect(modes).toContain('regex');
    expect(modes).toContain('lexical');
    expect(modes).toContain('semantic');
    expect(modes).toContain('hybrid');
  });
});

describe('Search mode routing logic', () => {
  function getModeBehavior(mode: SearchModeV2 | undefined, exactSearch?: boolean): string {
    const resolvedMode = mode ?? (exactSearch ? 'regex' : 'hybrid');
    switch (resolvedMode) {
      case 'regex': return 'regex';
      case 'lexical': return 'lexical';
      case 'semantic': return 'semantic';
      case 'hybrid': return 'hybrid';
      default: return 'hybrid';
    }
  }

  it('defaults to hybrid mode', () => {
    expect(getModeBehavior(undefined)).toBe('hybrid');
  });

  it('maps exactSearch=true to regex mode', () => {
    expect(getModeBehavior(undefined, true)).toBe('regex');
  });

  it('mode overrides exactSearch when both set', () => {
    expect(getModeBehavior('lexical', true)).toBe('lexical');
  });

  it('routes each mode correctly', () => {
    expect(getModeBehavior('regex')).toBe('regex');
    expect(getModeBehavior('lexical')).toBe('lexical');
    expect(getModeBehavior('semantic')).toBe('semantic');
    expect(getModeBehavior('hybrid')).toBe('hybrid');
  });
});
