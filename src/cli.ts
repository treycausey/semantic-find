#!/usr/bin/env bun

import { parseArguments, ArgumentError, usage } from "./args";
import { renderHuman, renderJson } from "./output";
import { search } from "./search";

export const VERSION = "0.1.0";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    const message = error instanceof ArgumentError ? error.message : String(error);
    process.stderr.write(`semantic-find: ${message}\n\n${usage()}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    const response = await search(parsed.options);
    process.stdout.write(
      parsed.options.format === "json" ? renderJson(response) : renderHuman(response),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.options.format === "json") {
      process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    } else {
      process.stderr.write(`semantic-find: ${message}\n`);
    }
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
