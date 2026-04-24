import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { v4 as uuid } from 'uuid';
import type { DependencyEdge, DependencyGraph } from '../types.js';

export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'go';

interface ParsedImport {
  name: string;
  path: string;
  line: number;
  type: 'named' | 'default' | 'namespace' | 'require';
  importedNames?: string[];
}

interface ResolvedImport extends ParsedImport {
  resolvedPath: string;
}

interface FunctionCall {
  name: string;
  line: number;
  column: number;
}

interface ImportIndex {
  [filePath: string]: {
    imports: ResolvedImport[];
    resolvedPath: string;
  };
}

const LANGUAGE_EXTENSIONS: Record<string, SupportedLanguage> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go',
};

const DEFAULT_IGNORE_PATTERNS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', 'target', '.venv', 'venv', '.env', 'coverage', '.cache',
]);

export function normalizeImportPath(importPath: string, sourceFile: string, _projectRoot: string): string {
  let normalized = importPath.replace(/[?#].*$/, '');

  if (normalized.startsWith('.')) {
    const sourceDir = dirname(sourceFile);
    const resolved = join(sourceDir, normalized);

    try {
      if (statSync(resolved).isDirectory()) {
        for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.py', '/index.ts', '/index.js']) {
          try { statSync(resolved + ext); return resolved + ext; } catch { /* continue */ }
        }
      }
    } catch { /* continue */ }

    try {
      if (statSync(resolved).isFile()) return resolved;
    } catch { /* continue */ }

    for (const tryExt of ['.ts', '.tsx', '.js', '.jsx', '.py', '.go']) {
      try { statSync(resolved + tryExt); return resolved + tryExt; } catch { /* continue */ }
    }
    return resolved;
  }

  return normalized;
}

function parseJSImports(_content: string, _filePath: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const lines = _content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    const lineNum = i + 1;

    let m = line.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (m && m[1] && m[2]) {
      imports.push({ name: m[1], path: m[2], line: lineNum, type: 'namespace', importedNames: ['*'] });
      continue;
    }

    m = line.match(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (m && m[1] && m[2]) {
      const names = m[1].split(',').map(n => n.trim()).filter(n => n);
      imports.push({ name: m[2], path: m[2], line: lineNum, type: 'named', importedNames: names });
      continue;
    }

    m = line.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (m && m[1] && m[2]) {
      imports.push({ name: m[1], path: m[2], line: lineNum, type: 'default', importedNames: [m[1]] });
      continue;
    }

    m = line.match(/^import\s+(\w+)\s*,\s*\{[^}]+\}\s+from\s+['"]([^'"]+)['"]/);
    if (m && m[1] && m[2]) {
      const namedM = line.match(/\{([^}]+)\}/);
      const names = namedM && namedM[1] ? namedM[1].split(',').map(n => n.trim()).filter(n => n) : [];
      names.unshift(m[1]);
      imports.push({ name: m[2], path: m[2], line: lineNum, type: 'named', importedNames: names });
      continue;
    }

    m = line.match(/^const\s+\{([^}]+)\}\s+=\s+require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m && m[1] && m[2]) {
      const names = m[1].split(',').map(n => n.trim()).filter(n => n);
      imports.push({ name: m[2], path: m[2], line: lineNum, type: 'require', importedNames: names });
      continue;
    }

    m = line.match(/^const\s+(\w+)\s+=\s+require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m && m[1] && m[2]) {
      imports.push({ name: m[1], path: m[2], line: lineNum, type: 'namespace', importedNames: ['*'] });
    }
  }

  return imports;
}

function parsePythonImports(content: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const lineNum = i + 1;

    let m = line.match(/^import\s+(\w+)(?:\s+as\s+\w+)?/);
    if (m && m[1]) {
      imports.push({ name: m[1], path: m[1], line: lineNum, type: 'default', importedNames: [m[1]] });
      continue;
    }

    m = line.match(/^from\s+((?:\w+\.)*\w+)\s+import\s+(.+)/);
    if (m && m[1] && m[2]) {
      const names = m[2].replace(/[()]/g, '').split(',').map(n => n.trim()).filter(n => n && n !== '*');
      imports.push({ name: m[1], path: m[1], line: lineNum, type: 'named', importedNames: names });
    }
  }

  return imports;
}

