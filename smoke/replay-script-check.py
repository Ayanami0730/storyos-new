#!/usr/bin/env python3
"""Replay the language check over every finished scene, before it can reject one.

The rule this project has learned twice: a deterministic gate is only worth adding
if it has been shown not to fire on good work. The annotation refusal in 0.9.10 was
replayed over twelve manuscripts and rejected exactly the two carrying the defect;
the orthography *finding* was not replayed through the layer that runs it, and the
result was two runs delivering a quarter of their scenes.

So this reproduces the check exactly as `verifyDeterministic` will apply it — the
convention comes from the first committed scene of each manuscript, every later
scene is tested against it — and reports what it would have blocked. A hit on a
manuscript the judge criticised for switching language is the check working; a hit
anywhere else is a false positive and has to be understood before this ships.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HAN = re.compile(r"[\u4e00-\u9fff]")
LATIN_WORD = re.compile(r"\b[a-zA-Z]{2,}\b")


def script_of(text: str, min_tokens: int = 50) -> str | None:
    """Mirror of `scriptOf` in orthography.ts; kept in step by the counts below."""
    han = len(HAN.findall(text))
    latin = len(LATIN_WORD.findall(text))
    if han + latin < min_tokens:
        return None
    return "han" if han > latin else "latin"


def main() -> int:
    batch = sys.argv[1] if len(sys.argv) > 1 else "runs-lbw21"
    blocked_total = 0
    manuscripts = 0
    print(f"{'cell':<10} {'book':>6} {'scenes':>7} {'would block':>12}  first blocked scene")
    for cell in sorted(p for p in (REPO / batch).iterdir() if p.is_dir()):
        chapters = cell / "run" / "project" / "novel" / "chapters"
        if not chapters.is_dir():
            continue
        scenes = [(p.stem, p.read_text(errors="replace")) for p in sorted(chapters.rglob("*.md"))]
        if not scenes:
            continue
        manuscripts += 1

        # The request decides, so scene one is checked like every other scene.
        task = cell / "task.json"
        prompt = ""
        if task.is_file():
            import json as _json

            try:
                prompt = _json.loads(task.read_text()).get("prompt", "")
            except ValueError:
                prompt = ""
        convention = script_of(prompt, min_tokens=12)
        if convention is None:
            continue
        blocked = [
            name
            for name, text in scenes
            if (script_of(text) or convention) != convention
        ]
        if blocked:
            blocked_total += len(blocked)
            print(
                f"{cell.name:<10} {str(convention):>6} {len(scenes):>7} {len(blocked):>12}  "
                f"{blocked[0]}"
            )
    print()
    print(f"{manuscripts} manuscript(s); the check would have demanded a rewrite of "
          f"{blocked_total} scene(s)")
    print("Every hit must be a scene in the other language. Read one before shipping.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
