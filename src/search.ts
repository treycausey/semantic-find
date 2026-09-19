import type {
  Candidate,
  Result,
  SearchOptions,
  SearchResponse,
} from "./types";
import type { Fetch } from "@typesafe-ai/sdk";
import { localEvidenceType, retrieve } from "./retrieval";
import { evaluateCandidates, JEV_MODEL } from "./semantic";

const HARD_MAX_SEMANTIC_CANDIDATES = 64;

function localResult(candidate: Candidate, source: "local-lexical" | "local-lexical-fallback"): Result {
  return {
    path: candidate.path,
    lineStart: candidate.lineStart,
    lineEnd: candidate.lineEnd,
    lineRange: `${candidate.lineStart}-${candidate.lineEnd}`,
    text: candidate.text,
    evidenceType: localEvidenceType(candidate.lexicalScore),
    relevance: candidate.lexicalScore,
    source,
    matchedTerms: candidate.matchedTerms,
  };
}

function topLocalResults(
  candidates: readonly Candidate[],
  options: SearchOptions,
  source: "local-lexical" | "local-lexical-fallback",
): readonly Result[] {
  return candidates
    .filter((candidate) => candidate.lexicalScore > 0)
    .slice(0, options.maxResults)
    .map((candidate) => localResult(candidate, source));
}

function baseResponse(
  options: SearchOptions,
  retrieval: Awaited<ReturnType<typeof retrieve>>,
  values: Partial<SearchResponse>,
): SearchResponse {
  return {
    query: options.query,
    mode: "local-lexical",
    status: "no-match",
    results: [],
    filesScanned: retrieval.filesScanned,
    chunksScanned: retrieval.chunksScanned,
    candidateCount: retrieval.candidates.length,
    semanticCandidateCount: 0,
    semanticRequestCount: 0,
    skipped: retrieval.skipped,
    roots: retrieval.roots,
    ...values,
  };
}

export interface SearchDependencies {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly fetch?: Fetch;
}

export async function search(
  options: SearchOptions,
  dependencies: SearchDependencies = {},
): Promise<SearchResponse> {
  const retrieval = await retrieve(options);
  if (!options.semantic) {
    const results = topLocalResults(retrieval.candidates, options, "local-lexical");
    return baseResponse(options, retrieval, {
      mode: "local-lexical",
      status: results.length === 0 ? "no-match" : "ok",
      results,
    });
  }

  // Semantic mode deliberately includes zero lexical-score candidates. This
  // lets Jev recover meaning when the query and source use different words,
  // while the candidate limit keeps the cloud boundary explicit and bounded.
  const requestedSemanticLimit = options.semanticAll
    ? options.maxChunks
    : Math.min(options.semanticCandidates, options.maxChunks);
  const semanticLimit = Math.min(requestedSemanticLimit, HARD_MAX_SEMANTIC_CANDIDATES);
  const semanticCandidates = retrieval.candidates.slice(0, semanticLimit);
  const warnings: string[] = [];
  if (requestedSemanticLimit > HARD_MAX_SEMANTIC_CANDIDATES) {
    warnings.push(
      `semantic rerank is hard-limited to ${HARD_MAX_SEMANTIC_CANDIDATES} requests per run`,
    );
  }
  if (semanticCandidates.length === 0) {
    warnings.push("no readable text chunks were available; no Jev request was made");
    return baseResponse(options, retrieval, {
      mode: "semantic",
      status: "no-match",
      semanticCandidateCount: 0,
      warnings,
    });
  }
  if (retrieval.candidates.length > semanticCandidates.length) {
    warnings.push(
      `semantic rerank considered ${semanticCandidates.length} of ${retrieval.candidates.length} local chunks; use --semantic-all or raise --semantic-candidates for broader recall`,
    );
  }
  const apiKey = dependencies.apiKey ?? process.env.TYPESAFE_API_KEY?.trim();
  const fallbackReason = apiKey
    ? undefined
    : "--semantic was requested but TYPESAFE_API_KEY is not set; using local lexical results";
  if (!apiKey) {
    const results = topLocalResults(
      retrieval.candidates,
      options,
      "local-lexical-fallback",
    );
    return baseResponse(options, retrieval, {
      mode: "local-lexical-fallback",
      status: "fallback",
      results,
      semanticCandidateCount: semanticCandidates.length,
      fallbackReason,
      warnings,
    });
  }

  const semanticRun = await evaluateCandidates(options.query, semanticCandidates, {
    apiKey,
    timeoutMs: options.timeoutMs,
    baseURL: dependencies.baseURL,
    fetch: dependencies.fetch,
  });
  if (semanticRun.failures.length > 0 || semanticRun.evaluations.length === 0) {
    const detail = semanticRun.failures[0]?.message ?? "Jev returned no valid evaluations";
    const reason = `semantic rerank failed (${detail}); using local lexical results`;
    const results = topLocalResults(
      retrieval.candidates,
      options,
      "local-lexical-fallback",
    );
    return baseResponse(options, retrieval, {
      mode: "local-lexical-fallback",
      status: "fallback",
      results,
      semanticCandidateCount: semanticCandidates.length,
      semanticRequestCount: semanticRun.requestCount,
      fallbackReason: reason,
      warnings,
    });
  }

  const byId = new Map(retrieval.candidates.map((candidate) => [candidate.id, candidate]));
  const semanticResults: Result[] = [];
  for (const evaluation of semanticRun.evaluations) {
    const candidate = byId.get(evaluation.candidateId);
    if (!candidate) {
      continue;
    }
    const relevance = evaluation.abstained
      ? 0
      : Math.max(
          0,
          Math.min(1, evaluation.relevanceScore * evaluation.relevantProbability),
        );
    semanticResults.push({
      path: candidate.path,
      lineStart: candidate.lineStart,
      lineEnd: candidate.lineEnd,
      lineRange: `${candidate.lineStart}-${candidate.lineEnd}`,
      text: candidate.text,
      evidenceType: evaluation.evidenceType,
      relevance,
      source: "semantic" as const,
      matchedTerms: candidate.matchedTerms,
      semantic: {
        relevanceScore: evaluation.relevanceScore,
        relevantProbability: evaluation.relevantProbability,
        confidence: evaluation.confidence,
        abstained: evaluation.abstained,
      },
    });
  }
  const results = semanticResults
    .filter((result) => result.relevance > 0)
    .sort((left, right) => {
      if (right.relevance !== left.relevance) {
        return right.relevance - left.relevance;
      }
      return left.path.localeCompare(right.path) || left.lineStart - right.lineStart;
    })
    .slice(0, options.maxResults);

  return baseResponse(options, retrieval, {
    mode: "semantic",
    status: results.length === 0 ? "no-match" : "ok",
    results,
    semanticCandidateCount: semanticCandidates.length,
    semanticRequestCount: semanticRun.requestCount,
    warnings,
  });
}

export const semanticModel = JEV_MODEL;
