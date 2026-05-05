/**
 * Grep/regex search for code.
 * Provides deterministic, syntactic regex matching over indexed code chunks.
 * Does NOT use semantic understanding — purely syntactic pattern matching.
 */

/**
 * Result of a single regex match in a file.
 */
export interface RegexResult {
  /** Absolute file path where the match was found */
  filePath: string;
  /** Line number where the match starts (1-indexed) */
  line: number;
  /** Column number where the match starts (0-indexed) */
  column: number;
  /** The full regex match text */
  match: string;
  /** Captured groups from the regex (if any) */
  groups?: string[];
  /** Lines of context around the match (line before, match line, line after) */
  context: string[];
  /** The chunk ID where the match was found (if from chunked content) */
  chunkId?: string;
}

/**
 * Options for regex search.
 */
export interface RegexSearchOptions {
  /** Maximum number of results to return. Default: 100 */
  limit?: number;
  /** Number of context lines before/after match to include. Default: 2 */
  contextLines?: number;
  /** Optional file path filter (glob pattern or literal path) */
  filePath?: string;
  /** Optional language filter */
  language?: string;
  /** If true, match is case-sensitive. Default: false */
  caseSensitive?: boolean;
  /** If true, multiline mode (^ matches line start, $ matches line end). Default: true */
  multiline?: boolean;
}

/**
 * Internal chunk representation for regex searching.
 */
interface ChunkForSearch {
  id: string;
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language?: string;
}

/**
 * Default options for regex search.
 */
const DEFAULT_OPTIONS: Required<RegexSearchOptions> = {
  limit: 100,
  contextLines: 2,
  filePath: '',
  language: '',
  caseSensitive: false,
  multiline: true,
};

/**
 * Checks if a regex pattern is valid.
 * @param pattern - The regex pattern string
 * @returns true if valid, false otherwise
 */
export function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * RegexSearcher provides deterministic, syntactic regex matching over code.
 * 
 * Key characteristics:
 * - Deterministic: same pattern always returns same results
 * - Purely syntactic: no semantic/fuzzy matching
 * - Graceful invalid regex handling: returns empty array, never throws
 */
export class RegexSearcher {
  /**
   * Search for a regex pattern across chunks and return all matches.
   * 
   * @param pattern - The regex pattern string
   * @param chunks - The chunks to search (from database or file content)
   * @param options - Search options
   * @returns Promise resolving to array of RegexResult matches
   */
  async searchRegex(
    pattern: string,
    chunks: ChunkForSearch[],
    options: RegexSearchOptions = {}
  ): Promise<RegexResult[]> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    
    // Handle empty pattern
    if (!pattern || !pattern.trim()) {
      return [];
    }
    
    // Validate and compile regex
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, opts.caseSensitive ? 'gm' : 'gim');
    } catch {
      // Invalid regex: return empty results gracefully
      return [];
    }
    
const results: RegexResult[] = [];
      
      for (const chunk of chunks) {
        if (opts.filePath && !this.matchesPathFilter(chunk.filePath, opts.filePath)) {
          continue;
        }
        if (opts.language && chunk.language && chunk.language !== opts.language) {
          continue;
        }
        
        const lines = chunk.content.split('\n');
        const contentWithNewlines = chunk.content;
        
        regex.lastIndex = 0;
        
        let match: RegExpExecArray | null;
        match = regex.exec(contentWithNewlines);
        while (match !== null) {
          const matchIndex = match.index;
          const pos = this.getLineAndColumn(contentWithNewlines, matchIndex);
          
          const context = this.buildContext(lines, pos.line, opts.contextLines);
          const chunkRelativeLine = pos.line - chunk.startLine + 1;
          
          results.push({
            filePath: chunk.filePath,
            line: chunkRelativeLine,
            column: pos.column,
            match: match[0],
            groups: match.slice(1).filter((g): g is string => g !== undefined),
            context,
            chunkId: chunk.id,
          });
          
          if (match[0].length === 0) {
            regex.lastIndex++;
          }
          
          if (results.length >= opts.limit) {
            return results;
          }
          
          match = regex.exec(contentWithNewlines);
        }
      }
    
    return results;
  }
  
  /**
   * Search regex directly over raw file content (not chunked).
   * Useful for grep-like behavior on individual files.
   */
  async searchRegexInContent(
    pattern: string,
    content: string,
    filePath: string,
    options: RegexSearchOptions = {}
  ): Promise<RegexResult[]> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    
    if (!pattern || !pattern.trim()) {
      return [];
    }
    
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, opts.caseSensitive ? 'gm' : 'gim');
    } catch {
      return [];
    }
    
    const results: RegexResult[] = [];
    const lines = content.split('\n');
    
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    
    match = regex.exec(content);
    while (match !== null) {
      const matchIndex = match.index;
      const pos = this.getLineAndColumn(content, matchIndex);
      
      const context = this.buildContext(lines, pos.line, opts.contextLines);
      
      results.push({
        filePath,
        line: pos.line,
        column: pos.column,
        match: match[0],
        groups: match.slice(1).filter((g): g is string => g !== undefined),
        context,
      });
      
      if (match[0].length === 0) {
        regex.lastIndex++;
      }
      
      if (results.length >= opts.limit) {
        break;
      }
      
      match = regex.exec(content);
    }
    
    return results;
  }
  
  private getLineAndColumn(
    content: string,
    index: number
  ): { line: number; column: number; lineStartIndex: number } {
    let line = 1;
    let lineStartIndex = 0;
    
    for (let i = 0; i < index; i++) {
      if (content[i] === '\n') {
        line++;
        lineStartIndex = i + 1;
      }
    }
    
    const column = index - lineStartIndex;
    return { line, column, lineStartIndex };
  }
  
  /**
   * Build context lines around a specific line number.
   */
  private buildContext(lines: string[], targetLine: number, contextLines: number): string[] {
    const start = Math.max(0, targetLine - contextLines - 1);
    const end = Math.min(lines.length, targetLine + contextLines);
    
    return lines.slice(start, end);
  }
  
  /**
   * Check if a file path matches a filter (supports glob-like patterns).
   */
  private matchesPathFilter(filePath: string, filter: string): boolean {
    // Simple glob matching for * wildcards
    if (filter.includes('*')) {
      const regex = new RegExp(
        '^' + filter.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
        'i'
      );
      return regex.test(filePath);
    }
    // Literal path match (case-insensitive)
    return filePath.toLowerCase().includes(filter.toLowerCase());
  }
}

/**
 * Standalone function for simple regex searches.
 * Convenience wrapper around RegexSearcher.
 */
export async function searchRegex(
  pattern: string,
  chunks: ChunkForSearch[],
  options?: RegexSearchOptions
): Promise<RegexResult[]> {
  const searcher = new RegexSearcher();
  return searcher.searchRegex(pattern, chunks, options);
}
