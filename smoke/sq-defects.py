#!/usr/bin/env python3
"""How wide are the three defects the judge named, across every finished manuscript?

Reading three judge analyses gives three hypotheses; acting on them needs to know
whether each is one manuscript or the whole batch. The three, in the judge's own
words:

  1. "It reads like an unfinished middle section rather than a complete story …
     the required ending is absent … lacks full arc, climax, and payoff."
     (lbw103, Relevance 2 against agentwrite's 5.) That cell committed 3 of its 4
     planned scenes, and the one it lost was the last — a middle scene lost is a
     hole, a final scene lost is a story with no ending.

  2. "switches inexplicably between Chinese and English" (lbw119, Accuracy 2).
     Structurally identical to the narrative-person drift 0.8.8 fixed and the
     spelling drift 0.9.11 fixed: the writer's session resets per scene and nothing
     carries the language, so each scene picks one.

  3. "没有明确标注五幕，整体更像连续小说片段而非规范剧本" (lbw112, Relevance 2).
     The plan's vocabulary cannot express a five-act script, so the plan quietly
     substitutes prose scenes.

Counts the first two, which are mechanical. The third needs a schema change and is
reported as the list of tasks whose prompt asks for a form the plan cannot state.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CJK = re.compile(r"[\u4e00-\u9fff]")
LATIN_WORD = re.compile(r"\b[a-zA-Z]{2,}\b")

#: Phrases in a task prompt that ask for a form the plan has no field for.
FORM_WORDS = [
    ("剧本", "script"), ("幕", "acts"), ("日记", "diary"), ("书信", "letters"),
    ("分.{0,3}部分", "parts"), ("论述", "essay"), ("分析", "analysis"),
    ("script", "script"), ("screenplay", "screenplay"), ("diary", "diary"),
    ("act ", "acts"), ("in two parts", "parts"), ("outline", "outline"),
]


def scene_language_mix(cell: Path) -> tuple[int, int, list[str]]:
    """(scenes, scenes whose language differs from the book's majority, examples).

    A scene's language is decided by which script carries its content words, and a
    book's by its scenes. Only a clear majority counts as the book's language, so a
    genuinely bilingual task is not reported as drifting.
    """
    chapters = cell / "run" / "project" / "novel" / "chapters"
    if not chapters.is_dir():
        return 0, 0, []
    per_scene: list[tuple[str, str]] = []
    for md in sorted(chapters.rglob("*.md")):
        text = md.read_text(errors="replace")
        cjk = len(CJK.findall(text))
        latin = len(LATIN_WORD.findall(text))
        if cjk + latin < 50:
            continue
        per_scene.append((md.stem, "zh" if cjk > latin else "en"))
    if not per_scene:
        return 0, 0, []
    zh = sum(1 for _, lang in per_scene if lang == "zh")
    book = "zh" if zh * 2 > len(per_scene) else "en"
    odd = [name for name, lang in per_scene if lang != book]
    return len(per_scene), len(odd), odd[:4]


def main() -> int:
    batch = sys.argv[1] if len(sys.argv) > 1 else "runs-lbw21"
    bdir = REPO / batch

    print(f"{'cell':<10} {'scenes':>10} {'lost last':>10} {'lang drift':>26} {'form ask':>14}")
    lost_last = lang_hit = form_hit = total = 0
    for cell in sorted(p for p in bdir.iterdir() if p.is_dir()):
        s = cell / "summary-stdout.json"
        t = cell / "task.json"
        if not (s.is_file() and t.is_file()):
            continue
        try:
            summary = json.loads(s.read_text())
            task = json.loads(t.read_text())
        except json.JSONDecodeError:
            continue
        if not summary.get("scenes_planned"):
            continue
        total += 1
        committed = summary.get("scenes_committed") or 0
        planned = summary.get("scenes_planned") or 0

        # The final scene is lost when the committed count falls short *and* the
        # failure list names the last planned scene. Falling short in the middle is
        # a hole; falling short at the end is a story that stops.
        failed_ids = {f.get("sceneId") for f in summary.get("failures", [])}
        last_id = f"s-{planned:03d}"
        missing_end = committed < planned and last_id in failed_ids
        if missing_end:
            lost_last += 1

        n, odd, examples = scene_language_mix(cell)
        if odd:
            lang_hit += 1

        prompt = task.get("prompt", "")
        forms = sorted({label for pat, label in FORM_WORDS if re.search(pat, prompt, re.I)})
        if forms:
            form_hit += 1

        if missing_end or odd or forms:
            print(
                f"{cell.name:<10} {committed:>4}/{planned:<5} "
                f"{('YES ' + last_id) if missing_end else '-':>10} "
                f"{(f'{odd}/{n} ' + ','.join(examples)) if odd else '-':>26} "
                f"{','.join(forms) if forms else '-':>14}"
            )

    print()
    print(f"{total} manuscript(s)")
    print(f"  lost the final planned scene : {lost_last}")
    print(f"  language drifts between scenes: {lang_hit}")
    print(f"  prompt asks for a form the plan cannot state: {form_hit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
