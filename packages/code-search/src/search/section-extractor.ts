import { Parser, Language, Node as SyntaxNode } from 'web-tree-sitter';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeSection {
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  content: string; // Full source of the section
  type: 'function' | 'class' | 'method' | 'module';
  name: string; // Function/class name, or 'anonymous'
}

// ---------------------------------------------------------------------------
// Extension → tree-sitter language name
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
};

// ---------------------------------------------------------------------------
// Language → WASM file name inside tree-sitter-wasms/out/
// ---------------------------------------------------------------------------

const LANG_TO_WASM: Record<string, string> = {
  javascript: 'tree-sitter-javascript',
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-tsx',
  python: 'tree-sitter-python',
  rust: 'tree-sitter-rust',
  go: 'tree-sitter-go',
  java: 'tree-sitter-java',
};

// ---------------------------------------------------------------------------
// Language-specific section node types
// ---------------------------------------------------------------------------

const LANG_SECTION_TYPES: Record<string, ReadonlySet<string>> = {
  javascript: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'class_declaration',
    'class_expression',
  ]),
  typescript: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
  ]),
  tsx: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'class_declaration',
  ]),
  python: new Set([
    'function_definition', // def foo():
    'class_definition', // class Foo:
  ]),
  rust: new Set([
    'function_item', // fn foo()
    'impl_item', // impl Type { }
    'struct_item', // struct Foo
    'enum_item', // enum Bar
    'trait_item', // trait Baz
  ]),
  go: new Set([
    'function_declaration', // func foo()
    'method_declaration', // func (t T) foo()
    'type_declaration', // type Foo struct
  ]),
  java: new Set([
    'class_declaration',
    'method_declaration',
    'constructor_declaration',
    'interface_declaration',
  ]),
};

// ---------------------------------------------------------------------------
// Name-extraction node types (child node types that carry the identifier)
// ---------------------------------------------------------------------------

const NAME_NODE_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'name',
  'property_identifier',
  'type_identifier',
]);

// ---------------------------------------------------------------------------
// Package root for WASM path resolution
// ---------------------------------------------------------------------------

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// SectionExtractor
// ---------------------------------------------------------------------------

export class SectionExtractor {
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private readonly languages: Map<string, Language> = new Map();
  private readonly loadingLanguages: Map<string, Promise<Language | null>> =
    new Map();

