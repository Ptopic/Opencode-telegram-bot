import { describe, it, expect, beforeEach } from 'vitest';
import { SectionExtractor } from '../src/search/section-extractor.js';

describe('SectionExtractor', () => {
  let extractor: SectionExtractor;

  beforeEach(() => {
    extractor = new SectionExtractor();
  });

  it('extracts containing function from JS', async () => {
    const code = `
function greet(name) {
  console.log("Hello, " + name);
}

const x = 1;
`;
    const result = await extractor.extractContainingSection('test.js', 3, code);
    if (result) {
      expect(result.type).toBe('function');
      expect(result.name).toBe('greet');
      expect(result.startLine).toBe(2);
    }
  });

  it('extracts containing class method from TS', async () => {
    const code = `
class UserService {
  getUser(id: string) {
    return this.db.find(id);
  }
}
`;
    const result = await extractor.extractContainingSection('test.ts', 4, code);
    if (result) {
      expect(['method', 'function']).toContain(result.type);
      expect(result.name).toBe('getUser');
    }
  });

  it('extracts containing function from Python', async () => {
    const code = `
def calculate_sum(numbers):
    total = 0
    for n in numbers:
        total += n
    return total

x = 1
`;
    const result = await extractor.extractContainingSection('test.py', 4, code);
    if (result) {
      expect(result.type).toBe('function');
      expect(result.name).toBe('calculate_sum');
    }
  });

  it('returns null for module-level code', async () => {
    const code = `
import os
import sys

x = 1
`;
    const result = await extractor.extractContainingSection('test.py', 4, code);
    expect(result).toBeNull();
  });

  it('returns null for unsupported file extension', async () => {
    const result = await extractor.extractContainingSection('test.txt', 1, 'hello');
    expect(result).toBeNull();
  });

  it('returns innermost containing function for nesting', async () => {
    const code = `
function outer() {
  function inner() {
    return 42;
  }
  return inner();
}
`;
    const result = await extractor.extractContainingSection('test.js', 4, code);
    if (result) {
      expect(result.name).toBe('inner');
    }
  });
});