function parseGoImports(content: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const lineNum = i + 1;

    let m = rawLine.match(/^import\s+"([^"]+)"/);
    if (m && m[1]) {
      imports.push({ name: m[1], path: m[1], line: lineNum, type: 'default' });
      continue;
    }

    m = rawLine.match(/^import\s+(\w+)\s+"([^"]+)"/);
    if (m && m[1] && m[2]) {
      imports.push({ name: m[1], path: m[2], line: lineNum, type: 'namespace', importedNames: [m[1]] });
    }
  }

  return imports;
}

export function parseImports(filePath: string, content: string, language: string): ParsedImport[] {
  const lang = language.toLowerCase();
  if (lang === 'python') return parsePythonImports(content);
  if (lang === 'go') return parseGoImports(content);
  return parseJSImports(content, filePath);
}

function extractJSCalls(content: string): FunctionCall[] {
  const calls: FunctionCall[] = [];
  const lines = content.split('\n');

  const excludeList = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'return', 'throw', 'new', 'typeof',
    'instanceof', 'import', 'export', 'from', 'default', 'const', 'let', 'var',
    'function', 'class', 'extends', 'implements', 'interface', 'type', 'enum',
    'async', 'await', 'yield', 'static', 'public', 'private', 'protected', 'readonly',
    'get', 'set',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine;
    const lineNum = i + 1;
    const matches = line.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\(/g);

    for (const match of matches) {
      const funcName = match[1];
      if (!funcName || excludeList.has(funcName)) continue;
      const beforeMatch = line.substring(0, match.index!);
      if (/^(?:function|const|let|var|class|import|export|if|while|for|return|throw|new)\s*$/.test(beforeMatch.trim())) continue;
      calls.push({ name: funcName, line: lineNum, column: match.index! });
    }
  }

  return calls;
}

function extractPythonCalls(content: string): FunctionCall[] {
  const calls: FunctionCall[] = [];
  const lines = content.split('\n');

  const excludeList = new Set([
    'if', 'while', 'for', 'try', 'except', 'finally', 'with', 'return', 'raise',
    'import', 'from', 'as', 'def', 'class', 'lambda', 'assert', 'pass', 'break',
    'continue', 'global', 'nonlocal', 'yield', 'async', 'await', 'print', 'len',
    'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'bool', 'type',
    'isinstance', 'hasattr', 'getattr', 'setattr', 'open', 'input', 'enumerate',
    'zip', 'map', 'filter',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine;
    const lineNum = i + 1;
    const matches = line.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);

    for (const match of matches) {
      const funcName = match[1];
      if (!funcName || excludeList.has(funcName)) continue;
      const beforeMatch = line.substring(0, match.index!);
      if (/^(?:def|class|import|from)\s*$/.test(beforeMatch.trim())) continue;
      calls.push({ name: funcName, line: lineNum, column: match.index! });
    }
  }

  return calls;
}

