/**
 * CodeGraph Type Definitions
 *
 * Core types for the semantic knowledge graph system.
 */

export type NodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'protocol'
  | 'function'
  | 'method'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'namespace'
  | 'parameter'
  | 'import'
  | 'export'
  | 'route'
  | 'component';

export type EdgeKind =
  | 'contains'
  | 'calls'
  | 'imports'
  | 'exports'
  | 'extends'
  | 'implements'
  | 'references'
  | 'type_of'
  | 'returns'
  | 'instantiates'
  | 'overrides'
  | 'decorates'
  | 'uses_type';

export type Language =
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'dart'
  | 'svelte'
  | 'liquid'
  | 'pascal'
  | 'unknown';

export interface Node {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: Language;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docstring?: string;
  signature?: string;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  updatedAt: number;
}

export interface Edge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
  line?: number;
  column?: number;
  provenance?: 'tree-sitter' | 'scip' | 'heuristic';
}

export interface FileRecord {
  path: string;
  contentHash: string;
  language: Language;
  size: number;
  modifiedAt: number;
  indexedAt: number;
  nodeCount: number;
  errors?: ExtractionError[];
}

export interface ExtractionResult {
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionError[];
  durationMs: number;
}

export interface ExtractionError {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
  code?: string;
}

export interface UnresolvedReference {
  fromNodeId: string;
  referenceName: string;
  referenceKind: EdgeKind;
  line: number;
  column: number;
  filePath?: string;
  language?: Language;
  candidates?: string[];
}

export interface Subgraph {
  nodes: Map<string, Node>;
  edges: Edge[];
  roots: string[];
}

export interface TraversalOptions {
  maxDepth?: number;
  edgeKinds?: EdgeKind[];
  nodeKinds?: NodeKind[];
  direction?: 'outgoing' | 'incoming' | 'both';
  limit?: number;
  includeStart?: boolean;
}

export interface SearchOptions {
  kinds?: NodeKind[];
  languages?: Language[];
  includePatterns?: string[];
  excludePatterns?: string[];
  limit?: number;
  offset?: number;
  caseSensitive?: boolean;
}

export interface SearchResult {
  node: Node;
  score: number;
  highlights?: string[];
}

export interface Context {
  focal: Node;
  ancestors: Node[];
  children: Node[];
  incomingRefs: Array<{ node: Node; edge: Edge }>;
  outgoingRefs: Array<{ node: Node; edge: Edge }>;
  types: Node[];
  imports: Node[];
}

export interface CodeBlock {
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: Language;
  node?: Node;
}

export interface FrameworkHint {
  name: string;
  version?: string;
  patterns?: {
    components?: string[];
    routes?: string[];
    models?: string[];
  };
}

export interface CodeGraphConfig {
  version: number;
  rootDir: string;
  include: string[];
  exclude: string[];
  languages: Language[];
  frameworks: FrameworkHint[];
  maxFileSize: number;
  extractDocstrings: boolean;
  trackCallSites: boolean;
  customPatterns?: {
    name: string;
    pattern: string;
    kind: NodeKind;
  }[];
}

export interface SchemaVersion {
  version: number;
  appliedAt: number;
  description?: string;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  nodesByKind: Record<NodeKind, number>;
  edgesByKind: Record<EdgeKind, number>;
  filesByLanguage: Record<Language, number>;
  dbSizeBytes: number;
  lastUpdated: number;
}

export type TaskInput = string | { title: string; description?: string };

export interface BuildContextOptions {
  maxNodes?: number;
  maxCodeBlocks?: number;
  maxCodeBlockSize?: number;
  includeCode?: boolean;
  format?: 'markdown' | 'json';
  searchLimit?: number;
  traversalDepth?: number;
  minScore?: number;
}

export interface TaskContext {
  query: string;
  subgraph: Subgraph;
  entryPoints: Node[];
  codeBlocks: CodeBlock[];
  relatedFiles: string[];
  summary: string;
  stats: {
    nodeCount: number;
    edgeCount: number;
    fileCount: number;
    codeBlockCount: number;
    totalCodeSize: number;
  };
}

export interface FindRelevantContextOptions {
  searchLimit?: number;
  traversalDepth?: number;
  maxNodes?: number;
  minScore?: number;
  edgeKinds?: EdgeKind[];
  nodeKinds?: NodeKind[];
}
