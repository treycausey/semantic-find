import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Fetch } from "@typesafe-ai/sdk";
import { search } from "../src/search";
import type { SearchOptions } from "../src/types";

const fixtureRoot = resolve(import.meta.dir, "../test-fixtures");
const basicRoot = resolve(fixtureRoot, "basic");

function options(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    query: "installed on the phone",
    roots: [basicRoot],
    includeSource: false,
    semantic: false,
    semanticAll: false,
    format: "json",
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
    maxFiles: 100,
    maxChunks: 100,
    maxResults: 10,
    semanticCandidates: 32,
    maxChunkLines: 16,
    maxChunkChars: 3_000,
    timeoutMs: 100,
    ...overrides,
  };
}

test("local retrieval preserves exact path, line range, and source text", async () => {
  const response = await search(options({ maxChunkLines: 1 }));
  expect(response.mode).toBe("local-lexical");
  expect(response.status).toBe("ok");
  expect(response.results[0]).toMatchObject({
    path: resolve(basicRoot, "deployment.md"),
    lineStart: 3,
    lineEnd: 3,
    lineRange: "3-3",
    text: "The implementation is complete and the build is installed on the phone.\n",
    source: "local-lexical",
    evidenceType: "unknown",
  });
  expect(response.results[0]?.relevance).toBeGreaterThan(0);
});

test("directory discovery excludes secrets, build output, dependencies, and escaping symlinks", async () => {
  const response = await search(options({ query: "do not index this fixture", includeSource: true }));
  expect(response.results).toHaveLength(0);
  const skipped = new Map(response.skipped.map((entry) => [entry.path, entry.reason]));
  expect([...skipped.values()]).toContain("ignored-directory");
  expect([...skipped.values()]).toContain("symlink-outside-root");
});

test("an in-root symlink cannot alias a sensitive file or ignored directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-find-links-"));
  try {
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "secrets"));
    await writeFile(join(root, "secret-note.md"), "sensitive evidence must stay private\n");
    await writeFile(join(root, "node_modules", "hidden.md"), "hidden dependency evidence\n");
    await writeFile(join(root, "secrets", "notes.md"), "sensitive directory evidence\n");
    await symlink("secret-note.md", join(root, "alias.md"));
    await symlink("node_modules", join(root, "linked-dependencies"));
    await symlink("secrets", join(root, "safe-looking-docs"));

    const sensitive = await search(options({ query: "sensitive evidence", roots: [root] }));
    expect(sensitive.results).toHaveLength(0);
    expect(sensitive.skipped).toContainEqual({
      path: join(root, "alias.md"),
      reason: "sensitive",
    });

    const ignored = await search(options({ query: "hidden dependency", roots: [root] }));
    expect(ignored.results).toHaveLength(0);
    expect(ignored.skipped).toContainEqual({
      path: join(root, "linked-dependencies"),
      reason: "ignored-directory",
    });

    const sensitiveDirectory = await search(
      options({ query: "sensitive directory", roots: [root] }),
    );
    expect(sensitiveDirectory.results).toHaveLength(0);
    expect(sensitiveDirectory.skipped).toContainEqual({
      path: join(root, "safe-looking-docs"),
      reason: "sensitive",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping roots do not duplicate the same real file", async () => {
  const response = await search(
    options({
      query: "physical device acceptance",
      roots: [fixtureRoot, resolve(fixtureRoot, "nested")],
      maxChunkLines: 1,
    }),
  );
  const nestedResults = response.results.filter((result) => result.path.endsWith("nested/notes.txt"));
  expect(nestedResults).toHaveLength(1);
});

test("source files are opt-in while directly selected source files remain usable", async () => {
  const defaultResponse = await search(options({ query: "source files are opt-in" }));
  expect(defaultResponse.results).toHaveLength(0);
  const includedResponse = await search(
    options({ query: "source files are opt-in", includeSource: true }),
  );
  expect(includedResponse.results[0]?.path).toBe(resolve(basicRoot, "source.ts"));
  const directResponse = await search(
    options({ query: "source files are opt-in", roots: [resolve(basicRoot, "source.ts")] }),
  );
  expect(directResponse.results[0]?.path).toBe(resolve(basicRoot, "source.ts"));
});