  // -----------------------------------------------------------------------
  // Lazy async init (Parser.init is expensive)
  // -----------------------------------------------------------------------

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = Parser.init();
    await this.initPromise;
    this.initialized = true;
  }

  // -----------------------------------------------------------------------
  // Load a language grammar (cached)
  // -----------------------------------------------------------------------

  private async loadLanguage(langName: string): Promise<Language | null> {
    const cached = this.languages.get(langName);
    if (cached) return cached;

    const inFlight = this.loadingLanguages.get(langName);
    if (inFlight) return inFlight;

    const loadPromise = this.doLoadLanguage(langName);
    this.loadingLanguages.set(langName, loadPromise);

    try {
      const lang = await loadPromise;
      if (lang) this.languages.set(langName, lang);
      return lang;
    } finally {
      this.loadingLanguages.delete(langName);
    }
  }

  private async doLoadLanguage(langName: string): Promise<Language | null> {
    const wasmBaseName = LANG_TO_WASM[langName];
    if (!wasmBaseName) return null;

    try {
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve(
        `tree-sitter-wasms/out/${wasmBaseName}.wasm`,
      );
      return await Language.load(wasmPath);
    } catch {
      try {
        const wasmPath = join(
          PKG_ROOT,
          'node_modules',
          'tree-sitter-wasms',
          'out',
          `${wasmBaseName}.wasm`,
        );
        return await Language.load(wasmPath);
      } catch {
        return null;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Find the containing function/class for a given line number.
   *
   * @param filePath  - Absolute or relative path to the source file
   * @param lineNumber - 1-indexed line number
   * @param content   - Optional file content (avoids disk read)
   * @returns The innermost containing CodeSection, or null if at module scope
   */
  async extractContainingSection(
    filePath: string,
    lineNumber: number,
    content?: string,
  ): Promise<CodeSection | null> {
    const ext = extname(filePath);
    const langName = EXT_TO_LANG[ext];
    if (!langName) return null;

    await this.ensureInit();

    const lang = await this.loadLanguage(langName);
    if (!lang) return null;

    const source = content ?? (await this.readFileContent(filePath));
    if (!source) return null;

    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    if (!tree) return null;

    try {
      const sectionTypes = LANG_SECTION_TYPES[langName];
      if (!sectionTypes) return null;

      const node = this.findContainingNode(
        tree.rootNode,
        lineNumber,
        sectionTypes,
      );
      if (!node) return null;

      return this.nodeToSection(node, source);
    } finally {
      tree.delete();
    }
  }

  // -----------------------------------------------------------------------
  // AST walk: find deepest section-type node containing the target line
  // -----------------------------------------------------------------------

  private findContainingNode(
    root: SyntaxNode,
    targetLine: number,
    sectionTypes: ReadonlySet<string>,
  ): SyntaxNode | null {
    return this.walkForSection(root, targetLine, sectionTypes);
  }

  private walkForSection(
    node: SyntaxNode,
    targetLine: number,
    sectionTypes: ReadonlySet<string>,
  ): SyntaxNode | null {
    const children = node.children;
    let bestMatch: SyntaxNode | null = null;

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;

      // Convert 0-indexed tree rows to 1-indexed lines
      const childStartLine = child.startPosition.row + 1;
      const childEndLine = child.endPosition.row + 1;

      // Skip children that don't contain the target line
      if (targetLine < childStartLine || targetLine > childEndLine) {
        continue;
      }

      // Target line is within this child – recurse deeper
      const deeper = this.walkForSection(child, targetLine, sectionTypes);

      if (deeper) {
        // Found a more specific containing section deeper in the tree
        return deeper;
      }

      // No deeper match – is this child itself a section type?
      if (sectionTypes.has(child.type)) {
        // This is the most specific section containing the line
        return child;
      }

      // Child contains the line but isn't a section type.
      // Continue checking siblings – but also remember this child
      // as a container we need to search within more carefully.
      // Since we already recursed and found nothing, there's no
      // section-type descendant. Keep looking at siblings.
      if (!bestMatch) {
        bestMatch = child;
      }
    }

    // No child contained the target line in a section type
    return null;
  }

  // -----------------------------------------------------------------------
  // Convert AST node → CodeSection
  // -----------------------------------------------------------------------

  private nodeToSection(node: SyntaxNode, source: string): CodeSection {
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    // Extract the source lines for this section
    const lines = source.split('\n');
    const sectionLines = lines.slice(startLine - 1, endLine);
    const content = sectionLines.join('\n');

    return {
      startLine,
      endLine,
      content,
      type: this.classifyType(node.type),
      name: this.extractName(node),
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private extractName(node: SyntaxNode): string {
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (NAME_NODE_TYPES.has(child.type)) {
        return child.text;
      }
    }
    // For some languages the name is a named child with field name "name"
    const nameChild = node.childForFieldName('name');
    if (nameChild) {
      return nameChild.text;
    }
    return 'anonymous';
  }

  private classifyType(
    nodeType: string,
  ): 'function' | 'class' | 'method' | 'module' {
    if (nodeType.includes('class') || nodeType === 'struct_item' || nodeType === 'enum_item' || nodeType === 'trait_item' || nodeType === 'interface_declaration' || nodeType === 'type_declaration') {
      return 'class';
    }
    if (nodeType.includes('method') || nodeType === 'constructor_declaration') {
      return 'method';
    }
    // impl_item in Rust contains methods but is itself a class-like container
    if (nodeType === 'impl_item') {
      return 'class';
    }
    return 'function';
  }

  private async readFileContent(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return '';
    }
  }
}
