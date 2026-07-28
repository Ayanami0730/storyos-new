#!/usr/bin/env python3
"""Does a deterministic person check find the drift the model verifier missed?

The 20,000-word manuscript scored 4.93 consistency errors per 10,000 words —
worst of the nine systems at that tier — and **seven of its nine errors were
`perspective_confusions`**. Six of those seven had both sides inside a single
scene, 18 to 167 words apart, one of them inside a single sentence. The model
verifier reviewed those scenes and reported zero consistency findings.

This probe asks whether the blatant case is mechanically detectable, which
decides whether the fix belongs in the deterministic layer (free, unarguable)
or in the model's brief (a request it already ignored once).

Run against a manuscript plus its declared person:

    probe-person-drift.py --person "third person limited, Rue" story.md

Validation targets are in the module docstring of the caller; the useful check
is that it fires on the seven known spots and stays quiet on manuscripts that
were measured clean.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

# Narration only. First-person pronouns inside quoted speech are not drift —
# characters say "we" — and counting them is the obvious way to get a detector
# that cries wolf on every page of dialogue.
#
# Paired explicitly rather than as one character class over every quote mark.
# The class version matched a closing curly quote as an opener and ran on to the
# next one, which left whole speeches in the narration and took the false
# positive rate to 43.78 per 10k words against a ground truth of 3.83.
QUOTES = [
    re.compile(r"\u201c[^\u201c\u201d]*\u201d", re.S),  # “ … ”
    re.compile(r'"[^"]*"', re.S),  # " … "
    re.compile(r"\u2018[^\u2018\u2019]*\u2019", re.S),  # ‘ … ’
]

FIRST_PLURAL = re.compile(r"\b(we|us|our|ours|ourselves)\b", re.I)
FIRST_SINGULAR = re.compile(r"\b(i|me|my|mine|myself)\b")
SECOND = re.compile(r"\b(you|your|yours|yourself)\b", re.I)


def strip_dialogue(text: str) -> str:
    # Blank the span rather than delete it, so word offsets stay comparable with
    # the scorer's, which counts words in the manuscript as written.
    for q in QUOTES:
        text = q.sub(lambda m: " " * len(m.group(0)), text)
    return text


def sentences(text: str) -> list[tuple[int, str]]:
    out, pos = [], 0
    for m in re.finditer(r"[^.!?\n]+[.!?]*", text):
        s = m.group(0).strip()
        if s:
            out.append((m.start(), s))
    return out


def declared_person(person: str) -> str:
    p = person.lower()
    if "first person" in p:
        return "first-plural" if "plural" in p else "first"
    if "second person" in p:
        return "second"
    return "third"


def offending(person_kind: str, sent: str) -> str | None:
    """A pronoun the declared person forbids in narration."""
    if person_kind == "third":
        if FIRST_PLURAL.search(sent):
            return "first-person plural in third-person narration"
        if FIRST_SINGULAR.search(sent):
            return "first-person singular in third-person narration"
    elif person_kind == "first":
        # A first-person narrator may say "we" about a group they are in, so
        # plural is not evidence. Third-person narration is not the complement
        # either: a first-person narrator describes other people constantly.
        return None
    elif person_kind == "first-plural":
        return None
    return None


def scan(text: str, person: str) -> list[dict]:
    kind = declared_person(person)
    hits = []
    narration = strip_dialogue(text)
    words_before = lambda i: len(narration[:i].split())
    for start, sent in sentences(narration):
        why = offending(kind, sent)
        if why:
            hits.append({"word": words_before(start), "why": why, "quote": sent[:200]})
    return hits


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("manuscript", type=pathlib.Path)
    ap.add_argument("--person", required=True)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    text = a.manuscript.read_text(encoding="utf-8", errors="replace")
    hits = scan(text, a.person)
    if a.json:
        print(json.dumps(hits, ensure_ascii=False, indent=1))
        return 0
    total = len(text.split())
    print(f"{a.manuscript}  {total} words  declared: {a.person}")
    print(f"  {len(hits)} narration sentence(s) contradict the declared person "
          f"({len(hits)/max(1,total)*10000:.2f} per 10k words)")
    for h in hits[:25]:
        print(f"    @{h['word']:6d}  {h['why']}\n              {h['quote']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
