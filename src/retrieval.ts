import type {
  Candidate,
  FileRecord,
  LinePart,
  RetrievalReport,
  SearchOptions,
} from "./types";
import { discoverFiles } from "./files";

const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "after",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "by",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "not",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

/** Hard local/source bound. CLI values can reduce this, never raise it. */
export const HARD_MAX_CHUNK_CHARS = 6_000;

export function tokenize(value: string): readonly string[] {
  return [...value.toLocaleLowerCase().matchAll(TOKEN_PATTERN)]
    .map(([token]) => token)
    .filter((token) => !STOP_WORDS.has(token));
}

function normalizedToken(token: string): string {
  const lower = token.toLocaleLowerCase();
  if (lower.length > 5 && lower.endsWith("ies")) {
    return `${lower.slice(0, -3)}y`;
  }
  if (lower.length > 5 && lower.endsWith("ing")) {
    return lower.slice(0, -3);
  }
  if (lower.length > 4 && lower.endsWith("ed")) {
    return lower.slice(0, -2);
  }
  if (lower.length > 4 && lower.endsWith("s")) {
    return lower.slice(0, -1);
  }
  return lower;
}

function uniqueNormalizedTokens(tokens: readonly string[]): readonly string[] {
  return [...new Set(tokens.map(normalizedToken).filter((token) => token.length > 1))];
}

export function splitLines(text: string): readonly LinePart[] {
  const lines: LinePart[] = [];
  let offset = 0;
  let lineNumber = 1;
  while (offset < text.length) {
    const remaining = text.slice(offset);
    const match = remaining.match(/[^\r\n]*(?:\r\n|\n|\r|$)/u);
    if (!match || match[0].length === 0) {
      break;
    }
    const raw = match[0];
    const content = raw.replace(/(?:\r\n|\n|\r)$/u, "");
    lines.push({
      number: lineNumber,
      start: offset,
      end: offset + raw.length,
      content,
    });
    offset += raw.length;
    lineNumber += 1;
  }
  return lines;
}

function chunksForFile(
  file: FileRecord,
  options: SearchOptions,
): readonly Omit<Candidate, "lexicalScore" | "matchedTerms">[] {
  const lines = splitLines(file.text);
  const chunks: Omit<Candidate, "lexicalScore" | "matchedTerms">[] = [];
  const chunkChars = Math.min(options.maxChunkChars, HARD_MAX_CHUNK_CHARS);
  const hasIndexableContent = (text: string): boolean =>
    splitLines(text).some(
      (line) => line.content.trim().length > 0 && !/^#{1,6}\s/u.test(line.content.trim()) && tokenize(line.content).length > 0,
    );
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const firstLine = lines[lineIndex];
    const firstLineLength = firstLine.end - firstLine.start;
    if (firstLineLength > chunkChars) {
      // Keep every candidate bounded even when a JSONL or minified source file
      // has a single very long line. Each slice is still an exact local source
      // substring and carries the original line number.
      for (
        let start = firstLine.start;
        start < firstLine.end;
        start += chunkChars
      ) {
        const end = Math.min(firstLine.end, start + chunkChars);
        const chunk = {
          id: `${file.realPath}:${firstLine.number}-${firstLine.number}:${start}-${end}`,
          path: file.path,
          realPath: file.realPath,
          relativePath: file.relativePath,
          lineStart: firstLine.number,
          lineEnd: firstLine.number,
          text: file.text.slice(start, end),
        };
        if (hasIndexableContent(chunk.text)) {
          chunks.push(chunk);
        }
      }
      lineIndex += 1;
      continue;
    }
    let endIndex = lineIndex;
    let characterCount = 0;
    while (endIndex < lines.length) {
      const line = lines[endIndex];
      const lineLength = line.end - line.start;
      const lineCount = endIndex - lineIndex;
      if (
        lineCount >= options.maxChunkLines ||
        (characterCount + lineLength > chunkChars && endIndex > lineIndex)
      ) {
        break;
      }
      characterCount += lineLength;
      endIndex += 1;
    }
    const lastLine = lines[endIndex - 1];
    const text = file.text.slice(firstLine.start, lastLine.end);
    const chunk = {
      id: `${file.realPath}:${firstLine.number}-${lastLine.number}`,
      path: file.path,
      realPath: file.realPath,
      relativePath: file.relativePath,
      lineStart: firstLine.number,
      lineEnd: lastLine.number,
      text,
    };
    if (hasIndexableContent(chunk.text)) {
      chunks.push(chunk);
    }
    lineIndex = endIndex;
  }
  return chunks;
}

