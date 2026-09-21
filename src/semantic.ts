import {
  APIConnectionError,
  APITimeoutError,
  TypeSafeClient,
  choice,
  noul,
  score,
} from "@typesafe-ai/sdk";
import type { Fetch, SystemOneResult } from "@typesafe-ai/sdk";
import type { Candidate, EvidenceType } from "./types";

export const JEV_MODEL = "jev-1.13.0";

const EVIDENCE_TYPES = ["direct", "supporting", "background", "unknown"] as const;
const RELEVANCE_SCORES = [
  "abstain: no useful evidence",
  "weak: the chunk is only loosely related",
  "moderate: the chunk supports the answer",
  "strong: the chunk is clearly relevant",
  "exact: the chunk directly answers the query",
] as const;

export interface SemanticEvaluation {
  readonly candidateId: string;
  readonly evidenceType: EvidenceType;
  readonly relevanceScore: number;
  readonly relevantProbability: number;
  readonly confidence: number | null;
  readonly abstained: boolean;
}

export interface SemanticFailure {
  readonly candidateId: string;
  readonly message: string;
  readonly kind: "timeout" | "transport" | "invalid-response" | "api";
}

export interface SemanticRun {
  readonly evaluations: readonly SemanticEvaluation[];
  readonly failures: readonly SemanticFailure[];
  readonly requestCount: number;
}

