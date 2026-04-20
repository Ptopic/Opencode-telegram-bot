import type { Tree, SyntaxNode } from 'tree-sitter';
import type { Node, Edge, NodeKind, EdgeKind } from './types.js';

type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'rust';

interface ExtractorConfig {
  includeImports?: boolean;
  includeCalls?: boolean;
}

interface SymbolDefinition {
  node: SyntaxNode;
  name: string;
  qualifiedName: string;
  kind: NodeKind;
  startLine: number;
  endLine: number;
  isExported: boolean;
  classContext?: string;
}

const SYMBOL_NODE_TYPES: Record<string, NodeKind> = {
  function_declaration: 'function',
  method_definition: 'method',
  function: 'function',
  arrow_function: 'function',
  class_declaration: 'class',
  class: 'class',
  interface_declaration: 'interface',
  type_declaration: 'type_alias',
  enum_declaration: 'enum',
  struct_declaration: 'struct',
  variable_declarator: 'variable',
  constant_declarator: 'constant',
  module_declaration: 'module',
  import_statement: 'import',
  import_clause: 'import',
};

let parserCache: Map<string, any> = new Map();

async function getParser(language: Language): Promise<any> {
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

function getLanguageFromFilePath(filePath: string): Language {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  const map: Record<string, Language> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
  };
  return map[ext] ?? 'javascript';
}

function getNodeText(node: SyntaxNode, content: string): string {
  return content.slice(node.startIndex, node.endIndex);
}

function getSymbolKind(nodeType: string): NodeKind | null {
  return SYMBOL_NODE_TYPES[nodeType] ?? null;
}

function isExported(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'export_clause') return true;
  if (parent.type === 'export_statement') return true;
  if (parent.type === 'declaration') return isExported(parent);
  return false;
}

function extractSymbolName(node: SyntaxNode, nodeType: string): string {
  switch (nodeType) {
    case 'function_declaration':
    case 'function':
    case 'class_declaration':
    case 'interface_declaration':
    case 'type_declaration':
    case 'enum_declaration':
    case 'struct_declaration': {
      const nameChild = node.childForFieldName('name');
      return nameChild?.text ?? '';
    }
    case 'method_definition': {
      const nameChild = node.childForFieldName('name');
      return nameChild?.text ?? '';
    }
    case 'variable_declarator':
    case 'constant_declarator': {
      const nameChild = node.childForFieldName('name');
      return nameChild?.text ?? '';
    }
    case 'module_declaration': {
      const nameChild = node.childForFieldName('name');
      return nameChild?.text ?? 'module';
    }
    default:
      return '';
  }
}

function buildQualifiedName(name: string, classContext?: string): string {
  if (classContext) {
    return `${classContext}::${name}`;
  }
  return name;
}

function generateNodeId(filePath: string, kind: NodeKind, name: string, startLine: number): string {
  return `file:${filePath}::${kind}::${name}::${startLine}`;
}

function traverseForSymbols(
  node: SyntaxNode,
  content: string,
  classContext?: string
): SymbolDefinition[] {
  const symbols: SymbolDefinition[] = [];
  const nodeType = node.type;
  const kind = getSymbolKind(nodeType);
  let symbolName: string | undefined;

  if (kind && kind !== 'import') {
    symbolName = extractSymbolName(node, nodeType);
    if (symbolName && !symbolName.startsWith('_')) {
      const qualifiedName = buildQualifiedName(symbolName, classContext);
      symbols.push({
        node,
        name: symbolName,
        qualifiedName,
        kind,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        isExported: isExported(node),
        classContext,
      });

      if (kind === 'class') {
        const body = node.childForFieldName('body') ?? node.childForFieldName('declaration');
        if (body) {
          for (const child of body.children) {
            if (child.type === 'method_definition' || child.type === 'function_declaration') {
              const methodName = extractSymbolName(child, child.type);
              if (methodName) {
                symbols.push({
                  node: child,
                  name: methodName,
                  qualifiedName: buildQualifiedName(methodName, symbolName),
                  kind: child.type === 'method_definition' ? 'method' : 'function',
                  startLine: child.startPosition.row + 1,
                  endLine: child.endPosition.row + 1,
                  isExported: isExported(child),
                  classContext: symbolName,
                });
              }
            }
          }
        }
      }
    }
  }

  const childContext = kind === 'class' ? symbolName : classContext;
  for (const child of node.children) {
    if (child.type !== 'import_statement' && child.type !== 'export_statement') {
      symbols.push(...traverseForSymbols(child, content, childContext));
    }
  }

  return symbols;
}

