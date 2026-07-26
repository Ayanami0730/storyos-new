/**
 * `read_relation_history` — novelty 2's consumption path.
 *
 * The record has had a schema, a validator and a renderer since the second week.
 * What it has never had is a way for the writer to *see* it. That gap is the
 * whole risk of the novelty: a data structure nobody reads cannot show up in the
 * prose we are scored on, and until this week nothing even produced the files.
 *
 * Reading the YAML with `cat` is not a substitute. It returns the structure —
 * indices, scene ids, supersedes pointers — when what the writer needs is the
 * narrative view: these two were strangers, then this happened, then that, and
 * she reads it differently from him. `renderHistory` produces exactly that, and
 * this is the only thing that calls it.
 */

import { Type } from "typebox";
import { parse as fromYaml } from "yaml";

import {
  type RelationRecord,
  pairId as canonicalPairId,
  phasesAt,
  renderHistory,
} from "../index/relations.ts";
import { paths } from "../index/tree.ts";
import type { AgentRole } from "../transaction/types.ts";

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

export interface RelationToolOptions {
  readonly read: (relPath: string) => Promise<string>;
  /** Present for symmetry with the other tools; every role may read. */
  readonly role?: AgentRole;
}

export function relationHistoryTool(options: RelationToolOptions): unknown {
  return {
    label: "Read relation history",
    name: "read_relation_history",
    description:
      "How a pair's relationship reached its current state: every phase in order, what " +
      "caused each change, any asymmetry between the two views, and the scene each phase " +
      "came from. Give the two entity ids in any order. Pass at_scene to see only what is " +
      "in force then. Use this rather than reading the file — the file is the structure, " +
      "this is the story of it.",
    parameters: Type.Object({
      a: Type.String({ description: "One entity id, e.g. char-mira" }),
      b: Type.String({ description: "The other entity id" }),
      at_scene: Type.Optional(
        Type.String({ description: "Restrict to phases in force at this scene" }),
      ),
    }),
    execute: async (_id: string, args: { a: string; b: string; at_scene?: string }) => {
      if (!args.a?.trim() || !args.b?.trim()) {
        return toolText("rejected: give both entity ids.");
      }
      const id = canonicalPairId(args.a, args.b);
      let record: RelationRecord;
      try {
        record = fromYaml(await options.read(paths.relation(id))) as RelationRecord;
      } catch {
        // Absence is a real answer. These two may simply never have shared a
        // scene, and inventing a history for them is how a relationship arrives
        // fully formed in prose with nothing behind it.
        return toolText(
          `no relation record for ${id}. These two may never have shared a scene. If they ` +
            `have, the record was not written — that is worth reporting rather than ` +
            `working around.`,
        );
      }
      if (!record?.phases?.length) {
        return toolText(`${id} exists but has no phases recorded yet.`);
      }
      if (args.at_scene === undefined) return toolText(renderHistory(record));

      const inForce = phasesAt(record, args.at_scene);
      if (inForce.length === 0) {
        return toolText(
          `${record.participants[0]} & ${record.participants[1]}: no phase is in force at ` +
            `${args.at_scene}. Their relationship either has not started or every phase ` +
            `covering this point was superseded.`,
        );
      }
      // Same rendering, restricted: a writer comparing the two views should not
      // have to reconcile two formats.
      return toolText(renderHistory({ ...record, phases: inForce }));
    },
  };
}
