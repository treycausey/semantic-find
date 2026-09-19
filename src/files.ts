import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  DiscoveryReport,
  FileRecord,
  SearchOptions,
  SkippedFile,
} from "./types";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".jsonl",
  ".log",
  ".m",
  ".mm",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "build",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  "target",
  "vendor",
]);

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".aws",
  ".config",
  ".gnupg",
  ".ssh",
  "credentials",
  "secrets",
]);

const SENSITIVE_FILE_NAME =
  /(^|[._-])(env|secret|secrets|credential|credentials|password|passwd|token|apikey|api-key|private-key)([._-]|$)/i;
const SENSITIVE_FILE_EXTENSIONS = new Set([
  ".der",
  ".jks",
  ".key",
  ".p12",
  ".pfx",
  ".pem",
]);
const CONFIG_FILE_NAME = /^(?:config|settings)(?:[._-].*)?$/i;

function pathIsWithin(child: string, parent: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith(`..${sep}`) && childRelative !== ".." && !isAbsolute(childRelative))
  );
}

function pathSegments(path: string): readonly string[] {
  return path.split(/[\\/]+/u).filter(Boolean);
}

function isSensitivePath(path: string): boolean {
  const segments = pathSegments(path);
  const basename = segments.at(-1) ?? "";
  const extension = extname(basename).toLowerCase();
  return (
    segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment.toLowerCase())) ||
    SENSITIVE_FILE_NAME.test(basename) ||
    SENSITIVE_FILE_EXTENSIONS.has(extension) ||
    CONFIG_FILE_NAME.test(basename) ||
    [".netrc", ".npmrc", ".pypirc"].includes(basename.toLowerCase())
  );
}

function isIgnoredDirectory(path: string): boolean {
  return pathSegments(path).some((segment) =>
    IGNORED_DIRECTORY_NAMES.has(segment.toLowerCase()),
  );
}

function extensionAllowed(
  path: string,
  explicitFile: boolean,
  includeSource: boolean,
): boolean {
  const extension = extname(path).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension) || extension === ".txt") {
    return true;
  }
  if (includeSource && SOURCE_EXTENSIONS.has(extension)) {
    return true;
  }
  // A directly selected file may be a text log or source file with a local
  // extension that is not in the common list. Binary detection still gates it.
  return explicitFile && extension.length > 0;
}

async function readTextFile(
  path: string,
  maxFileBytes: number,
): Promise<{ record?: FileRecord; reason?: SkippedFile["reason"] }> {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    return { reason: "not-readable" };
  }
  if (!fileStat.isFile()) {
    return { reason: "not-readable" };
  }
  if (fileStat.size > maxFileBytes) {
    return { reason: "too-large" };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return { reason: "not-readable" };
  }
  if (bytes.includes(0)) {
    return { reason: "binary" };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { reason: "invalid-utf8" };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(path);
  } catch {
    resolvedPath = resolve(path);
  }
  return {
    record: {
      path: resolve(path),
      realPath: resolvedPath,
      text,
      bytes: bytes.byteLength,
    },
  };
}

interface WalkContext {
  readonly boundary: string;
  readonly options: SearchOptions;
  readonly files: FileRecord[];
  readonly skipped: SkippedFile[];
  readonly visitedDirectories: Set<string>;
  readonly visitedFiles: Set<string>;
  totalBytes: number;
}

function skip(context: WalkContext, path: string, reason: SkippedFile["reason"], detail?: string): void {
  context.skipped.push({ path: resolve(path), reason, ...(detail ? { detail } : {}) });
}

