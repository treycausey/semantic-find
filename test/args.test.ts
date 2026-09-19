import { expect, test } from "bun:test";
import { ArgumentError, parseArguments } from "../src/args";

test("argument parser accepts quoted query values and repeatable roots", () => {
  const parsed = parseArguments([
    "--json",
    "--query",
    "physical device acceptance",
    "--root",
    "./docs",
    "--root=./notes.md",
    "--semantic",
  ]);
  expect(parsed.options).toMatchObject({
    query: "physical device acceptance",
    roots: ["./docs", "./notes.md"],
    semantic: true,
    format: "json",
  });
});

test("argument parser rejects missing roots, empty queries, and unknown options", () => {
  expect(() => parseArguments(["--query", "something"])).toThrow(ArgumentError);
  expect(() => parseArguments(["--query", " ", "./docs"])).toThrow(ArgumentError);
  expect(() => parseArguments(["--query", "something", "./docs", "--wat"])).toThrow(
    ArgumentError,
  );
});