export interface SemanticOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly baseURL?: string;
  readonly fetch?: Fetch;
  /** Total wall-clock budget for the bounded rerank batch. */
  readonly totalTimeoutMs?: number;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteUnit(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number from 0 to 1`);
  }
  return value;
}

function validateChoiceAnswer(value: unknown): EvidenceType {
  const answer = asRecord(value, "evidenceType answer");
  if (answer.type !== "choice") {
    throw new Error("evidenceType answer has an invalid type");
  }
  if (typeof answer.choice !== "string" || !EVIDENCE_TYPES.includes(answer.choice as EvidenceType)) {
    throw new Error("evidenceType answer has an unknown choice");
  }
  if (answer.confidence !== undefined) {
    finiteUnit(answer.confidence, "evidenceType confidence");
  }
  if (answer.probabilities !== undefined) {
    const probabilities = asRecord(answer.probabilities, "evidenceType probabilities");
    for (const label of EVIDENCE_TYPES) {
      if (probabilities[label] !== undefined) {
        finiteUnit(probabilities[label], `evidenceType probability ${label}`);
      }
    }
  }
  return answer.choice as EvidenceType;
}

function validateScoreAnswer(value: unknown): { score: number; confidence: number | null } {
  const answer = asRecord(value, "relevance answer");
  if (answer.type !== "score") {
    throw new Error("relevance answer has an invalid type");
  }
  if (
    typeof answer.score !== "number" ||
    !Number.isFinite(answer.score) ||
    answer.score < 0 ||
    answer.score > RELEVANCE_SCORES.length - 1
  ) {
    throw new Error("relevance answer score must be from 0 to 4");
  }
  const confidence =
    answer.confidence === undefined ? null : finiteUnit(answer.confidence, "relevance confidence");
  if (answer.probabilities !== undefined) {
    const probabilities = asRecord(answer.probabilities, "relevance probabilities");
    for (const key of ["0", "1", "2", "3", "4"]) {
      if (probabilities[key] !== undefined) {
        finiteUnit(probabilities[key], `relevance probability ${key}`);
      }
    }
  }
  return { score: answer.score, confidence };
}

function validateNoulAnswer(value: unknown): number {
  const answer = asRecord(value, "relevant answer");
  if (answer.type !== "noul") {
    throw new Error("relevant answer has an invalid type");
  }
  return finiteUnit(answer.noul, "relevant probability");
}

function validateResponse(
  candidateId: string,
  response: unknown,
): SemanticEvaluation {
  const result = asRecord(response, "Jev response") as unknown as Partial<SystemOneResult<any>>;
  if (result.model !== undefined && result.model !== JEV_MODEL) {
    throw new Error(`Jev response used unexpected model ${String(result.model)}`);
  }
  const answers = asRecord(result.answers, "Jev answers");
  const evidenceType = validateChoiceAnswer(answers.evidenceType);
  const relevanceAnswer = validateScoreAnswer(answers.relevance);
  const relevantProbability = validateNoulAnswer(answers.relevant);
  const abstained =
    relevanceAnswer.score === 0 ||
    relevantProbability < 0.5 ||
    evidenceType === "unknown";
  return {
    candidateId,
    evidenceType: abstained ? "unknown" : evidenceType,
    relevanceScore: relevanceAnswer.score / (RELEVANCE_SCORES.length - 1),
    relevantProbability,
    confidence: relevanceAnswer.confidence,
    abstained,
  };
}

function classifyFailure(error: unknown): SemanticFailure["kind"] {
  if (
    error instanceof APITimeoutError ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "TimeoutError")
  ) {
    return "timeout";
  }
  if (error instanceof APIConnectionError) {
    return "transport";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /response|answer|score|choice|probability|object|type/u.test(message)
    ? "invalid-response"
    : "api";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function evaluateCandidates(
  query: string,
  candidates: readonly Candidate[],
  options: SemanticOptions,
): Promise<SemanticRun> {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultModel: JEV_MODEL,
    timeout: options.timeoutMs,
    retry: { maxRetries: 0 },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const evaluations: SemanticEvaluation[] = [];
  const failures: SemanticFailure[] = [];
  let requestCount = 0;

  // A bounded worker pool avoids turning a service outage into one timeout per
  // candidate. The deadline is independent of the SDK's per-attempt timeout.
  const workerCount = Math.min(4, Math.max(1, candidates.length));
  const deadline = Date.now() + (options.totalTimeoutMs ?? Math.max(30_000, options.timeoutMs * 3));
  let nextIndex = 0;
  let hardFailureCount = 0;

  const evaluateOne = async (candidate: Candidate): Promise<void> => {
    requestCount += 1;
    try {
      const response = await client.systemOne(
        {
          model: JEV_MODEL,
          state: {
            query,
            candidate: {
              // Relative by construction; the absolute path never leaves the machine.
              path: candidate.relativePath,
              lineStart: candidate.lineStart,
              lineEnd: candidate.lineEnd,
              text: candidate.text,
            },
          },
          questions: {
            evidenceType: choice(
              "What evidence role does this local chunk have for answering the query?",
              {
                direct: "It directly states the answer or decisive fact.",
                supporting: "It supports the answer but needs context or another fact.",
                background: "It is related background without answer-bearing evidence.",
                unknown: "The evidence role cannot be determined or it is unrelated.",
              },
            ),
            relevance: score("How relevant is this chunk to the query?", RELEVANCE_SCORES),
            relevant: noul(
              "Does this chunk contain useful evidence for the query rather than a superficial word overlap?",
              {
                true: "The chunk contains useful evidence.",
                false: "The chunk does not contain useful evidence or should be abstained from.",
              },
            ),
          },
        },
        { timeout: options.timeoutMs, retry: { maxRetries: 0 } },
      );
      evaluations.push(validateResponse(candidate.id, response));
    } catch (error) {
      const kind = classifyFailure(error);
      failures.push({
        candidateId: candidate.id,
        message: errorMessage(error),
        kind,
      });
      if (kind === "api" || kind === "transport" || kind === "timeout") {
        hardFailureCount += 1;
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (Date.now() < deadline) {
      if (hardFailureCount >= 3) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      if (!candidate) {
        return;
      }
      await evaluateOne(candidate);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (nextIndex < candidates.length) {
    failures.push({
      candidateId: candidates[nextIndex]?.id ?? "batch",
      message: "semantic rerank wall-clock budget exhausted before all candidates were evaluated",
      kind: "timeout",
    });
  }

  return { evaluations, failures, requestCount };
}
