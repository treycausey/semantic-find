# semantic-find

`semantic-find` searches explicitly selected local files for evidence. The default mode reads Markdown and plain text, ranks bounded chunks with a small lexical scorer, and prints the exact local path, line range, source text, evidence type (`unknown` for lexical-only results), and relevance.

Semantic reranking is opt-in:

```sh
bun install
bun run src/cli.ts --query "physical device acceptance" ./test-fixtures
bun run src/cli.ts --json --query "installed on the phone" ./test-fixtures/basic

# This sends only the selected candidate chunks below to Jev.
TYPESAFE_API_KEY=... bun run src/cli.ts --semantic \
  --query "physical device acceptance" ./test-fixtures
```

The Jev model is pinned to `jev-1.13.0`. `--semantic` sends the query, the candidate's path and line range, and the candidate text to TypeSafe AI. It never sends the whole filesystem. **The path it sends is relative to the root you selected**, so a request carries `nested/notes.txt`, never `/Users/you/nested/notes.txt`: the absolute location, your home directory, and your account name stay on the machine. A directly selected file is sent as its basename alone. Results printed locally still show the full path so you can open them. It also never prints a quotation returned by Jev: every result's `text` comes from the local source bytes retained before the request. Without `TYPESAFE_API_KEY`, with a timeout, or with an invalid Jev answer, the CLI reports `local-lexical-fallback` and keeps the local results.

Roots are positional and must be supplied. There is no implicit current-directory or home-directory scan. Multiple roots are supported:

```sh
bun run src/cli.ts --json --query "deployment status" ./docs ./notes.md
```

By default the walker skips credentials, config/settings files, and secret-like paths, `.git`, `node_modules`, build output, binaries, malformed UTF-8, symlinks that leave each selected directory, files above 512 KiB, and a run-wide 32 MiB byte budget. Candidate windows contain up to 16 lines by default, while each local chunk is capped at 6,000 characters. Use `--max-chunk-lines 1` when narrow line-level results are preferred. `--include-source` adds common source, data, and log extensions. A directly selected text file with an uncommon extension is allowed after binary detection. The cloud path is bounded to at most 64 Jev requests per run.

Useful limits include `--max-files`, `--max-chunks`, `--max-results`, `--max-file-bytes`, `--max-total-bytes`, `--semantic-candidates`, `--max-chunk-lines`, `--max-chunk-chars`, and `--timeout-ms`. `--semantic-all` requests a bounded rerank of all retrieved chunks, still subject to the hard 64-request cap.

## Install locally

From this checkout, with Bun available on your PATH:

```sh
bun install --frozen-lockfile
mkdir -p ~/.local/bin
ln -s "$PWD/src/cli.ts" ~/.local/bin/semantic-find
semantic-find --version
```

Ensure `~/.local/bin` is on your PATH. The symlink follows this checkout; update it with `git pull --ff-only` and `bun install --frozen-lockfile`. The command uses local retrieval unless you pass `--semantic` and supply `TYPESAFE_API_KEY`. It runs on demand and has no background service.

## Development

```sh
bun install
bun run typecheck
bun test
```

The fixture queries in `test/search.test.ts` and the machine-readable `test-fixtures/evaluations.json` cover these expected locations:

| Query | Expected evidence |
| --- | --- |
| `installed on the phone` | `test-fixtures/basic/deployment.md` (decisive source line 3) |
| `handset signoff` | `test-fixtures/nested/notes.txt:1` (semantic mode can recover this from the lexical-miss candidate pool) |
| `production deployment happened` | `test-fixtures/basic/deployment.md` (decisive source line 4) |
| `a phrase absent from the corpus` | no matches |

## License

MIT. See [LICENSE](LICENSE).