function extractCallEdges(
  nodes: SymbolDefinition[],
  tree: Tree,
  content: string,
  language: Language
): Edge[] {
  const edges: Edge[] = [];

  const rootNode = tree.rootNode;

  function findCalls(node: SyntaxNode): void {
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode?.type === 'identifier') {
        const funcName = funcNode.text;
        const line = node.startPosition.row + 1;

        for (const sym of nodes) {
          if (sym.name === funcName && sym.startLine <= line && sym.endLine >= line) {
            edges.push({
              source: sym.qualifiedName,
              target: funcName,
              kind: 'calls',
              line,
            });
            break;
          }
        }
      }
    }

    for (const child of node.children) {
      findCalls(child);
    }
  }

  findCalls(rootNode);
  return edges;
}

function extractImportEdges(
  nodes: SymbolDefinition[],
  tree: Tree,
  content: string
): Edge[] {
  const edges: Edge[] = [];
  const rootNode = tree.rootNode;

  function findImports(node: SyntaxNode): void {
    if (node.type === 'import_statement' || node.type === 'import_clause') {
      const line = node.startPosition.row + 1;
      for (const sym of nodes) {
        if (sym.kind === 'function' && sym.startLine <= line && sym.endLine >= line) {
          const specifiers: string[] = [];
          node.children.forEach(child => {
            if (child.type === 'import_specifier') {
              const nameChild = child.childForFieldName('name');
              if (nameChild) specifiers.push(nameChild.text);
            }
          });

          for (const spec of specifiers) {
            edges.push({
              source: sym.qualifiedName,
              target: spec,
              kind: 'imports',
              line,
            });
          }
        }
      }
    }

    for (const child of node.children) {
      findImports(child);
    }
  }

  findImports(rootNode);
  return edges;
}

export class TreeSitterExtractor {
  private config: ExtractorConfig;

  constructor(config: ExtractorConfig = {}) {
    this.config = config;
  }

  async parseFile(filePath: string): Promise<Tree> {
    const language = getLanguageFromFilePath(filePath);
    const parser = await getParser(language);

    const { readFile } = await import('fs/promises');
    const content = await readFile(filePath, 'utf-8');

    return parser.parse(content);
  }

  extractSymbols(filePath: string, tree: Tree, language: string): Node[] {
    const rootNode = tree.rootNode;
    const content = getNodeText(rootNode, '');
    const lang = language as Language;

    const definitions = traverseForSymbols(rootNode, content);
    const uniqueSymbols = new Map<string, SymbolDefinition>();

    for (const def of definitions) {
      if (!uniqueSymbols.has(def.qualifiedName)) {
        uniqueSymbols.set(def.qualifiedName, def);
      }
    }

    const nodes: Node[] = [];
    for (const [, def] of uniqueSymbols) {
      nodes.push({
        id: generateNodeId(filePath, def.kind, def.name, def.startLine),
        qualifiedName: def.qualifiedName,
        kind: def.kind,
        filePath,
        name: def.name,
        startLine: def.startLine,
        endLine: def.endLine,
        startColumn: def.node.startPosition.column,
        endColumn: def.node.endPosition.column,
        isExported: def.isExported,
        language: lang,
        updatedAt: Date.now(),
      });
    }

    return nodes;
  }

  extractEdges(nodes: Node[], tree: Tree, language: string): Edge[] {
    const lang = language as Language;
    const content = getNodeText(tree.rootNode, '');

    const symbolDefs: SymbolDefinition[] = nodes.map(n => ({
      node: tree.rootNode,
      name: n.name,
      qualifiedName: n.qualifiedName,
      kind: n.kind,
      startLine: n.startLine,
      endLine: n.endLine,
      isExported: n.isExported ?? false,
    }));

    const edges: Edge[] = [];

    if (this.config.includeCalls !== false) {
      edges.push(...extractCallEdges(symbolDefs, tree, content, lang));
    }

    if (this.config.includeImports !== false) {
      edges.push(...extractImportEdges(symbolDefs, tree, content));
    }

    return edges;
  }

  async extractGraph(filePath: string): Promise<{ nodes: Node[]; edges: Edge[] }> {
    const tree = await this.parseFile(filePath);
    const language = getLanguageFromFilePath(filePath);
    const nodes = this.extractSymbols(filePath, tree, language);
    const nodeIdMap = new Map<string, string>();
    nodes.forEach(n => nodeIdMap.set(n.qualifiedName, n.id));

    const rawEdges = this.extractEdges(nodes, tree, language);
    const edges: Edge[] = rawEdges.map(e => ({
      source: nodeIdMap.get(e.source) ?? e.source,
      target: nodeIdMap.get(e.target) ?? e.target,
      kind: e.kind,
      line: e.line,
    }));

    return { nodes, edges };
  }
}

export const defaultExtractor = new TreeSitterExtractor();
