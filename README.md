# mend

[![mend](https://img.shields.io/badge/mend-one_patch_tool-blue)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![Node](https://img.shields.io/badge/node-22-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`mend` is one command-line tool that applies AI-written edits, in four
formats, to a tree of text files — to one written specification, `SPEC.md`
in the kit. Every file is changed or nothing is.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- Formats: unified diffs (often with wrong line numbers),
  SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls.
  `--format=auto` (the default) detects the format; `--format` also takes
  `unified`, `search-replace`, `v4a` or `json`.
- PATCH is read from the named file, or from standard input when it is
  absent or `-`.
- Lines an edit names are found at the first of three tiers: exact,
  trailing whitespace ignored, then leading and trailing whitespace
  ignored (with re-indentation). `--strict` matches exactly only.
- `--check` reports the same output and exit code without writing
  anything. When any edit fails, no file is written at all.
- Exit codes and output lines, safe paths, CRLF handling, files without
  a final line break, moves, creations and deletions are all defined by
  `SPEC.md` — it is the whole contract.

Node 22 and its standard library alone. No dependencies, no network,
no configuration. Deterministic: the same check always gives the same
exit code, stdout and files, byte for byte.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner, kept as issued; `main.ts` hands
  a trial over to it when `MAKEFUN_ENV_URL` is set.
- `LICENSE` — MIT.