function extractGoCalls(content: string): FunctionCall[] {
  const calls: FunctionCall[] = [];
  const lines = content.split('\n');

  const excludeList = new Set([
    'if', 'else', 'for', 'switch', 'case', 'default', 'return', 'break', 'continue',
    'fallthrough', 'goto', 'go', 'defer', 'chan', 'map', 'make', 'new', 'append',
    'copy', 'delete', 'panic', 'recover', 'close', 'len', 'cap', 'real', 'imag',
    'complex', 'print', 'println', 'printf', 'fmt', 'os', 'package', 'import', 'func',
    'type', 'struct', 'interface', 'const', 'var',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine;
    const lineNum = i + 1;
    const matches = line.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\(/g);

    for (const match of matches) {
      const funcName = match[1];
      if (!funcName || excludeList.has(funcName)) continue;
      const beforeMatch = line.substring(0, match.index!);
      if (/^(?:func|type|const|var)\s*$/.test(beforeMatch.trim())) continue;
      calls.push({ name: funcName, line: lineNum, column: match.index! });
    }
  }

  return calls;
}

export function extractFunctionCalls(content: string, language: string): FunctionCall[] {
  const lang = language.toLowerCase();
  if (lang === 'python') return extractPythonCalls(content);
  if (lang === 'go') return extractGoCalls(content);
  return extractJSCalls(content);
}

function scanDirectory(dirPath: string, ignorePatterns: Set<string> = DEFAULT_IGNORE_PATTERNS): string[] {
  const files: string[] = [];
  const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go']);

  const scan = (dir: string): void => {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (ignorePatterns.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.isFile() && extensions.has(extname(entry.name))) {
          files.push(fullPath);
        }
      }
    } catch { /* skip inaccessible directories */ }
  };

  scan(dirPath);
  return files;
}

export async function buildDependencyGraph(
  projectPath: string,
  options?: { ignorePatterns?: string[]; fileExtensions?: string[] }
): Promise<DependencyGraph> {
  const ignorePatterns = new Set(options?.ignorePatterns ?? Array.from(DEFAULT_IGNORE_PATTERNS));

  const files = scanDirectory(projectPath, ignorePatterns);
  const importIndex: ImportIndex = {};
  const fileIdMap = new Map<string, string>();

  for (const file of files) {
    const id = uuid();
    fileIdMap.set(file, id);

    try {
      const content = readFileSync(file, 'utf-8');
      const lang = LANGUAGE_EXTENSIONS[extname(file).toLowerCase()] ?? 'javascript';
      const imports = parseImports(file, content, lang);

      const resolvedImports: ResolvedImport[] = imports.map((imp) => ({
        ...imp,
        resolvedPath: normalizeImportPath(imp.path, file, projectPath),
      }));

      importIndex[file] = { imports: resolvedImports, resolvedPath: file };
    } catch { continue; }
  }

  const edges: DependencyEdge[] = [];

  for (const [sourceFile, { imports }] of Object.entries(importIndex)) {
    const sourceId = fileIdMap.get(sourceFile);
    if (!sourceId) continue;

    for (const imp of imports) {
      let targetFile: string | undefined;
      let targetId: string | undefined;

      for (const [file, id] of fileIdMap.entries()) {
        if (
          file === imp.resolvedPath ||
          file.endsWith(imp.resolvedPath) ||
          imp.resolvedPath.endsWith(file) ||
          file.includes(imp.resolvedPath) ||
          imp.resolvedPath.includes(file)
        ) {
          targetFile = file;
          targetId = id;
          break;
        }
      }

      if (targetFile && targetId) {
        edges.push({
          sourceId,
          targetId,
          sourceFile,
          targetFile,
          importName: imp.importedNames?.join(', ') ?? imp.name,
          line: imp.line,
        });
      }
    }
  }

  return { projectPath, edges, lastUpdated: new Date() };
}

export function getFilesImportingFrom(graph: DependencyGraph, modulePath: string): string[] {
  const files = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.targetFile.includes(modulePath) || edge.importName?.includes(modulePath)) {
      files.add(edge.sourceFile);
    }
  }
  return Array.from(files);
}

export function getDependencies(graph: DependencyGraph, filePath: string): string[] {
  const deps = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.sourceFile === filePath) deps.add(edge.targetFile);
  }
  return Array.from(deps);
}

export function getDependents(graph: DependencyGraph, filePath: string): string[] {
  const dependents = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.targetFile === filePath) dependents.add(edge.sourceFile);
  }
  return Array.from(dependents);
}

export function findFunctionCalls(content: string, functionName: string, language: string): FunctionCall[] {
  return extractFunctionCalls(content, language).filter((call) => call.name === functionName);
}
