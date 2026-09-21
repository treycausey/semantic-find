export type OutputFormat = "human" | "json";

export type EvidenceType = "direct" | "supporting" | "background" | "unknown";

export type ResultSource =
  | "local-lexical"
  | "semantic"
  | "local-lexical-fallback";

export interface SearchOptions {
  readonly query: string;
  readonly roots: readonly string[];
  readonly includeSource: boolean;
  readonly semantic: boolean;
  readonly semanticAll: boolean;
  readonly format: OutputFormat;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  readonly maxChunks: number;
  readonly maxResults: number;
  readonly semanticCandidates: number;
  readonly maxChunkLines: number;
  readonly maxChunkChars: number;
  readonly timeoutMs: number;
  readonly apiKey?: string;
  readonly baseURL?: string;
}

export interface FileRecord {
  readonly path: string;
  readonly realPath: string;
  /** Path relative to the selected root. This is the only path form sent off the machine. */
  readonly relativePath: string;
  readonly text: string;
  readonly bytes: number;
}

export interface SkippedFile {
  readonly path: string;
  readonly reason:
    | "missing"
    | "not-readable"
    | "unsupported-extension"
    | "sensitive"
    | "ignored-directory"
    | "symlink-outside-root"
    | "binary"
    | "invalid-utf8"
    | "too-large"
    | "total-byte-limit"
    | "file-limit"
    | "chunk-limit";
  readonly detail?: string;
}

export interface DiscoveryReport {
  readonly files: readonly FileRecord[];
  readonly skipped: readonly SkippedFile[];
  readonly roots: readonly string[];
}

export interface LinePart {
  readonly number: number;
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

export interface Candidate {
  readonly id: string;
  readonly path: string;
  readonly realPath: string;
  /** Path relative to the selected root. This is the only path form sent off the machine. */
  readonly relativePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
  readonly lexicalScore: number;
  readonly matchedTerms: readonly string[];
}

export interface RetrievalReport {
  readonly candidates: readonly Candidate[];
  readonly filesScanned: number;
  readonly chunksScanned: number;
  readonly skipped: readonly SkippedFile[];
  readonly roots: readonly string[];
}

export interface Result {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly lineRange: string;
  /** The exact local source slice for this candidate. */
  readonly text: string;
  readonly evidenceType: EvidenceType;
  readonly relevance: number;
  readonly source: ResultSource;
  readonly matchedTerms?: readonly string[];
  readonly semantic?: {
    readonly relevanceScore: number;
    readonly relevantProbability: number;
    readonly confidence: number | null;
    readonly abstained: boolean;
  };
}

export interface SearchResponse {
  readonly query: string;
  readonly mode: "local-lexical" | "semantic" | "local-lexical-fallback";
  readonly status: "ok" | "no-match" | "fallback";
  readonly results: readonly Result[];
  readonly filesScanned: number;
  readonly chunksScanned: number;
  readonly candidateCount: number;
  readonly semanticCandidateCount: number;
  readonly semanticRequestCount: number;
  readonly skipped: readonly SkippedFile[];
  readonly roots: readonly string[];
  readonly fallbackReason?: string;
  readonly warnings?: readonly string[];
}
