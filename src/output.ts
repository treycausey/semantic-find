import type { Result, SearchResponse } from "./types";

function formatRelevance(value: number): string {
  return value.toFixed(2);
}

function renderResult(result: Result, index: number): string {
  const lines = [
    `${index}. ${result.path}:${result.lineRange}`,
    `   evidence: ${result.evidenceType} | relevance: ${formatRelevance(result.relevance)} | source: ${result.source}`,
  ];
  if (result.matchedTerms && result.matchedTerms.length > 0) {
    lines.push(`   lexical terms: ${result.matchedTerms.join(", ")}`);
  }
  if (result.semantic) {
    lines.push(
      `   Jev: score ${formatRelevance(result.semantic.relevanceScore)} | useful ${formatRelevance(result.semantic.relevantProbability)}${result.semantic.abstained ? " | abstained" : ""}`,
    );
  }
  lines.push("   text:");
  lines.push("   -----");
  lines.push(result.text);
  lines.push("   -----");
  return lines.join("\n");
}

export function renderHuman(response: SearchResponse): string {
  const lines = [
    `semantic-find: ${response.mode}`,
    `query: ${JSON.stringify(response.query)}`,
    `results: ${response.results.length}`,
    `files scanned: ${response.filesScanned} | chunks scanned: ${response.chunksScanned}`,
  ];
  if (response.semanticCandidateCount > 0) {
    lines.push(
      `semantic candidates: ${response.semanticCandidateCount} | Jev requests: ${response.semanticRequestCount}`,
    );
  }
  if (response.fallbackReason) {
    lines.push(`fallback: ${response.fallbackReason}`);
  }
  if (response.warnings && response.warnings.length > 0) {
    for (const warning of response.warnings) {
      lines.push(`warning: ${warning}`);
    }
  }
  if (response.results.length === 0) {
    lines.push(response.status === "no-match" ? "No matching evidence." : "No usable evidence.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("");
  lines.push(...response.results.map((result, index) => renderResult(result, index + 1)));
  return `${lines.join("\n\n")}\n`;
}

export function renderJson(response: SearchResponse): string {
  return `${JSON.stringify(response, null, 2)}\n`;
}