function responseFor(relevant: boolean, evidenceType: string = relevant ? "direct" : "unknown") {
  return {
    model: "jev-1.13.0",
    answers: {
      evidenceType: {
        type: "choice",
        choice: evidenceType,
        confidence: 1,
        probabilities: {},
      },
      relevance: {
        type: "score",
        score: relevant ? 4 : 0,
        confidence: 1,
        legend: {},
        probabilities: {},
      },
      relevant: { type: "noul", noul: relevant ? 1 : 0 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test("semantic mode sends bounded candidate chunks and can recover a lexical miss", async () => {
  const requestTexts: string[] = [];
  const requestModels: string[] = [];
  const fetch: Fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      state: { candidate: { text: string } };
    };
    requestModels.push(body.model);
    const text = body.state.candidate.text;
    requestTexts.push(text);
    const relevant = text.includes("physical device acceptance");
    return new Response(JSON.stringify(responseFor(relevant)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const response = await search(
    options({
      query: "handset signoff",
      roots: [fixtureRoot],
      semantic: true,
      semanticAll: true,
      maxChunks: 20,
    }),
    { apiKey: "synthetic-test-key", fetch },
  );
  expect(response.mode).toBe("semantic");
  expect(response.results[0]?.path).toBe(resolve(fixtureRoot, "nested/notes.txt"));
  expect(response.results[0]?.text).toBe("The physical device acceptance step remains open.\n");
  expect(response.results[0]?.evidenceType).toBe("direct");
  expect(requestTexts.length).toBeGreaterThan(1);
  expect(new Set(requestModels)).toEqual(new Set(["jev-1.13.0"]));
  expect(requestTexts.every((text) => text.length <= 6_000)).toBe(true);
  expect(requestTexts.every((text) => text.trim().length > 0)).toBe(true);
  expect(requestTexts.every((text) => !/^#{1,6}\s[^\n]*\s*$/u.test(text.trim()))).toBe(true);
});

test("default semantic chunks retain multi-line evidence context", async () => {
  const requestTexts: string[] = [];
  const fetch: Fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { state: { candidate: { text: string } } };
    const text = body.state.candidate.text;
    requestTexts.push(text);
    const relevant = text.includes("Early Save") && text.includes("physical measurement");
    return new Response(JSON.stringify(responseFor(relevant)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const response = await search(
    options({
      query: "Where is physical device acceptance still unverified?",
      roots: [resolve(fixtureRoot, "context.md")],
      semantic: true,
      semanticAll: true,
    }),
    { apiKey: "synthetic-test-key", fetch },
  );
  expect(response.mode).toBe("semantic");
  expect(response.results[0]?.path).toBe(resolve(fixtureRoot, "context.md"));
  expect(response.results[0]?.lineStart).toBe(1);
  expect(response.results[0]?.lineEnd).toBeGreaterThanOrEqual(6);
  expect(response.results[0]?.text).toContain("Early Save");
  expect(response.results[0]?.text).toContain("physical measurement");
  expect(requestTexts.some((text) => text.includes("Early Save") && text.includes("physical measurement"))).toBe(true);
});

test("long source lines stay under the hard semantic text bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-find-long-line-"));
  try {
    const longText = `${"prefix ".repeat(1_500)}needle ${"suffix ".repeat(1_500)}\n`;
    await writeFile(join(root, "long.md"), longText);
    const requestTexts: string[] = [];
    const fetch: Fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { state: { candidate: { text: string } } };
      requestTexts.push(body.state.candidate.text);
      return new Response(JSON.stringify(responseFor(body.state.candidate.text.includes("needle"))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const response = await search(
      options({
        query: "needle",
        roots: [root],
        semantic: true,
        semanticAll: true,
        maxChunkChars: 100_000,
      }),
      { apiKey: "synthetic-test-key", fetch },
    );
    expect(response.mode).toBe("semantic");
    expect(requestTexts.length).toBeGreaterThan(1);
    expect(requestTexts.every((text) => text.length <= 6_000)).toBe(true);
    expect(response.results[0]?.text).toContain("needle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing API key is an explicit local fallback without a network call", async () => {
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    throw new Error("should not be called");
  };
  const response = await search(options({ semantic: true }), { apiKey: "", fetch });
  expect(response.mode).toBe("local-lexical-fallback");
  expect(response.status).toBe("fallback");
  expect(response.fallbackReason).toContain("TYPESAFE_API_KEY");
  expect(response.results[0]?.source).toBe("local-lexical-fallback");
  expect(calls).toBe(0);
});

test("malformed Jev answers fall back instead of rendering model text", async () => {
  const fetch: Fetch = async () =>
    new Response(JSON.stringify({ answers: { relevance: { type: "score", score: 99 } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const response = await search(options({ semantic: true }), {
    apiKey: "synthetic-test-key",
    fetch,
  });
  expect(response.mode).toBe("local-lexical-fallback");
  expect(response.fallbackReason).toContain("semantic rerank failed");
  expect(response.results[0]?.text).toContain("installed on the phone");
});

test("an unknown Jev evidence choice abstains even with a high relevance score", async () => {
  const fetch: Fetch = async () =>
    new Response(JSON.stringify(responseFor(true, "unknown")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const response = await search(options({ semantic: true }), {
    apiKey: "synthetic-test-key",
    fetch,
  });
  expect(response.mode).toBe("semantic");
  expect(response.status).toBe("no-match");
  expect(response.results).toHaveLength(0);
});

test("transport timeouts are bounded and use local fallback", async () => {
  const fetch: Fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("timed out", "TimeoutError"));
      });
    });
  const started = Date.now();
  const response = await search(options({ semantic: true, timeoutMs: 20 }), {
    apiKey: "synthetic-test-key",
    fetch,
  });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(response.mode).toBe("local-lexical-fallback");
  expect(response.fallbackReason).toContain("semantic rerank failed");
});

test("a query with no lexical evidence returns no match", async () => {
  const response = await search(options({ query: "a phrase absent from the corpus" }));
  expect(response.status).toBe("no-match");
  expect(response.results).toHaveLength(0);
});

test("an empty semantic corpus does not make a Jev request", async () => {
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    throw new Error("should not be called");
  };
  const response = await search(
    options({ semantic: true, roots: [resolve(fixtureRoot, "missing")] }),
    { apiKey: "synthetic-test-key", fetch },
  );
  expect(response.status).toBe("no-match");
  expect(response.warnings?.[0]).toContain("no readable text chunks");
  expect(calls).toBe(0);
});
