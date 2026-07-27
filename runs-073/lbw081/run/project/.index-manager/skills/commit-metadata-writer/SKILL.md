---
name: commit-metadata-writer
description: Write commit metadata JSON for a scene including verifier verdict, warning note, draft path, and state delta paths.
uses: functions.read, functions.bash
---

1. Gather scene id and verifier outcome from orchestrator input. 2. List the committed draft path under novel/chapters/.../scenes/<scene>.md. 3. Collect paths to changed state files (characters/*/state.jsonl, relations/*, events/*, continuity/*). 4. Write a JSON file staging/<txid>/metadata.json with fields: sceneId, base_head (from HEAD), verifier, warnings, draft_path, delta_paths (array). 5. Do not attempt to write to canonical partitions; caller will use index-manager tools to commit.
