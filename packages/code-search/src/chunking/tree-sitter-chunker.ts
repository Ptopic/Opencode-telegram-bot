import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { readdirSync } from 'fs';
import type { Tree, SyntaxNode } from 'tree-sitter';
import type { CodeChunk } from '../types.js';

export interface ParsedChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: 'function' | 'class' | 'module' | 'block' | 'file';
  fqn: string;
  className?: string;
  metadata: Record<string, unknown>;
}

interface ChunkCandidate {
  node: SyntaxNode;
  name: string;
  fqn: string;
  className?: string;
  startLine: number;
  endLine: number;
  docstring?: string;
  children: ChunkCandidate[];
  chunkType: 'function' | 'class' | 'module' | 'block' | 'file';
}

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

const SMALL_FUNCTION_TOKENS = 100;
const LARGE_FUNCTION_TOKENS = 500;

let parserCache: Map<string, any> = new Map();

async function getParser(language: string): Promise<any> {
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  const Parser = (await import('tree-sitter')).default;
  const parser = new Parser();

  let languageModule: any;
  switch (language) {
    case 'typescript':
    case 'javascript':
      try {
        const ts = await import('tree-sitter-typescript');
        languageModule = ts.typescript ?? ts;
      } catch {
        const js = await import('tree-sitter-javascript');
        languageModule = js;
      }
      break;
    case 'python':
      languageModule = await import('tree-sitter-python');
      break;
    case 'go':
      languageModule = await import('tree-sitter-go');
      break;
    case 'rust':
      languageModule = await import('tree-sitter-rust');
      break;
    default:
      throw new Error(`Unsupported language: ${language}`);
  }

  parser.setLanguage(languageModule);
  parserCache.set(language, parser);
  return parser;
}

export function getLanguageFromExtension(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return LANGUAGE_EXTENSIONS[ext] ?? 'text';
}

export async function parseFile(filePath: string): Promise<Tree> {
  const content = await readFile(filePath, 'utf-8');
  const language = getLanguageFromExtension(filePath);

  if (language === 'text') {
    throw new Error(`Cannot parse ${filePath}: unsupported file type`);
  }

  const parser = await getParser(language);
  return parser.parse(content);
}

function getNodeText(node: SyntaxNode, content: string): string {
  return content.slice(node.startIndex, node.endIndex);
}

function countTokens(text: string): number {
  return text.split(/\s+/).filter(t => t.length > 0).length;
}

function extractDocstring(node: SyntaxNode, content: string): string | undefined {
  const prevSibling = node.previousSibling;
  if (!prevSibling) return undefined;

  if (prevSibling.type === 'comment' || prevSibling.type === 'expression_statement') {
    const text = getNodeText(prevSibling, content).trim();
    if (text.startsWith('///') || text.startsWith('//') || text.startsWith('#')) {
      return text;
    }
  }

  if (prevSibling.type === 'decorated_definition') {
    const decorator = prevSibling.child(0);
    if (decorator) {
      return getNodeText(decorator, content).trim();
    }
  }

  return undefined;
}

function getFqn(className: string | undefined, functionName: string): string {
  if (className) {
    return `${className}.${functionName}`;
  }
  return functionName;
}

