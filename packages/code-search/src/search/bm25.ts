export interface BM25Config {
  k1: number;
  b: number;
  avgDocLength: number;
}

const DEFAULT_CONFIG: BM25Config = {
  k1: 1.5,
  b: 0.75,
  avgDocLength: 500,
};

export class BM25 {
  private config: BM25Config;
  private idf: Map<string, number> = new Map();
  private docLengths: number[] = [];
  private documents: string[] = [];
  private docCount: number = 0;

  constructor(config: Partial<BM25Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  index(documents: string[]): void {
    this.documents = documents;
    this.docCount = documents.length;
    this.docLengths = documents.map(doc => this.tokenize(doc).length);

    const termDocFreq = new Map<string, number>();
    for (const doc of documents) {
      const terms = new Set(this.tokenize(doc));
      for (const term of terms) {
        termDocFreq.set(term, (termDocFreq.get(term) ?? 0) + 1);
      }
    }

    this.idf.clear();
    for (const [term, df] of termDocFreq) {
      const idf = Math.log((this.docCount - df + 0.5) / (df + 0.5) + 1);
      this.idf.set(term, Math.max(0, idf));
    }

    const totalLen = this.docLengths.reduce((a, b) => a + b, 0);
    this.config.avgDocLength = totalLen / this.docCount;
  }

  search(query: string, limit: number = 10): Array<{ index: number; score: number }> {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];

    const scores: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < this.documents.length; i++) {
      const doc = this.documents[i];
      if (!doc) continue;
      const docTerms = this.tokenize(doc);
      const docLen = this.docLengths[i] ?? 0;

      let score = 0;
      const termFreq = new Map<string, number>();
      for (const term of docTerms) {
        termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      }

      for (const term of queryTerms) {
        const tf = termFreq.get(term) ?? 0;
        if (tf === 0) continue;

        const idf = this.idf.get(term) ?? 0;
        const numerator = tf * (this.config.k1 + 1);
        const denominator = tf + this.config.k1 * (1 - this.config.b + this.config.b * (docLen / (this.config.avgDocLength || 1)));
        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        scores.push({ index: i, score });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s_]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
      .filter(t => !STOP_WORDS.has(t));
  }
}

const STOP_WORDS = new Set([
  'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she',
  'we', 'they', 'what', 'which', 'who', 'whom', 'whose', 'where', 'when',
  'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'if', 'then', 'else', 'while', 'although',
  'because', 'since', 'until', 'unless', 'though', 'before', 'after', 'about',
  'into', 'through', 'during', 'above', 'below', 'between', 'under', 'again',
  'further', 'once', 'function', 'class', 'const', 'let', 'var', 'export',
  'import', 'default', 'async', 'await', 'return', 'static', 'public', 'private',
  'protected', 'interface', 'type', 'extends', 'implements', 'new', 'try',
  'catch', 'throw', 'finally', 'null', 'undefined', 'true', 'false',
]);
