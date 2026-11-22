# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/im-flow/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/im-flow/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats
(unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and
JSON tool calls) to a tree of text files, to one written specification. It
finds the lines an edit names even when the model drifted their whitespace or
indentation (three matching tiers: exact, trailing-whitespace-tolerant, and
indent-tolerant), and changes every file or none at all.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file, or standard input when absent or `-`.
`--format` picks one of `unified`, `search-replace`, `v4a`, `json`, or `auto`
(the default, which detects the format). `--check` reports what would change
without writing anything. `--strict` matches lines exactly (tier 0 only).
Node 22 and its standard library alone; nothing is installed.

---

<sub>Entered on [make.fun](https://make.fun/?ref=d6c5jsze&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