function findDeclarations(node: SyntaxNode, content: string, language: string, classContext?: string): ChunkCandidate[] {
  const candidates: ChunkCandidate[] = [];

  const functionNodeTypes = new Set([
    'function_declaration',
    'method_definition',
    'function',
    'arrow_function',
    'class_declaration',
    'class',
    'module',
    'program',
  ]);

  const skipNodeTypes = new Set([
    'comment',
    'string',
    'import_statement',
    'export_statement',
  ]);

  if (skipNodeTypes.has(node.type)) {
    return candidates;
  }

  if (functionNodeTypes.has(node.type)) {
    let name = '';
    let chunkType: 'function' | 'class' | 'module' | 'block' | 'file' = 'function';

    if (node.type === 'function_declaration' || node.type === 'function') {
      const nameChild = node.childForFieldName('name');
      if (nameChild) {
        name = nameChild.text;
      }
    } else if (node.type === 'method_definition') {
      const nameChild = node.childForFieldName('name');
      if (nameChild) {
        name = nameChild.text;
      }
    } else if (node.type === 'arrow_function') {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator') {
        name = parent.childForFieldName('name')?.text ?? 'anonymous';
      } else {
        name = 'arrow_function';
      }
    } else if (node.type === 'class_declaration' || node.type === 'class') {
      const nameChild = node.childForFieldName('name');
      if (nameChild) {
        name = nameChild.text;
      }
      chunkType = 'class';
    } else if (node.type === 'module' || node.type === 'program') {
      name = 'module';
      chunkType = 'module';
    }

    if (name) {
      const docstring = extractDocstring(node, content);
      const fqn = classContext
        ? getFqn(classContext, name)
        : name;

      candidates.push({
        node,
        name,
        fqn,
        className: classContext,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        docstring,
        children: [],
        chunkType,
      });
    }

    if (node.type === 'class_declaration' || node.type === 'class') {
      const body = node.childForFieldName('body') ?? node.childForFieldName('declaration');
      if (body) {
        for (const child of body.children) {
          if (child.type === 'method_definition' || child.type === 'function_declaration') {
            candidates.push(...findDeclarations(child, content, language, name));
          }
        }
      }
    }
  }

  for (const child of node.children) {
    candidates.push(...findDeclarations(child, content, language, classContext));
  }

  return candidates;
}

function shouldGroupWithPrevious(
  candidate: ChunkCandidate,
  previousCandidate: ChunkCandidate | undefined,
  content: string
): boolean {
  if (!previousCandidate) return false;
  if (candidate.className !== previousCandidate.className) return false;

  const candidateText = getNodeText(candidate.node, content);
  const prevText = getNodeText(previousCandidate.node, content);

  const candidateTokens = countTokens(candidateText);
  const prevTokens = countTokens(prevText);

  if (candidateTokens + prevTokens > SMALL_FUNCTION_TOKENS) return false;
  if (candidate.startLine - previousCandidate.endLine > 5) return false;

  return true;
}

function splitLargeChunk(chunk: ParsedChunk, content: string): ParsedChunk[] {
  const lines = chunk.content.split('\n');
  if (lines.length < 20) return [chunk];

  const chunks: ParsedChunk[] = [];
  let currentChunkLines: string[] = [];
  let currentStartLine = chunk.startLine;
  let currentLines = 0;

  const blockKeywords = ['if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch', 'finally'];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (currentLines >= LARGE_FUNCTION_TOKENS / 5 || (blockKeywords.some(kw => trimmed.startsWith(kw)) && currentLines > 10)) {
      if (currentChunkLines.length > 0) {
        const endLine = chunk.startLine + i - 1;
        chunks.push({
          ...chunk,
          id: `${chunk.id}_split_${chunks.length}`,
          content: currentChunkLines.join('\n'),
          startLine: currentStartLine,
          endLine,
        });
        currentChunkLines = [];
        currentStartLine = chunk.startLine + i;
        currentLines = 0;
      }
    }

    currentChunkLines.push(line);
    currentLines++;
  }

  if (currentChunkLines.length > 0) {
    chunks.push({
      ...chunk,
      id: `${chunk.id}_split_${chunks.length}`,
      content: currentChunkLines.join('\n'),
      startLine: currentStartLine,
      endLine: chunk.endLine,
    });
  }

  return chunks.length > 0 ? chunks : [chunk];
}