async function walkPath(
  currentPath: string,
  context: WalkContext,
  explicitFile: boolean,
): Promise<void> {
  if (context.files.length >= context.options.maxFiles) {
    skip(context, currentPath, "file-limit");
    return;
  }

  let linkStat;
  try {
    linkStat = await lstat(currentPath);
  } catch {
    skip(context, currentPath, "missing");
    return;
  }

  let pathForStat = currentPath;
  if (linkStat.isSymbolicLink()) {
    let targetPath: string;
    try {
      targetPath = await realpath(currentPath);
    } catch {
      skip(context, currentPath, "symlink-outside-root", "broken symlink");
      return;
    }
    if (!pathIsWithin(targetPath, context.boundary)) {
      skip(context, currentPath, "symlink-outside-root");
      return;
    }
    pathForStat = targetPath;
    try {
      linkStat = await stat(currentPath);
    } catch {
      skip(context, currentPath, "not-readable");
      return;
    }
  }

  if (linkStat.isDirectory()) {
    if (isIgnoredDirectory(currentPath) || isIgnoredDirectory(pathForStat)) {
      skip(context, currentPath, "ignored-directory");
      return;
    }
    if (isSensitivePath(currentPath) || isSensitivePath(pathForStat)) {
      skip(context, currentPath, "sensitive");
      return;
    }
    let directoryRealPath: string;
    try {
      directoryRealPath = await realpath(pathForStat);
    } catch {
      skip(context, currentPath, "not-readable");
      return;
    }
    if (isIgnoredDirectory(directoryRealPath)) {
      skip(context, currentPath, "ignored-directory");
      return;
    }
    if (isSensitivePath(directoryRealPath)) {
      skip(context, currentPath, "sensitive");
      return;
    }
    if (context.visitedDirectories.has(directoryRealPath)) {
      return;
    }
    context.visitedDirectories.add(directoryRealPath);
    let entries;
    try {
      entries = await readdir(currentPath, {
        withFileTypes: true,
      });
    } catch {
      skip(context, currentPath, "not-readable");
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (context.files.length >= context.options.maxFiles) {
        skip(context, currentPath, "file-limit");
        break;
      }
      await walkPath(resolve(currentPath, entry.name), context, false);
    }
    return;
  }

  if (!linkStat.isFile()) {
    skip(context, currentPath, "not-readable");
    return;
  }
  if (
    isIgnoredDirectory(pathForStat) ||
    isSensitivePath(currentPath) ||
    isSensitivePath(pathForStat)
  ) {
    skip(context, currentPath, "sensitive");
    return;
  }
  if (!extensionAllowed(currentPath, explicitFile, context.options.includeSource)) {
    skip(context, currentPath, "unsupported-extension");
    return;
  }

  let fileRealPath: string;
  try {
    fileRealPath = await realpath(pathForStat);
  } catch {
    fileRealPath = resolve(pathForStat);
  }
  if (isIgnoredDirectory(fileRealPath)) {
    skip(context, currentPath, "ignored-directory");
    return;
  }
  if (isSensitivePath(fileRealPath)) {
    skip(context, currentPath, "sensitive");
    return;
  }
  if (context.visitedFiles.has(fileRealPath)) {
    return;
  }
  context.visitedFiles.add(fileRealPath);

  let fileStat;
  try {
    fileStat = await stat(pathForStat);
  } catch {
    skip(context, currentPath, "not-readable");
    return;
  }
  if (context.totalBytes + fileStat.size > context.options.maxTotalBytes) {
    skip(context, currentPath, "total-byte-limit");
    return;
  }

  const loaded = await readTextFile(pathForStat, context.options.maxFileBytes);
  if (!loaded.record) {
    skip(context, currentPath, loaded.reason ?? "not-readable");
    return;
  }
  context.files.push({
    ...loaded.record,
    path: resolve(currentPath),
    realPath: fileRealPath,
  });
  context.totalBytes += loaded.record.bytes;
}

export async function discoverFiles(options: SearchOptions): Promise<DiscoveryReport> {
  const files: FileRecord[] = [];
  const skipped: SkippedFile[] = [];
  const roots: string[] = [];
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();
  let totalBytes = 0;
  for (const root of options.roots) {
    const absoluteRoot = resolve(root);
    roots.push(absoluteRoot);
    let rootStat;
    try {
      rootStat = await lstat(absoluteRoot);
    } catch {
      skipped.push({ path: absoluteRoot, reason: "missing" });
      continue;
    }

    let realRoot: string;
    try {
      realRoot = await realpath(absoluteRoot);
    } catch {
      skipped.push({ path: absoluteRoot, reason: "not-readable" });
      continue;
    }
    const boundary = rootStat.isDirectory() ? realRoot : dirname(realRoot);
    const context: WalkContext = {
      boundary,
      options,
      files,
      skipped,
      visitedDirectories,
      visitedFiles,
      totalBytes,
    };
    await walkPath(absoluteRoot, context, rootStat.isFile());
    totalBytes = context.totalBytes;
  }
  return { files, skipped, roots };
}