function scoreCandidate(
  candidate: Omit<Candidate, "lexicalScore" | "matchedTerms">,
  queryTokens: readonly string[],
): Candidate {
  const queryNormalized = uniqueNormalizedTokens(queryTokens);
  const candidateTokens = tokenize(candidate.text);
  const candidateNormalized = candidateTokens.map(normalizedToken);
  const candidateTokenSet = new Set(candidateNormalized);
  const matchedTerms = queryNormalized.filter((token) => candidateTokenSet.has(token));
  const overlap = queryNormalized.length === 0 ? 0 : matchedTerms.length / queryNormalized.length;
  const termFrequency = matchedTerms.reduce(
    (total, token) =>
      total + candidateNormalized.filter((candidateToken) => candidateToken === token).length,
    0,
  );
  const phrase = queryNormalized.length > 1
    ? queryNormalized.every((token, index) => candidateNormalized[index] === token)
      ? 1
      : queryNormalized.join(" ")
          .split(" ")
          .every((token) => candidateNormalized.includes(token))
        ? 0.5
        : 0
    : 0;
  const density = Math.min(1, termFrequency / Math.max(2, queryNormalized.length * 2));
  const lexicalScore = Math.min(1, overlap * 0.65 + phrase * 0.25 + density * 0.1);
  return {
    ...candidate,
    lexicalScore,
    matchedTerms,
  };
}

function rankCandidates(
  candidates: readonly Omit<Candidate, "lexicalScore" | "matchedTerms">[],
  query: string,
): readonly Candidate[] {
  const queryTokens = tokenize(query);
  return candidates
    .map((candidate) => scoreCandidate(candidate, queryTokens))
    .sort((left, right) => {
      if (right.lexicalScore !== left.lexicalScore) {
        return right.lexicalScore - left.lexicalScore;
      }
      if (right.matchedTerms.length !== left.matchedTerms.length) {
        return right.matchedTerms.length - left.matchedTerms.length;
      }
      return left.id.localeCompare(right.id);
    });
}

export async function retrieve(options: SearchOptions): Promise<RetrievalReport> {
  const discovery = await discoverFiles(options);
  const rawChunks: Omit<Candidate, "lexicalScore" | "matchedTerms">[] = [];
  let truncated = false;
  for (const file of discovery.files) {
    if (rawChunks.length >= options.maxChunks) {
      truncated = true;
      break;
    }
    const chunks = chunksForFile(file, options);
    const available = Math.max(0, options.maxChunks - rawChunks.length);
    rawChunks.push(...chunks.slice(0, available));
    if (chunks.length > available) {
      truncated = true;
      break;
    }
  }
  const skipped = [...discovery.skipped];
  if (truncated) {
    skipped.push({
      path: discovery.files.at(-1)?.path ?? discovery.roots[0] ?? "",
      reason: "chunk-limit",
      detail: `maximum ${options.maxChunks} chunks reached`,
    });
  }
  return {
    candidates: rankCandidates(rawChunks, options.query),
    filesScanned: discovery.files.length,
    chunksScanned: rawChunks.length,
    skipped,
    roots: discovery.roots,
  };
}

export function localEvidenceType(
  _score: number,
): "direct" | "supporting" | "background" | "unknown" {
  // Lexical overlap can rank a chunk. It cannot establish that the source
  // states an answer, so local and fallback results abstain on evidence type.
  return "unknown";
}