export function extractChunks(tree: Tree, filePath: string, language: string): ParsedChunk[] {
  const rootNode = tree.rootNode;
  const content = getNodeText(rootNode, '');
  const candidates = findDeclarations(rootNode, content, language);

  if (candidates.length === 0) {
    return [{
      id: `chunk_${filePath}_module`,
      filePath,
      content,
      startLine: 1,
      endLine: rootNode.endPosition.row + 1,
      language,
      chunkType: 'file',
      fqn: 'module',
      metadata: {},
    }];
  }

  const chunks: ParsedChunk[] = [];
  let groupedContent: string[] = [];
  let groupedStartLine = 0;
  let groupedFqn = '';
  let groupedClassName = '';

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;

    const nodeText = getNodeText(candidate.node, content);
    const prevCandidate = candidates[i - 1];

    if (shouldGroupWithPrevious(candidate, prevCandidate, content)) {
      if (groupedContent.length === 0 && prevCandidate) {
        groupedContent.push(getNodeText(prevCandidate.node, content));
        groupedStartLine = prevCandidate.startLine;
        groupedFqn = prevCandidate.fqn;
        groupedClassName = prevCandidate.className ?? '';
      }
      groupedContent.push(nodeText);
    } else {
      if (groupedContent.length > 0) {
        const lastPrev = candidates[i - 1];
        const groupedChunk: ParsedChunk = {
          id: `chunk_${filePath}_${chunks.length}`,
          filePath,
          content: groupedContent.join('\n\n'),
          startLine: groupedStartLine,
          endLine: lastPrev?.endLine ?? candidate.startLine,
          language,
          chunkType: 'function',
          fqn: groupedFqn,
          className: groupedClassName || undefined,
          metadata: {},
        };
        chunks.push(...splitLargeChunk(groupedChunk, groupedContent.join('\n\n')));
        groupedContent = [];
      }

      const chunk: ParsedChunk = {
        id: `chunk_${filePath}_${chunks.length}`,
        filePath,
        content: nodeText,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        language,
        chunkType: candidate.className ? 'function' : candidate.chunkType,
        fqn: candidate.fqn,
        className: candidate.className,
        metadata: {
          docstring: candidate.docstring,
        },
      };

      if (countTokens(nodeText) > LARGE_FUNCTION_TOKENS) {
        chunks.push(...splitLargeChunk(chunk, nodeText));
      } else {
        chunks.push(chunk);
      }
    }
  }

  if (groupedContent.length > 0) {
    const lastCandidate = candidates[candidates.length - 1];
    const groupedChunk: ParsedChunk = {
      id: `chunk_${filePath}_${chunks.length}`,
      filePath,
      content: groupedContent.join('\n\n'),
      startLine: groupedStartLine,
      endLine: lastCandidate?.endLine ?? groupedStartLine,
      language,
      chunkType: 'function',
      fqn: groupedFqn,
      className: groupedClassName || undefined,
      metadata: {},
    };
    chunks.push(groupedChunk);
  }

  return chunks;
}

export async function chunkFile(filePath: string): Promise<ParsedChunk[]> {
  try {
    const tree = await parseFile(filePath);
    const language = getLanguageFromExtension(filePath);
    return extractChunks(tree, filePath, language);
  } catch (error) {
    console.error(`Error chunking file ${filePath}:`, error);
    return [];
  }
}

export async function* chunkDirectory(
  dirPath: string,
  ignorePatterns?: string[]
): AsyncGenerator<ParsedChunk[]> {
  const ignoreSet = new Set(ignorePatterns ?? [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    '.nuxt',
    '__pycache__',
    'target',
  ]);

  const extensions = new Set(Object.keys(LANGUAGE_EXTENSIONS));

  const scanDir = (dir: string): string[] => {
    const files: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (ignoreSet.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...scanDir(fullPath));
        } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      }
    } catch {
      // skip inaccessible directories
    }
    return files;
  };

  const files = scanDir(dirPath);

  for (const file of files) {
    const chunks = await chunkFile(file);
    if (chunks.length > 0) {
      yield chunks;
    }
  }
}

export function toCodeChunk(parsed: ParsedChunk): CodeChunk {
  return {
    id: parsed.id,
    filePath: parsed.filePath,
    content: parsed.content,
    startLine: parsed.startLine,
    endLine: parsed.endLine,
    language: parsed.language,
    chunkType: parsed.chunkType,
    fqn: parsed.fqn,
    metadata: parsed.metadata,
  };
}
