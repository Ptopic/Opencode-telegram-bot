import { CodeChunker, type Chunk } from '@chonkiejs/core';
import { v4 as uuid } from 'uuid';
import type { Node, Edge, Language as GraphLanguage } from './types.js';

interface ExtractedSymbol {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  filePath: string;
  language: string;
}

interface ExtractedReference {
  sourceId: string;
  targetName: string;
  kind: string;
  line: number;
}

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
};

export class TreeSitterExtractor {
  private chunkers: Map<string, CodeChunker> = new Map();
  private initialized: boolean = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const languages = ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp'];

    for (const lang of languages) {
      const chunker = await CodeChunker.create({
        language: lang,
        chunkSize: 2048,
      });
      this.chunkers.set(lang, chunker);
    }

    this.initialized = true;
  }

  async extractSymbols(filePath: string, content: string, language: string): Promise<{ nodes: Node[]; edges: Edge[] }> {
    await this.initialize();

    const lang = LANGUAGE_MAP[filePath.substring(filePath.lastIndexOf('.'))] ?? 'typescript';
    const chunker = this.chunkers.get(lang);

    if (!chunker) {
      throw new Error(`No chunker available for language: ${language}`);
    }

    const chunks: Chunk[] = chunker.chunk(content);

    const symbols: ExtractedSymbol[] = [];
    const references: ExtractedReference[] = [];

    for (const chunk of chunks) {
      const startLine = content.substring(0, chunk.startIndex).split('\n').length;
      const endLine = content.substring(0, chunk.endIndex).split('\n').length;

      const chunkSymbols = this.extractFromChunk(chunk.text, startLine, lang, filePath);
      symbols.push(...chunkSymbols);
    }

    for (const chunk of chunks) {
      const startLine = content.substring(0, chunk.startIndex).split('\n').length;
      const chunkRefs = this.extractReferencesFromChunk(chunk.text, startLine, symbols);
      references.push(...chunkRefs);
    }

    const nodes: Node[] = symbols.map(s => ({
      id: s.id,
      kind: s.kind as Node['kind'],
      name: s.name,
      qualifiedName: s.qualifiedName,
      filePath: s.filePath,
      language: s.language as GraphLanguage,
      startLine: s.startLine,
      endLine: s.endLine,
      startColumn: 0,
      endColumn: 0,
      isExported: s.isExported,
      updatedAt: Date.now(),
    }));

    const edges: Edge[] = [];
    for (const ref of references) {
      const sourceSymbol = symbols.find(s => s.id === ref.sourceId);
      if (!sourceSymbol) continue;

      const targetSymbol = this.findSymbolByName(ref.targetName, symbols);
      if (targetSymbol && targetSymbol.id !== ref.sourceId) {
        edges.push({
          source: ref.sourceId,
          target: targetSymbol.id,
          kind: ref.kind as Edge['kind'],
          line: ref.line,
          metadata: {},
        });
      }
    }

    return { nodes, edges };
  }

  private extractFromChunk(chunkText: string, baseLine: number, language: string, filePath: string): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const lines = chunkText.split('\n');

    let classScope: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const lineNum = baseLine + i;

      const classMatch = line.match(/^\s*(?:export\s+)?class\s+(\w+)/);
      if (classMatch?.[1]) {
        const name = classMatch[1];
        symbols.push({
          id: uuid(),
          kind: 'class',
          name,
          qualifiedName: name,
          startLine: lineNum,
          endLine: lineNum,
          isExported: line.includes('export'),
          filePath,
          language,
        });
        classScope = name;
        continue;
      }

      if (classScope && line.trim().startsWith('}')) {
        classScope = null;
      }

      const functionMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (functionMatch?.[1]) {
        const name = functionMatch[1];
        const qualifiedName = classScope ? `${classScope}.${name}` : name;
        symbols.push({
          id: uuid(),
          kind: 'function',
          name,
          qualifiedName,
          startLine: lineNum,
          endLine: lineNum,
          isExported: line.includes('export'),
          filePath,
          language,
        });
        continue;
      }

      const arrowFunctionMatch = line.match(/^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/);
      if (arrowFunctionMatch?.[1]) {
        const name = arrowFunctionMatch[1];
        const qualifiedName = classScope ? `${classScope}.${name}` : name;
        symbols.push({
          id: uuid(),
          kind: 'function',
          name,
          qualifiedName,
          startLine: lineNum,
          endLine: lineNum,
          isExported: line.includes('export'),
          filePath,
          language,
        });
        continue;
      }

      const methodMatch = line.match(/^\s*(?:readonly\s+)?(\w+)\s*\([^)]*\)\s*\{/);
      if (methodMatch?.[1] && classScope) {
        const name = methodMatch[1];
        if (!['if', 'else', 'for', 'while', 'switch', 'catch'].includes(name)) {
          const qualifiedName = `${classScope}.${name}`;
          symbols.push({
            id: uuid(),
            kind: 'method',
            name,
            qualifiedName,
            startLine: lineNum,
            endLine: lineNum,
            isExported: false,
            filePath,
            language,
          });
        }
        continue;
      }

      const interfaceMatch = line.match(/^\s*(?:export\s+)?interface\s+(\w+)/);
      if (interfaceMatch?.[1]) {
        const name = interfaceMatch[1];
        symbols.push({
          id: uuid(),
          kind: 'interface',
          name,
          qualifiedName: name,
          startLine: lineNum,
          endLine: lineNum,
          isExported: line.includes('export'),
          filePath,
          language,
        });
        continue;
      }

      const typeMatch = line.match(/^\s*(?:export\s+)?type\s+(\w+)/);
      if (typeMatch?.[1]) {
        const name = typeMatch[1];
        symbols.push({
          id: uuid(),
          kind: 'type_alias',
          name,
          qualifiedName: name,
          startLine: lineNum,
          endLine: lineNum,
          isExported: line.includes('export'),
          filePath,
          language,
        });
        continue;
      }

      const enumMatch = line.match(/^\s*(?:export\s+)?enum\s+(\w+)/);
      if (enumMatch?.[1]) {
        const name = enumMatch[1];
        symbols.push({
          id: uuid(),
          kind: 'enum',
          name,
          qualifiedName: name,
          startLine: lineNum,
          endLine: lineNum,
          isExported: line.includes('export'),
          filePath,
          language,
        });
        continue;
      }

      const importMatch = line.match(/^\s*import\s+(?:{[^}]+}|\w+)\s+from\s+['"](.+?)['"]/);
      if (importMatch?.[1]) {
        const name = importMatch[1];
        symbols.push({
          id: uuid(),
          kind: 'import',
          name,
          qualifiedName: name,
          startLine: lineNum,
          endLine: lineNum,
          isExported: false,
          filePath,
          language,
        });
        continue;
      }
    }

    return symbols;
  }

  private extractReferencesFromChunk(chunkText: string, baseLine: number, symbols: ExtractedSymbol[]): ExtractedReference[] {
    const references: ExtractedReference[] = [];
    const lines = chunkText.split('\n');

    const functionSymbols = symbols.filter(s => s.kind === 'function' || s.kind === 'method');
    const classSymbols = symbols.filter(s => s.kind === 'class');
    const allDefinedNames = new Set(symbols.map(s => s.name));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const lineNum = baseLine + i;

      const containingSymbol = this.findContainingSymbolForLine(lineNum, symbols);

      const newMatch = line.match(/\bnew\s+(\w+)\s*\(/);
      if (newMatch?.[1]) {
        const className = newMatch[1];
        const targetExists = classSymbols.some(s => s.name === className);
        if (targetExists && containingSymbol) {
          references.push({
            sourceId: containingSymbol.id,
            targetName: className,
            kind: 'instantiates',
            line: lineNum,
          });
        }
      }

      const extendsMatch = line.match(/\bextends\s+(\w+)/);
      if (extendsMatch?.[1]) {
        const className = extendsMatch[1];
        const targetExists = classSymbols.some(s => s.name === className);
        if (targetExists && containingSymbol) {
          references.push({
            sourceId: containingSymbol.id,
            targetName: className,
            kind: 'extends',
            line: lineNum,
          });
        }
      }

      for (const fnSym of functionSymbols) {
        const fnName = fnSym.name;
        if (line.includes(`${fnName}(`) && !line.includes(`function ${fnName}`) && !line.includes(`const ${fnName}`)) {
          if (containingSymbol && containingSymbol.id !== fnSym.id) {
            references.push({
              sourceId: containingSymbol.id,
              targetName: fnName,
              kind: 'calls',
              line: lineNum,
            });
          }
        }
      }
    }

    return references;
  }

  private findContainingSymbolForLine(lineNum: number, symbols: ExtractedSymbol[]): ExtractedSymbol | null {
    let result: ExtractedSymbol | null = null;
    for (const sym of symbols) {
      if (sym.startLine <= lineNum && sym.endLine >= lineNum) {
        result = sym;
      } else if (sym.startLine < lineNum && sym.startLine > (result?.startLine ?? 0)) {
        result = sym;
      }
    }
    return result;
  }

  private findSymbolByName(name: string, symbols: ExtractedSymbol[]): ExtractedSymbol | undefined {
    return symbols.find(s => s.qualifiedName === name || s.name === name);
  }
}