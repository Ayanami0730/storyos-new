# Harness contract

This project directory **is** the state of the novel. Nothing that matters lives
only in a conversation: a session can be summarised away at any time, and
anything not written here is lost when that happens.

## Partitions

| Path | Holds | Who writes |
|---|---|---|
| `novel/outline/` | premise, logline, beats, arcs, rhythm | index-manager |
| `novel/chapters/<ch>/scenes/<s>.md` | the prose | index-manager, on commit |
| `characters/<id>/profile.yaml` | identity — changing it is a retcon | index-manager |
| `characters/<id>/state.jsonl` | state timeline — current value is the last entry | index-manager |
| `characters/<id>/beliefs.jsonl` | what they know, and from when | index-manager |
| `relations/<pair>.yaml` | one pair's ordered relation phases | index-manager |
| `events/timeline.jsonl` | chronology | index-manager |
| `locations/` `objects/` `factions/` | other entities | index-manager |
| `world/rules.yaml` | what is true regardless of who knows it | index-manager |
| `continuity/` | canon facts, promises, open loops, retcons, findings | index-manager |
| `.<role>/memory/` | how that role works better here | that role |
| `.<role>/skills/` | reusable procedure | that role |
| `staging/<txid>/` | work in progress | anyone |
| `runtime/` | ledger, transcripts, evicted tool payloads | the engine |

## Two rules that are enforced, not requested

**Only index-manager writes outside `staging/` and its own dot-directory.**
Every other write is refused with the actor named.

**State and identity are different things.** A character's location, mood, what
they carry and where they are going change as the story moves: they are appended
to `state.jsonl` and the newest entry wins. Their name, eye colour and origin do
not: those live in `profile.yaml` and changing one requires declaring a retcon.
Confusing the two is how a story where someone walks across a room becomes a
continuity failure.

## Reading

Read with the shell — `grep`, `ls`, `sed` — and read as much as you need. The
index is the cheap thing; guessing is the expensive thing. Facts you assert must
name the file they came from.
