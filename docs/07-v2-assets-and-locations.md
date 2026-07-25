# 07 — Where the v2 assets actually live

Snapshot 2026-07-25 14:01. This file exists because the v2 paper and every
scoring artifact behind the numbers in `04-results.md` sat in an uncommitted
working tree on one laptop until now. They are split across git and sgp-dev.
Read this before trying to reproduce or cite anything from v2.

The v2 repository is `Ayanami0730/storyos`, branch `codex-run`, tip `c4b211c`.
The v3 tree you are reading is the orphan branch `v3-engine` in the same
repository. Full detail is in the v2 `README.md` section 接手须知; this file is
the pointer, not the source of truth.

## Branches

| Branch | Contents |
|---|---|
| `codex-run` | v2 trunk: engine, the 8-page submission, figures, all scoring evidence |
| `mac-src-20260725` | The 11 engine/test files edited on the laptop, based on `702bcde` |
| `v3-engine` | This tree. Independent root commit, no shared history with the trunk |
| `main` | Retired, behind `codex-run` |

## What is in git

`paper/main.tex` and `paper/main.pdf` (8 pages), `paper/references.bib`, the
three figures `main.tex` actually includes with their generator scripts, and the
per-section drafts. `docs/12-baseline-fidelity-audit.md` is the adapter
faithfulness audit that open thread 1 in `05-open-threads.md` is about.
`docs/13-experiment-settings.md` and `docs/14-h20-reproduction-package.md` cover
settings and the GPU restoration plan.

Scoring evidence is under `experiments/`: `checker/*.summary.json` for aggregate
and per-category CED, `checker/*.jsonl` for per-scene findings, `summary.json`
and `summary.md` for the ranked tables, plus runner scripts, the cost ledger and
console logs.

Building the paper needs the AAAI kit on the TeX search path, because
`aaai2027.sty` lives in `paper/aaai27-kit/AuthorKit27/` rather than `paper/`:

```bash
cd paper
export TEXINPUTS=".:./aaai27-kit/AuthorKit27:" \
       BSTINPUTS=".:./aaai27-kit/AuthorKit27:" \
       BIBINPUTS=".:./aaai27-kit/AuthorKit27:"
latexmk -pdf -interaction=nonstopmode main.tex
```

## What is only on sgp-dev

These are gitignored and were copied to the matching paths under
`sgp-dev:~/storyos/`, with file counts and byte totals verified on both sides:

| Path | Files | Bytes |
|---|---:|---:|
| `runs/tuning-local-r1-20260724-after-3m-w20k/` | 9,159 | 49,808,604 |
| `experiments/reproduction-subsubset/dome-checkpoints/` | 177 | 19,332,476 |
| `experiments/novelbench-subset/outputs/` | 71 | 17,028,466 |
| `experiments/judge_calibration/litbench-select/data/` | 1 | 9,135,377 |
| `paper/figures/` superseded gpt-image-2 batches | 39 | 21,021,964 |
| `paper/figures/main_page*.png` | 3 | 1,937,495 |

The sgp-dev root filesystem is at 100% with roughly 16G free. Check `df -h`
before adding artifacts.

## Four corrections that affect this tree

**`04-results.md` reports StoryOS CED as 4.69. The measured value is 4.672.**
`experiments/reproduction-subsubset/checker/storyos-index.summary.json` records
`aggregate_ced: 4.672288732124666`, and `score-storyos.log` agrees. The English
results doc, its Chinese mirror `zh/docs/04-results.zh.md`, and the website's
`research-pages.json` all need this fixed. The same summary reports
`completed: 14`, `completed_task_count: 14`, `completed_word_count: 130557`, so
the denominator there is 14, not 19 or 20.

**That run is not bit-reproducible.** Its `run-manifest.json` records
`engine_source_sha256: 1d2e924b…`, and recomputing the digest gives `92c901e1…`
for the laptop tree, `e1c88a03…` for `origin/codex-run` and `49abcab1…` for
`702bcde`. None match, and the manifest note admits a parallel baseline process
had uncommitted edits in flight at the time. The closest available snapshot is
`mac-src-20260725`, verified byte-identical to the laptop tree across all 37
engine files in scope. Any reproduction claim needs a freshly locked snapshot
and a new run first.

**Computing that digest requires submodules.** The scope is `.md/.py/.sql` under
`src/engine`, `src/storyos` and `benchmarks/constory`, and
`benchmarks/constory/upstream` is a submodule pinned to
`github.com/Picrew/ConStory-Bench.git@3f4195ad`. A clone without
`--recurse-submodules` is missing 13 files and produces a different digest.

**The engine divergence is a merge decision, not a fast-forward.** Twelve engine
files differ between `mac-src-20260725` and `codex-run`; five of them were
edited on both sides. This is open thread 5 in `05-open-threads.md`.
