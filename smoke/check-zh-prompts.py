#!/usr/bin/env python3
"""Does a translated role prompt still carry the machine contract intact?

The reason the role files were not translated at 0.9.15 is that they are not prose:
they carry the tool names the agent must call, the paths it must cite, the entity id
shapes it must not invent, and the refusal rules the gate depends on. A mistranslated
refusal rule breaks the gate rather than the writing, and it breaks it silently — the
run still finishes, and the number it produces is a number about a different system.

So the translation is only usable if a machine can confirm it: every backticked span,
every fenced block, every `snake_case` identifier and every path in the English file
must appear **verbatim** in the Chinese one, with the same multiplicity. That turns
"the translation looks careful" into something checkable.

Structure is checked too. A prompt whose headings were merged or dropped is a
different prompt even when every token survives.

    check-zh-prompts.py agents agents-zh
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

FENCE = re.compile(r"```.*?```", re.DOTALL)
TICK = re.compile(r"`[^`\n]+`")
SNAKE = re.compile(r"\b[a-z]{3,}(?:_[a-z]+)+\b")
PATHY = re.compile(r"\b[\w.-]+/[\w./*-]+\b")
HEADING = re.compile(r"^#{1,6}\s+", re.MULTILINE)

FILES = [
    "SHARED.md",
    "writer/AGENT.md",
    "orchestrator/AGENT.md",
    "verifier/AGENT.md",
    "context-builder/AGENT.md",
    "index-manager/AGENT.md",
]


def tokens(text: str) -> dict[str, Counter]:
    return {
        "fenced block": Counter(FENCE.findall(text)),
        "backticked span": Counter(TICK.findall(text)),
        "identifier": Counter(SNAKE.findall(text)),
        "path": Counter(PATHY.findall(text)),
    }


def main() -> int:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "agents")
    dst = Path(sys.argv[2] if len(sys.argv) > 2 else "agents-zh")

    failures = 0
    for name in FILES:
        a, b = src / name, dst / name
        if not b.is_file():
            print(f"MISSING  {b}")
            failures += 1
            continue
        english, chinese = a.read_text(), b.read_text()
        problems: list[str] = []

        for kind, want in tokens(english).items():
            got = tokens(chinese)[kind]
            for token, n in want.items():
                if got[token] < n:
                    problems.append(
                        f"{kind} {token!r} appears {n}x in English, {got[token]}x in Chinese"
                    )

        # Structure, so a merged or dropped section is caught even when every
        # token survived somewhere in the file.
        if len(HEADING.findall(english)) != len(HEADING.findall(chinese)):
            problems.append(
                f"{len(HEADING.findall(english))} headings in English, "
                f"{len(HEADING.findall(chinese))} in Chinese"
            )
        # A "translation" that is still English is the failure this catches most
        # cheaply, and it has happened: a model asked to translate a technical
        # document sometimes returns it unchanged.
        han = len(re.findall(r"[\u4e00-\u9fff]", chinese))
        if han < len(chinese) * 0.15:
            problems.append(f"only {han} Han characters in {len(chinese)} — not translated")

        status = "ok" if not problems else f"{len(problems)} problem(s)"
        print(f"{name:<30} {len(english):>6} -> {len(chinese):>6} chars   {status}")
        for p in problems[:8]:
            print(f"    - {p}")
        failures += len(problems)

    print()
    if failures:
        print(f"{failures} problem(s). The translation must not be used until these are zero:")
        print("a lost tool name or refusal rule changes what the harness enforces, silently.")
        return 1
    print("every tool name, path, identifier, fenced block and heading survived.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
