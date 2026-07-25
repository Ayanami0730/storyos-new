/**
 * The tools that touch the index.
 *
 * `read_relation_history` exists because of a gap worth naming: the relation
 * record schema is what makes novelty 2 concrete, and `renderHistory` already
 * produces exactly the view a writer needs — every phase in order with the
 * cause of each change. But nothing exposed it. An agent left to `cat` the YAML
 * gets the raw structure, has to reconstruct the ordering and the supersessions
 * itself, and will sometimes get it wrong; and a contribution that is never
 * consumed does not show up in the prose we are scored on. The general "reads
 * go through the shell" rule earns its first exception here, because the value
 * is in the *derived* view, not the bytes.
 *
 * `propose_state_delta` is where synchronous validation pays for itself. Every
 * problem it reports — a claim with no verbatim quote, a supersession with no
 * reason — would otherwise cost a full verifier round to discover.
 */

import {
  type RelationRecord,
  phasesAt,
  renderHistory,
  validateRelationRecord,
} from "../index/relations.ts";
import type { ProposedClaim, SceneDelta } from "../verification/deterministic.ts";
import {
  ALL_ROLES,
  type FieldError,
  type ToolSpec,
  ToolRefusal,
} from "./registry.ts";

export interface RelationHistoryArgs {
  readonly pairId: string;
  /**
   * Restrict to phases in force at this scene. Omit to get the whole history —
   * which is the point of the record, so the default is the full view.
   */
  readonly atScene?: string;
}

export function relationHistoryTool(
  load: (pairId: string) => Promise<RelationRecord | null>,
): ToolSpec<RelationHistoryArgs, string> {
  return {
    name: "read_relation_history",
    description:
      "How a pair's relationship reached its current state: every phase in order, " +
      "with what caused each change, any asymmetry between the two views, and the " +
      "scene each phase came from. Pass at_scene to see only what is in force then.",
    mutates: false,
    allowedRoles: ALL_ROLES,
    validate: (args) => {
      const errors: FieldError[] = [];
      if (!args.pairId?.trim()) {
        errors.push({ path: "pairId", problem: "required, e.g. mira--warden" });
      } else if (!args.pairId.includes("--")) {
        errors.push({
          path: "pairId",
          problem: `"${args.pairId}" is not a pair id; ids join two sorted entity ids with "--"`,
        });
      }
      if (args.atScene !== undefined && !/^s-\d{3,}$/.test(args.atScene)) {
        errors.push({
          path: "atScene",
          problem: `"${args.atScene}" is not a scene id, expected s-001 style`,
        });
      }
      return errors;
    },
    run: async (args) => {
      const record = await load(args.pairId);
      if (!record) {
        throw new ToolRefusal(
          `no relation record for ${args.pairId}. These two may never have shared a ` +
            `scene; if they have, the record was not written and that is a defect ` +
            `worth reporting rather than working around.`,
        );
      }
      validateRelationRecord(record);
      if (args.atScene === undefined) return renderHistory(record);

      const inForce = phasesAt(record, args.atScene);
      if (inForce.length === 0) {
        return (
          `${record.participants[0]} & ${record.participants[1]}: no phase is in ` +
          `force at ${args.atScene}. Their relationship either has not started or ` +
          `every phase covering this point was superseded.`
        );
      }
      // Same rendering as the full history, restricted: a writer comparing the
      // two views should not have to reconcile two formats.
      return renderHistory({ ...record, phases: inForce });
    },
  };
}

export interface ProposeStateDeltaArgs {
  readonly sceneId: string;
  readonly claims: readonly ProposedClaim[];
  readonly presentEntities: readonly string[];
}

export function proposeStateDeltaTool(
  stage: (delta: SceneDelta) => Promise<string> | string,
): ToolSpec<ProposeStateDeltaArgs, { readonly stagedAt: string; readonly claims: number }> {
  return {
    name: "propose_state_delta",
    description:
      "Declare what this scene changed about the world: one claim per fact, each " +
      "quoting the prose it comes from. Mark a deliberate overwrite with supersedes, " +
      "or it will be read as a continuity error.",
    mutates: true,
    // The writer proposes; only index-manager can land it. The verifier is
    // deliberately absent — a verifier that can edit the delta is grading its
    // own work.
    allowedRoles: ["writer"],
    validate: (args, context) => {
      const errors: FieldError[] = [];
      if (!/^s-\d{3,}$/.test(args.sceneId ?? "")) {
        errors.push({
          path: "sceneId",
          problem: `"${args.sceneId}" is not a scene id, expected s-001 style`,
        });
      }
      if (!Array.isArray(args.claims)) {
        errors.push({ path: "claims", problem: "required, an array of claims" });
        return errors;
      }
      // An empty delta is not a validation error here — it is refused at commit
      // time with a message about extraction, which is the more useful place to
      // say it.
      const seen = new Map<string, number>();
      args.claims.forEach((claim, i) => {
        const at = `claims[${i}]`;
        if (!claim.entity?.trim()) {
          errors.push({ path: `${at}.entity`, problem: "required: which entity this is about" });
        }
        if (!claim.attribute?.trim()) {
          errors.push({
            path: `${at}.attribute`,
            problem: "required: which property of it, e.g. eye_colour, location",
          });
        }
        if (claim.value === undefined || claim.value === null || claim.value === "") {
          errors.push({ path: `${at}.value`, problem: "required: the established value" });
        }
        if (!claim.quote?.trim()) {
          // Without a quote the claim cannot be audited, cannot be located for a
          // repair, and cannot become a contradiction pair later.
          errors.push({
            path: `${at}.quote`,
            problem: "required: verbatim prose from this scene that establishes the claim",
          });
        }
        if (claim.supersedes && !claim.supersedes.reason?.trim()) {
          errors.push({
            path: `${at}.supersedes.reason`,
            problem:
              "a deliberate overwrite needs its reason recorded, otherwise a later " +
              "reader cannot tell it from a mistake",
          });
        }
        const key = `${claim.entity}\u0000${claim.attribute}`;
        const first = seen.get(key);
        if (first !== undefined) {
          errors.push({
            path: `${at}`,
            problem:
              `duplicates claims[${first}] (same entity and attribute); the scene ` +
              `must settle on one value before proposing it`,
          });
        } else {
          seen.set(key, i);
        }
      });
      if (!Array.isArray(args.presentEntities)) {
        errors.push({
          path: "presentEntities",
          problem: "required, the entity ids the scene says are present",
        });
      }
      if (context.txid && args.sceneId && errors.length === 0) {
        // Nothing further to check here; the cross-checks against canon belong
        // to the deterministic verifier, which sees the whole index.
      }
      return errors;
    },
    run: async (args) => ({
      stagedAt: await stage({
        sceneId: args.sceneId,
        claims: args.claims,
        presentEntities: args.presentEntities,
      }),
      claims: args.claims.length,
    }),
  };
}
