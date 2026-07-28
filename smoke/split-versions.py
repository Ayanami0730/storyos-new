#!/usr/bin/env python3
"""Stage one version's worth of the working tree, without touching the tree.

Four versions were developed in one uncommitted diff, which is exactly the
attribution failure `version.ts` exists to prevent: twenty-odd finished runs
carry `harness_version: 0.9.6` while the tree has moved to 0.9.8, so that number
points at code no longer on disk, and a version that scores worse cannot be
rolled back to the one before it.

The tree is deliberately left alone. Four batch runners are live and each spawns
`write-story` as a child process that reads source at spawn, so checking out an
intermediate state would hand a partially-rebuilt harness to whatever starts
next. Instead each commit is assembled in the git index with `hash-object` and
`update-index`, and `git commit` records the index.

Two files carry more than one version's changes and are rewritten per commit:
`version.ts` (VERSION plus the history entries newer than the target are
dropped) and `story.ts` (the one 0.9.7 line, `log: say`, is removed for 0.9.6).
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Files whose whole change belongs to one version, in the order the versions
# landed. `version.ts` and `package.json` are staged per commit by rewriting.
PLAN: list[tuple[str, list[str], str]] = [
    (
        "0.9.5",
        [
            "src/runtime/revision.ts",
            "src/verification/layers.test.ts",
            "src/version.test.ts",
        ],
        "fix: 全场景失败的 run 报告失败而不是崩溃，并修好被截断的 VERSION_NOTE",
    ),
    (
        "0.9.6",
        [
            "src/agents/personas.ts",
            "src/agents/personas.test.ts",
            "src/runtime/scene-director.ts",
            "src/runtime/summary.ts",
            "src/runtime/rates.ts",
            "src/runtime/rates.test.ts",
            "smoke/index-health.py",
            "smoke/roundtrips.py",
            "smoke/probe-route-params.py",
            "smoke/launch-096.sh",
        ],
        "fix: index-manager 恢复写索引 —— fold_scene 缺在允许清单里，26 个 run 的状态全为空",
    ),
    (
        "0.9.7",
        [
            "src/runtime/plan.ts",
            "src/runtime/plan.test.ts",
            "src/runtime/collaborators.ts",
            "src/runtime/collaborators.test.ts",
            "smoke/make-lnb-tasks.py",
            "smoke/make-ch24-tasks.py",
            "smoke/status.sh",
            "smoke/split-versions.py",
        ],
        "fix: 拒答算失败并重试，writer 失败时清会话",
    ),
    (
        "0.9.8",
        [
            "src/runtime/orchestration.ts",
            "src/runtime/orchestration.test.ts",
        ],
        "feat: 把字数推算交给 orchestrator，它是唯一能加场景的角色",
    ),
]


def run(*args: str, capture: bool = False) -> str:
    r = subprocess.run(args, cwd=ROOT, capture_output=capture, text=True, check=True)
    return (r.stdout or "").strip()


def version_ts_for(target: str, final: str) -> str:
    """`version.ts` as it stood at `target`: VERSION set, newer entries dropped."""
    out = re.sub(r'export const VERSION = "[^"]*";', f'export const VERSION = "{target}";', final, count=1)
    versions = re.findall(r'^  \{\n    version: "([^"]+)",', out, flags=re.M)
    newer = versions[: versions.index(target)]
    for v in newer:
        block = re.search(
            r'^  \{\n    version: "' + re.escape(v) + r'",\n.*?\n  \},\n',
            out,
            flags=re.M | re.S,
        )
        if not block:
            raise SystemExit(f"could not find the history block for {v}")
        out = out[: block.start()] + out[block.end() :]
    return out


def stage_text(path: str, text: str) -> None:
    """Put `text` in the index at `path`, leaving the working tree untouched."""
    tmp = ROOT / ".git" / f"stage-{Path(path).name}"
    tmp.write_text(text)
    sha = run("git", "hash-object", "-w", str(tmp), capture=True)
    run("git", "update-index", "--add", "--cacheinfo", f"100644,{sha},{path}")
    tmp.unlink()


def main() -> int:
    final_version_ts = (ROOT / "src/version.ts").read_text()
    final_story_ts = (ROOT / "src/runtime/story.ts").read_text()
    final_pkg = (ROOT / "package.json").read_text()

    for target, files, message in PLAN:
        for f in files:
            if not (ROOT / f).exists():
                raise SystemExit(f"{f} does not exist")
            run("git", "add", f)

        stage_text("src/version.ts", version_ts_for(target, final_version_ts))
        stage_text(
            "package.json",
            re.sub(r'"version": "[^"]*"', f'"version": "{target}"', final_pkg, count=1),
        )

        # `story.ts` gains the backfill counters at 0.9.6 and one line at 0.9.7.
        if target == "0.9.6":
            stage_text(
                "src/runtime/story.ts",
                final_story_ts.replace("    log: say,\n", "", 1),
            )
        elif target == "0.9.7":
            stage_text("src/runtime/story.ts", final_story_ts)

        run("git", "commit", "-m", message)
        run("git", "tag", f"v{target}")
        print(f"committed and tagged v{target}: {message}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
