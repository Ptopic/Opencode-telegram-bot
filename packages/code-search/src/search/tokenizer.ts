/**
 * Code-Aware Tokenizer
 *
 * Splits camelCase, PascalCase, snake_case, SCREAMING_SNAKE, and dotted paths
 * so BM25 can match sub-identifiers. Keeps the original token (lowercased) for
 * exact matching.
 */

export const STOP_WORDS: Set<string> = new Set([
  'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'it', 'its', 'this',
  'that', 'these', 'those', 'not', 'null', 'undefined', 'true', 'false',
  'function', 'class', 'const', 'let', 'var', 'export', 'import', 'default',
  'async', 'await', 'return', 'static', 'public', 'private', 'protected',
  'interface', 'type', 'extends', 'implements', 'new', 'try', 'catch',
  'throw', 'finally',
]);

/**
 * Tokenize code text into sub-identifiers for BM25 matching.
 *
 * Examples:
 *   getUserName      → ['getusername', 'get', 'user', 'name']
 *   ReactComponent   → ['reactcomponent', 'react', 'component']
 *   MAX_RETRY_COUNT  → ['max_retry_count', 'max', 'retry', 'count']
 *   React.useState   → ['react.usestate', 'react', 'usestate', 'use', 'state']
 */
export function tokenizeCode(text: string): string[] {
  const tokens = new Set<string>();

  const rawTokens = text
    .replace(/[^\w.]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);

  for (const raw of rawTokens) {
    tokens.add(raw.toLowerCase());

    const dotParts = raw.split('.');

    for (const dotPart of dotParts) {
      if (!dotPart) continue;
      tokens.add(dotPart.toLowerCase());

      // camelCase / PascalCase boundary split: getUserName → get·User·Name
      const camelParts = dotPart
        .replace(/([a-z\d])([A-Z])/g, '$1\x00$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\x00$2')
        .split('\x00');

      for (const camelPart of camelParts) {
        if (!camelPart) continue;
        tokens.add(camelPart.toLowerCase());

        // snake_case / SCREAMING_SNAKE split
        for (const underPart of camelPart.split('_')) {
          if (!underPart) continue;
          tokens.add(underPart.toLowerCase());
        }
      }
    }
  }

  return Array.from(tokens).filter(t => t.length > 1 && !STOP_WORDS.has(t));
}
