import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseImports,
  buildDependencyGraph,
  extractFunctionCalls,
  normalizeImportPath,
  getFilesImportingFrom,
  getDependencies,
  getDependents,
  findFunctionCalls,
} from '../src/db/dependency-graph.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

describe('parseImports', () => {
  describe('TypeScript/JavaScript ES6 imports', () => {
    it('parses default imports', () => {
      const content = `import React from 'react';`;
      const imports = parseImports('/src/App.tsx', content, 'typescript');
      expect(imports.length).toBeGreaterThan(0);
      const reactImport = imports.find(i => i.path === 'react');
      expect(reactImport).toBeDefined();
      expect(reactImport?.type).toBe('default');
    });

    it('parses named imports', () => {
      const content = `import { useState, useEffect } from 'react';`;
      const imports = parseImports('/src/App.tsx', content, 'typescript');
      expect(imports.length).toBeGreaterThan(0);
      const reactImport = imports.find(i => i.path === 'react');
      expect(reactImport?.type).toBe('named');
      expect(reactImport?.importedNames).toContain('useState');
      expect(reactImport?.importedNames).toContain('useEffect');
    });

    it('parses namespace imports', () => {
      const content = `import * as React from 'react';`;
      const imports = parseImports('/src/App.tsx', content, 'javascript');
      expect(imports.length).toBeGreaterThan(0);
      const reactImport = imports.find(i => i.path === 'react');
      expect(reactImport?.type).toBe('namespace');
      expect(reactImport?.name).toBe('React');
    });

    it('parses mixed default and named imports', () => {
      const content = `import React, { useState } from 'react';`;
      const imports = parseImports('/src/App.tsx', content, 'typescript');
      expect(imports.length).toBeGreaterThan(0);
    });
  });

  describe('CommonJS requires', () => {
    it('parses require with destructuring', () => {
      const content = `const { foo, bar } = require('./utils');`;
      const imports = parseImports('/src/index.js', content, 'javascript');
      const utilsImport = imports.find(i => i.path === './utils');
      expect(utilsImport).toBeDefined();
      expect(utilsImport?.importedNames).toContain('foo');
      expect(utilsImport?.importedNames).toContain('bar');
    });

    it('parses require with namespace', () => {
      const content = `const _ = require('lodash');`;
      const imports = parseImports('/src/index.js', content, 'javascript');
      const lodashImport = imports.find(i => i.path === 'lodash');
      expect(lodashImport).toBeDefined();
      expect(lodashImport?.type).toBe('namespace');
    });
  });

  describe('Python imports', () => {
    it('parses import module', () => {
      const content = `import os
import sys as system`;
      const imports = parseImports('/src/main.py', content, 'python');
      expect(imports.length).toBeGreaterThanOrEqual(1);
      const osImport = imports.find(i => i.path === 'os');
      expect(osImport).toBeDefined();
    });

    it('parses from imports', () => {
      const content = `from os.path import join, exists
from collections import defaultdict`;
      const imports = parseImports('/src/main.py', content, 'python');
      const pathImport = imports.find(i => i.path === 'os.path');
      expect(pathImport).toBeDefined();
      expect(pathImport?.importedNames).toContain('join');
      expect(pathImport?.importedNames).toContain('exists');
    });
  });

  describe('Go imports', () => {
    it('parses simple imports', () => {
      const content = `package main

import "fmt"
import "os"`;
      const imports = parseImports('/src/main.go', content, 'go');
      const fmtImport = imports.find(i => i.path === 'fmt');
      expect(fmtImport).toBeDefined();
      expect(fmtImport?.type).toBe('default');
    });

    it('parses aliased imports', () => {
      const content = `import f "fmt"`;
      const imports = parseImports('/src/main.go', content, 'go');
      const fImport = imports.find(i => i.name === 'f');
      expect(fImport).toBeDefined();
      expect(fImport?.type).toBe('namespace');
    });
  });

  describe('line numbers', () => {
    it('tracks correct line numbers', () => {
      const content = `import React from 'react';
import { useState } from 'react';
import _ from 'lodash';`;
      const imports = parseImports('/src/App.tsx', content, 'typescript');
      expect(imports[0]?.line).toBe(1);
      expect(imports[1]?.line).toBe(2);
      expect(imports[2]?.line).toBe(3);
    });
  });
});

