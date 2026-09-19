import type { OutputFormat, SearchOptions } from "./types";

export const DEFAULTS: Record<
  | "maxFileBytes"
  | "maxTotalBytes"
  | "maxFiles"
  | "maxChunks"
  | "maxResults"
  | "semanticCandidates"
  | "maxChunkLines"
  | "maxChunkChars"
  | "timeoutMs",
  number
> = {
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFiles: 2_000,
  maxChunks: 5_000,
  maxResults: 10,
  semanticCandidates: 32,
  maxChunkLines: 16,
  maxChunkChars: 3_000,
  timeoutMs: 10_000,
} as const;

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

export interface ParsedArguments {
  readonly options: SearchOptions;
  readonly help: boolean;
  readonly version: boolean;
}

function requireValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ArgumentError(`${option} requires a value`);
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ArgumentError(`${option} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ArgumentError(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseValueOption(
  argv: readonly string[],
  index: number,
  option: string,
  value: string | undefined,
): { value: string; consumed: number } {
  if (value !== undefined) {
    if (value.length === 0) {
      throw new ArgumentError(`${option} requires a value`);
    }
    return { value, consumed: 0 };
  }
  return { value: requireValue(argv, index, option), consumed: 1 };
}

export function usage(): string {
  return `Usage:
  semantic-find --query "words to find" <file-or-directory>...
  semantic-find --query "words to find" --root ./docs --root ./notes.md

Options:
  -q, --query <text>          Search query. Required.
      --root <path>           Add an explicit file or directory root. Repeatable.
      --semantic              Ask Jev to rerank bounded local candidates.
      --semantic-all          Ask Jev to rerank all bounded candidates.
      --json                   Emit machine-readable JSON.
      --format <human|json>    Select output format. Default: human.
      --include-source         Include common source, data, and log files.
      --max-file-bytes <n>     Skip files larger than n bytes. Default: ${DEFAULTS.maxFileBytes}.
      --max-total-bytes <n>    Bound total bytes read. Default: ${DEFAULTS.maxTotalBytes}.
      --max-files <n>          Bound files read. Default: ${DEFAULTS.maxFiles}.
      --max-chunks <n>         Bound chunks ranked or sent to Jev. Default: ${DEFAULTS.maxChunks}.
      --max-results <n>        Maximum displayed matches. Default: ${DEFAULTS.maxResults}.
      --semantic-candidates <n>
                              Maximum chunks sent to Jev. Default: ${DEFAULTS.semanticCandidates}.
      --max-chunk-lines <n>    Maximum lines in a local chunk. Default: ${DEFAULTS.maxChunkLines}.
      --max-chunk-chars <n>    Maximum target chars in a local chunk. Default: ${DEFAULTS.maxChunkChars}.
      --timeout-ms <n>         Jev request timeout. Default: ${DEFAULTS.timeoutMs}.
      --help                   Show this help.
      --version                Show the version.

Cloud boundary:
  Local lexical retrieval is the default. --semantic sends only selected local
  candidate text to Jev when TYPESAFE_API_KEY is present. No whole-filesystem
  scan or background upload occurs. Results always render text from local files.
`;
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  let query: string | undefined;
  let format: OutputFormat = "human";
  let includeSource = false;
  let semantic = false;
  let semanticAll = false;
  let maxFileBytes = DEFAULTS.maxFileBytes;
  let maxTotalBytes = DEFAULTS.maxTotalBytes;
  let maxFiles = DEFAULTS.maxFiles;
  let maxChunks = DEFAULTS.maxChunks;
  let maxResults = DEFAULTS.maxResults;
  let semanticCandidates = DEFAULTS.semanticCandidates;
  let maxChunkLines = DEFAULTS.maxChunkLines;
  let maxChunkChars = DEFAULTS.maxChunkChars;
  let timeoutMs = DEFAULTS.timeoutMs;
  const roots: string[] = [];
  let help = false;
  let version = false;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !arg.startsWith("-")) {
      roots.push(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (arg === "--semantic") {
      semantic = true;
      continue;
    }
    if (arg === "--semantic-all") {
      semantic = true;
      semanticAll = true;
      continue;
    }
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--include-source") {
      includeSource = true;
      continue;
    }

    const queryMatch = arg.match(/^(?:--query|-q)=(.*)$/);
    if (queryMatch) {
      query = parseValueOption(argv, index, "--query", queryMatch[1]).value;
      continue;
    }
    if (arg === "--query" || arg === "-q") {
      const parsed = parseValueOption(argv, index, arg, undefined);
      query = parsed.value;
      index += parsed.consumed;
      continue;
    }

    const rootMatch = arg.match(/^--root=(.*)$/);
    if (rootMatch) {
      const parsed = parseValueOption(argv, index, "--root", rootMatch[1]);
      roots.push(parsed.value);
      continue;
    }
    if (arg === "--root") {
      const parsed = parseValueOption(argv, index, "--root", undefined);
      roots.push(parsed.value);
      index += parsed.consumed;
      continue;
    }

    const formatMatch = arg.match(/^--format=(.*)$/);
    if (formatMatch || arg === "--format") {
      const parsed = formatMatch
        ? { value: formatMatch[1], consumed: 0 }
        : parseValueOption(argv, index, "--format", undefined);
      if (parsed.value !== "human" && parsed.value !== "json") {
        throw new ArgumentError("--format must be human or json");
      }
      format = parsed.value;
      index += parsed.consumed;
      continue;
    }

    const numericOptions: Record<
      string,
      (value: number) => void
    > = {
      "--max-file-bytes": (value) => {
        maxFileBytes = value;
      },
      "--max-total-bytes": (value) => {
        maxTotalBytes = value;
      },
      "--max-files": (value) => {
        maxFiles = value;
      },
      "--max-chunks": (value) => {
        maxChunks = value;
      },
      "--max-results": (value) => {
        maxResults = value;
      },
      "--semantic-candidates": (value) => {
        semanticCandidates = value;
      },
      "--max-chunk-lines": (value) => {
        maxChunkLines = value;
      },
      "--max-chunk-chars": (value) => {
        maxChunkChars = value;
      },
      "--timeout-ms": (value) => {
        timeoutMs = value;
      },
    };
    const equalsIndex = arg.indexOf("=");
    const optionName = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const numericSetter = numericOptions[optionName];
    if (numericSetter) {
      const valueText =
        equalsIndex === -1
          ? parseValueOption(argv, index, optionName, undefined)
          : parseValueOption(argv, index, optionName, arg.slice(equalsIndex + 1));
      numericSetter(positiveInteger(valueText.value, optionName));
      index += valueText.consumed;
      continue;
    }

    throw new ArgumentError(`unknown option: ${arg}`);
  }

  if (help || version) {
    return {
      help,
      version,
      options: {
        query: query ?? "",
        roots,
        includeSource,
        semantic,
        semanticAll,
        format,
        maxFileBytes,
        maxTotalBytes,
        maxFiles,
        maxChunks,
        maxResults,
        semanticCandidates,
        maxChunkLines,
        maxChunkChars,
        timeoutMs,
      },
    };
  }

  if (!query || query.trim().length === 0) {
    throw new ArgumentError("--query is required and cannot be empty");
  }
  if (roots.length === 0) {
    throw new ArgumentError("at least one file or directory root is required");
  }
  if (!query.match(/[\p{L}\p{N}]/u)) {
    throw new ArgumentError("--query must contain at least one letter or number");
  }
  if (query.trim().length > 2_000) {
    throw new ArgumentError("--query must be 2,000 characters or shorter");
  }

  return {
    help,
    version,
    options: {
      query: query.trim(),
      roots,
      includeSource,
      semantic,
      semanticAll,
      format,
      maxFileBytes,
      maxTotalBytes,
      maxFiles,
      maxChunks,
      maxResults,
      semanticCandidates,
      maxChunkLines,
      maxChunkChars,
      timeoutMs,
    },
  };
}
