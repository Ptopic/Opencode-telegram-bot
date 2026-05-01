/**
 * Exact and fuzzy string search for code.
 * Handles:
 * - Quoted strings: "console.log", 'fetch', `template`
 * - JSX fragments: {transcriptArticleUrl && ( ... )}
 * - Code patterns: function names, class names, CSS selectors
 * - Substring/fuzzy matches when exact doesn't hit
 */

export interface ExactSearchResult {
  chunkId: string;
  score: number;
  matchType: 'exact' | 'substring' | 'fuzzy' | 'pattern';
  matchedText: string;
  offset: number;
}

export interface ExactSearchOptions {
  /** Require all terms to match (AND), or any (OR). Default: AND */
  matchAllTerms?: boolean;
  /** Minimum score threshold [0-1]. Default: 0.3 */
  threshold?: number;
  /** Max results to return. Default: 20 */
  limit?: number;
  /** Enable fuzzy matching. Default: true */
  fuzzy?: boolean;
  /** Fuzzy threshold (0-1). Default: 0.7 */
  fuzzyThreshold?: number;
}

interface ChunkWithId {
  id: string;
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * Detect what kind of search pattern the query looks like
 */
function detectPattern(query: string): {
  type: 'exact-quoted' | 'jsx-fragment' | 'code-statement' | 'plain';
  normalizedQuery: string;
  terms: string[];
} {
  const trimmed = query.trim();

  // Quoted string (single, double, or backtick)
  const quoteMatch = trimmed.match(/^(['"`])(.+)\1$/);
  if (quoteMatch && quoteMatch[1] && quoteMatch[2]) {
    return {
      type: 'exact-quoted',
      normalizedQuery: quoteMatch[2],
      terms: [quoteMatch[2].toLowerCase()],
    };
  }

  // JSX/TSX fragment — contains { or < or />
  if (/[{}<\/>]/.test(trimmed) || trimmed.startsWith('(') || trimmed.startsWith('&&')) {
    return {
      type: 'jsx-fragment',
      normalizedQuery: trimmed,
      terms: extractTerms(trimmed),
    };
  }

  // Looks like a code statement (function call, assignment, etc.)
  if (/[.\(\)]/.test(trimmed) || /^\w+\s*\(/.test(trimmed)) {
    return {
      type: 'code-statement',
      normalizedQuery: trimmed,
      terms: extractTerms(trimmed),
    };
  }

  return {
    type: 'plain',
    normalizedQuery: trimmed,
    terms: extractTerms(trimmed),
  };
}

function extractTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([^\w])/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * Check if haystack contains needle as substring (case-insensitive)
 */
function containsSubstring(haystack: string, needle: string): { found: boolean; offset: number } {
  const lower = haystack.toLowerCase();
  const idx = lower.indexOf(needle.toLowerCase());
  return { found: idx !== -1, offset: idx };
}

/**
 * Simple fuzzy match using Levenshtein distance
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0]![j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      const up = matrix[i - 1]?.[j] ?? Infinity;
      const left = matrix[i]?.[j - 1] ?? Infinity;
      const diag = matrix[i - 1]?.[j - 1] ?? Infinity;
      matrix[i]![j] = Math.min(up + 1, left + 1, diag + cost);
    }
  }
  return matrix[b.length]![a.length]!;
}

function fuzzyScore(needle: string, haystack: string): number {
  const distance = levenshtein(needle, haystack.toLowerCase());
  const maxLen = Math.max(needle.length, haystack.length);
  return maxLen === 0 ? 0 : 1 - distance / maxLen;
}

/**
 * Find exact quoted string matches within code content
 * e.g. searching for "Test" finds console.log("Test")
 */
function findQuotedMatches(
  content: string,
  query: string
): Array<{ offset: number; matchedText: string; score: number }> {
  const results: Array<{ offset: number; matchedText: string; score: number }> = [];

  // Match strings in code: "..." or '...' or `...`
  const stringLiteralRegex = /(['"`])(?:(?!\1)[^\\]|\\.)*\1/g;
  let match: RegExpExecArray | null;

  while ((match = stringLiteralRegex.exec(content)) !== null) {
    const stringContent = match[0].slice(1, -1); // remove quotes
    const { found, offset } = containsSubstring(stringContent, query);

    if (found) {
      const relevanceScore = query.length / stringContent.length;
      results.push({
        offset: match.index + 1, // +1 to account for opening quote
        matchedText: match[0],
        score: Math.min(1, relevanceScore + 0.5), // exact quoted match bonus
      });
    }
  }

  return results;
}

/**
 * Main exact search function.
 * Searches chunks for exact substring, quoted string, and fuzzy matches.
 */
export function exactSearch(
  query: string,
  chunks: ChunkWithId[],
  options: ExactSearchOptions = {}
): ExactSearchResult[] {
  const {
    matchAllTerms = true,
    threshold = 0.3,
    limit = 20,
    fuzzy = true,
    fuzzyThreshold = 0.7,
  } = options;

  if (!query.trim() || chunks.length === 0) return [];

  const pattern = detectPattern(query);
  const results: ExactSearchResult[] = [];

  for (const chunk of chunks) {
    const content = chunk.content;
    let bestScore = 0;
    let bestMatchType: ExactSearchResult['matchType'] = 'exact';
    let bestMatchedText = '';
    let bestOffset = 0;

    switch (pattern.type) {
      case 'exact-quoted': {
        // Look for the quoted string inside the chunk
        const quotedMatches = findQuotedMatches(content, pattern.normalizedQuery);
        if (quotedMatches.length > 0) {
          const best = quotedMatches.reduce((a, b) => (a.score > b.score ? a : b));
          bestScore = best.score;
          bestMatchedText = best.matchedText;
          bestOffset = best.offset;
          bestMatchType = 'exact';
        } else {
          // Fall back to substring in full content
          const { found, offset } = containsSubstring(content, pattern.normalizedQuery);
          if (found) {
            bestScore = Math.min(1, pattern.normalizedQuery.length / content.length + 0.4);
            bestMatchedText = content.substring(offset, offset + pattern.normalizedQuery.length);
            bestOffset = offset;
            bestMatchType = 'substring';
          }
        }
        break;
      }

      case 'jsx-fragment':
      case 'code-statement': {
        // For JSX/code, try exact substring first
        const { found, offset } = containsSubstring(content, pattern.normalizedQuery);
        if (found) {
          bestScore = Math.min(1, pattern.normalizedQuery.length / content.length + 0.4);
          bestMatchedText = content.substring(offset, offset + Math.min(100, pattern.normalizedQuery.length));
          bestOffset = offset;
          bestMatchType = 'exact';
        } else {
          // Try matching key terms individually
          const matchedTerms: string[] = [];
          for (const term of pattern.terms) {
            const termInContent = containsSubstring(content, term);
            if (termInContent.found) {
              matchedTerms.push(term);
            }
          }
          const matchRatio = matchedTerms.length / pattern.terms.length;
          if (matchRatio >= threshold) {
            bestScore = matchRatio * 0.8;
            bestMatchedText = matchedTerms.join(', ');
            bestOffset = 0;
            bestMatchType = 'pattern';
          }
        }
        break;
      }

      case 'plain':
      default: {
        // Plain text: try substring first, then term-by-term
        const { found, offset } = containsSubstring(content, pattern.normalizedQuery);
        if (found) {
          bestScore = Math.min(1, pattern.normalizedQuery.length / content.length + 0.4);
          bestMatchedText = content.substring(offset, offset + Math.min(80, pattern.normalizedQuery.length));
          bestOffset = offset;
          bestMatchType = 'exact';
        } else {
          // Term-by-term matching
          const matchedTerms: string[] = [];
          for (const term of pattern.terms) {
            const termInContent = containsSubstring(content, term);
            if (termInContent.found) {
              matchedTerms.push(term);
            } else if (fuzzy) {
              // Fuzzy fallback: check if any word in content fuzzy-matches this term
              const words = content.toLowerCase().split(/\s+/);
              for (const word of words) {
                if (word.length < 3) continue;
                const score = fuzzyScore(term, word);
                if (score >= fuzzyThreshold) {
                  matchedTerms.push(term);
                  break;
                }
              }
            }
          }

          if (matchAllTerms) {
            if (matchedTerms.length === pattern.terms.length) {
              bestScore = 0.7;
              bestMatchedText = matchedTerms.join(', ');
              bestOffset = 0;
              bestMatchType = 'fuzzy';
            }
          } else {
            const matchRatio = matchedTerms.length / pattern.terms.length;
            if (matchRatio >= threshold) {
              bestScore = matchRatio * 0.6;
              bestMatchedText = matchedTerms.join(', ');
              bestOffset = 0;
              bestMatchType = 'fuzzy';
            }
          }
        }
        break;
      }
    }

    if (bestScore >= threshold) {
      results.push({
        chunkId: chunk.id,
        score: bestScore,
        matchType: bestMatchType,
        matchedText: bestMatchedText,
        offset: bestOffset,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}