describe('extractFunctionCalls', () => {
  describe('JavaScript/TypeScript', () => {
    it('extracts simple function calls', () => {
      const content = `foo();
bar();`;
      const calls = extractFunctionCalls(content, 'javascript');
      const callNames = calls.map(c => c.name);
      expect(callNames).toContain('foo');
      expect(callNames).toContain('bar');
    });

    it('extracts method calls', () => {
      const content = `obj.method();
arr.map(x => x);`;
      const calls = extractFunctionCalls(content, 'javascript');
      const callNames = calls.map(c => c.name);
      expect(callNames.some(n => n.includes('obj'))).toBe(true);
    });

    it('excludes declarations and keywords', () => {
      const content = `function foo() {}
const bar = () => {};
if (x) {}
for (let i = 0; i < 10; i++) {}
return x;
new Map();
class Foo {}`;
      const calls = extractFunctionCalls(content, 'javascript');
      const callNames = calls.map(c => c.name);
      expect(callNames).not.toContain('function');
      expect(callNames).not.toContain('const');
      expect(callNames).not.toContain('if');
      expect(callNames).not.toContain('for');
      expect(callNames).not.toContain('return');
      expect(callNames).not.toContain('new');
      expect(callNames).not.toContain('class');
    });

    it('tracks line numbers', () => {
      const content = `foo();
bar();
baz();`;
      const calls = extractFunctionCalls(content, 'javascript');
      expect(calls[0]?.line).toBe(1);
      expect(calls[1]?.line).toBe(2);
      expect(calls[2]?.line).toBe(3);
    });
  });

  describe('Python', () => {
    it('extracts function calls', () => {
      const content = `foo()
bar()`;
      const calls = extractFunctionCalls(content, 'python');
      const callNames = calls.map(c => c.name);
      expect(callNames).toContain('foo');
      expect(callNames).toContain('bar');
    });

    it('excludes Python keywords', () => {
      const content = `if x:
    for i in range(10):
        return x`;
      const calls = extractFunctionCalls(content, 'python');
      const callNames = calls.map(c => c.name);
      expect(callNames).not.toContain('if');
      expect(callNames).not.toContain('for');
      expect(callNames).not.toContain('return');
    });
  });

  describe('Go', () => {
    it('extracts function calls', () => {
      const content = `fmt.Println("hello")
os.Exit(1)`;
      const calls = extractFunctionCalls(content, 'go');
      const callNames = calls.map(c => c.name);
      expect(callNames.some(n => n.includes('fmt'))).toBe(true);
      expect(callNames.some(n => n.includes('os'))).toBe(true);
    });
  });
});

describe('normalizeImportPath', () => {
  it('handles relative paths', () => {
    const result = normalizeImportPath('./utils', '/src/components/Button.tsx', '/project');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('removes query strings', () => {
    const result = normalizeImportPath('./utils?foo=bar', '/src/index.ts', '/project');
    expect(result).not.toContain('?');
  });

  it('returns package imports unchanged', () => {
    const result = normalizeImportPath('react', '/src/index.tsx', '/project');
    expect(result).toBe('react');
  });
});

describe('buildDependencyGraph', () => {
  const testProjectDir = '/tmp/test-dep-graph-' + Date.now();

  beforeEach(() => {
    mkdirSync(join(testProjectDir, 'src'), { recursive: true });
    writeFileSync(join(testProjectDir, 'src', 'index.ts'), `import { foo } from './foo';
import { bar } from './bar';
import React from 'react';
foo();
bar();
`);
    writeFileSync(join(testProjectDir, 'src', 'foo.ts'), `export function foo() {}`);
    writeFileSync(join(testProjectDir, 'src', 'bar.ts'), `export function bar() {}`);
  });

  afterEach(() => {
    try {
      rmSync(testProjectDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('builds graph structure', async () => {
    const graph = await buildDependencyGraph(testProjectDir);
    expect(graph.projectPath).toBe(testProjectDir);
    expect(graph.lastUpdated).toBeInstanceOf(Date);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  it('includes project path', async () => {
    const graph = await buildDependencyGraph(testProjectDir);
    expect(graph.projectPath).toBe(testProjectDir);
  });
});

describe('getFilesImportingFrom', () => {
  it('finds files importing a module', () => {
    const graph = {
      projectPath: '/test',
      edges: [
        {
          sourceId: '1',
          targetId: '2',
          sourceFile: '/src/index.ts',
          targetFile: '/src/utils.ts',
          importName: 'utils',
        },
        {
          sourceId: '3',
          targetId: '2',
          sourceFile: '/src/other.ts',
          targetFile: '/src/utils.ts',
          importName: 'utils',
        },
      ],
      lastUpdated: new Date(),
    };

    const files = getFilesImportingFrom(graph, 'utils');
    expect(files).toContain('/src/index.ts');
    expect(files).toContain('/src/other.ts');
  });
});

describe('getDependencies', () => {
  it('returns files that a file depends on', () => {
    const graph = {
      projectPath: '/test',
      edges: [
        {
          sourceId: '1',
          targetId: '2',
          sourceFile: '/src/index.ts',
          targetFile: '/src/foo.ts',
        },
        {
          sourceId: '1',
          targetId: '3',
          sourceFile: '/src/index.ts',
          targetFile: '/src/bar.ts',
        },
      ],
      lastUpdated: new Date(),
    };

    const deps = getDependencies(graph, '/src/index.ts');
    expect(deps).toContain('/src/foo.ts');
    expect(deps).toContain('/src/bar.ts');
  });
});

describe('getDependents', () => {
  it('returns files that depend on a file', () => {
    const graph = {
      projectPath: '/test',
      edges: [
        {
          sourceId: '1',
          targetId: '2',
          sourceFile: '/src/index.ts',
          targetFile: '/src/utils.ts',
        },
        {
          sourceId: '3',
          targetId: '2',
          sourceFile: '/src/other.ts',
          targetFile: '/src/utils.ts',
        },
      ],
      lastUpdated: new Date(),
    };

    const dependents = getDependents(graph, '/src/utils.ts');
    expect(dependents).toContain('/src/index.ts');
    expect(dependents).toContain('/src/other.ts');
  });
});

describe('findFunctionCalls', () => {
  it('finds calls to a specific function', () => {
    const content = `
foo();
bar();
foo();
baz();
`;
    const calls = findFunctionCalls(content, 'foo', 'javascript');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for non-existent function', () => {
    const content = `foo(); bar();`;
    const calls = findFunctionCalls(content, 'nonexistent', 'javascript');
    expect(calls.length).toBe(0);
  });
});
