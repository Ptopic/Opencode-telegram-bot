import { describe, it, expect } from 'vitest';
import { tokenizeCode, STOP_WORDS } from '../src/search/tokenizer.js';

describe('tokenizeCode', () => {
  it('splits camelCase', () => {
    const tokens = tokenizeCode('getUserName');
    expect(tokens).toContain('getusername');
    expect(tokens).toContain('get');
    expect(tokens).toContain('user');
    expect(tokens).toContain('name');
  });

  it('splits PascalCase', () => {
    const tokens = tokenizeCode('ReactComponent');
    expect(tokens).toContain('reactcomponent');
    expect(tokens).toContain('react');
    expect(tokens).toContain('component');
  });

  it('splits SCREAMING_SNAKE_CASE', () => {
    const tokens = tokenizeCode('MAX_RETRY_COUNT');
    expect(tokens).toContain('max_retry_count');
    expect(tokens).toContain('max');
    expect(tokens).toContain('retry');
    expect(tokens).toContain('count');
  });

  it('splits dotted paths', () => {
    const tokens = tokenizeCode('React.useState');
    expect(tokens).toContain('react.usestate');
    expect(tokens).toContain('react');
    expect(tokens).toContain('usestate');
  });

  it('removes stop words', () => {
    const tokens = tokenizeCode('function return class');
    // 'function', 'return', 'class' are all stop words
    expect(tokens).not.toContain('function');
    expect(tokens).not.toContain('return');
    expect(tokens).not.toContain('class');
  });

  it('removes single-char tokens', () => {
    const tokens = tokenizeCode('a b c x');
    expect(tokens).toHaveLength(0);
  });

  it('handles mixed code text', () => {
    const tokens = tokenizeCode('const getUserName = React.useState');
    expect(tokens).toContain('getusername');
    expect(tokens).toContain('get');
    expect(tokens).toContain('user');
    expect(tokens).toContain('name');
    expect(tokens).toContain('react');
    expect(tokens).toContain('usestate');
  });

  it('lowercases all tokens', () => {
    const tokens = tokenizeCode('HelloWorld FOO_BAR');
    for (const token of tokens) {
      expect(token).toBe(token.toLowerCase());
    }
  });

  it('handles empty string', () => {
    expect(tokenizeCode('')).toEqual([]);
  });

  it('handles whitespace only', () => {
    expect(tokenizeCode('   ')).toEqual([]);
  });
});

describe('STOP_WORDS', () => {
  it('contains common English stop words', () => {
    expect(STOP_WORDS.has('the')).toBe(true);
    expect(STOP_WORDS.has('and')).toBe(true);
    expect(STOP_WORDS.has('is')).toBe(true);
  });

  it('contains common code keywords', () => {
    expect(STOP_WORDS.has('function')).toBe(true);
    expect(STOP_WORDS.has('class')).toBe(true);
    expect(STOP_WORDS.has('const')).toBe(true);
    expect(STOP_WORDS.has('return')).toBe(true);
  });
});
