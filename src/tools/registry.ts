/**
 * The tool registry: who may call what, and what comes back when they get it
 * wrong.
 *
 * Two decisions from `docs/02-architecture.md` §2 are enforced here rather than
 * asked for in a prompt.
 *
 * **Read authority is uniform, write authority is not.** Every agent gets the
 * same reach over the index — none is a second-class citizen with a narrower
 * view — and what differs is only who may change canonical state. A tool
 * therefore declares `mutates` plus the roles allowed to call it, and the
 * registry refuses the rest. `index-manager` is the sole caller of the commit
 * path; the verifier writes findings and never prose.
 *
 * **A mutating tool validates synchronously and answers with per-field
 * errors.** The v2 loop made the writer wait a full verifier round to learn
 * that its state delta was malformed, which spent a repair round on something a
 * schema check settles for free. A rejected call here returns `ok: false` with
 * the field paths, so the caller fixes it in the same turn.
 */

import type { AgentRole } from "../transaction/types.ts";

/** One thing wrong with a call, addressed to a specific field. */
export interface FieldError {
  /** Dotted path into the arguments, e.g. "claims[2].quote". */
  readonly path: string;
  readonly problem: string;
}

export type ToolResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: "FORBIDDEN" | "INVALID_ARGUMENTS" | "REFUSED";
      readonly message: string;
      /** Empty for FORBIDDEN and REFUSED; populated for INVALID_ARGUMENTS. */
      readonly errors: readonly FieldError[];
    };

export interface ToolContext {
  readonly role: AgentRole;
  readonly txid: string;
}

export interface ToolSpec<A, R> {
  readonly name: string;
  /** One line; this is what the model sees in the tool list. */
  readonly description: string;
  /** True when the call changes canonical state or staging. */
  readonly mutates: boolean;
  readonly allowedRoles: readonly AgentRole[];
  /**
   * Validate arguments and say what is wrong with them, field by field.
   * Returning an empty array means the arguments are acceptable.
   */
  readonly validate: (args: A, context: ToolContext) => readonly FieldError[];
  readonly run: (args: A, context: ToolContext) => Promise<R> | R;
}

export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolSpec<never, unknown>>();

  register<A, R>(spec: ToolSpec<A, R>): this {
    if (this.#tools.has(spec.name)) {
      throw new Error(`tool ${spec.name} is already registered`);
    }
    if (spec.allowedRoles.length === 0) {
      throw new Error(`tool ${spec.name} would be callable by nobody`);
    }
    // A read tool restricted to a subset of roles contradicts the uniform-read
    // rule, and the mistake is easy to make one tool at a time.
    if (!spec.mutates && spec.allowedRoles.length !== ALL_ROLES.length) {
      throw new Error(
        `${spec.name} only reads, so every role must be allowed to call it; ` +
          `write authority is what differs between roles, not read reach`,
      );
    }
    this.#tools.set(spec.name, spec as unknown as ToolSpec<never, unknown>);
    return this;
  }

  /** Tool names a role may call, which is what its tool allowlist is built from. */
  namesFor(role: AgentRole): readonly string[] {
    return [...this.#tools.values()]
      .filter((t) => t.allowedRoles.includes(role))
      .map((t) => t.name)
      .sort();
  }

  async call<R>(
    name: string,
    args: unknown,
    context: ToolContext,
  ): Promise<ToolResult<R>> {
    const spec = this.#tools.get(name);
    if (!spec) {
      return {
        ok: false,
        code: "REFUSED",
        message: `no tool named ${name}`,
        errors: [],
      };
    }
    if (!spec.allowedRoles.includes(context.role)) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message:
          `${context.role} may not call ${name}; it is restricted to ` +
          `${spec.allowedRoles.join(", ")}`,
        errors: [],
      };
    }

    const errors = spec.validate(args as never, context);
    if (errors.length > 0) {
      return {
        ok: false,
        code: "INVALID_ARGUMENTS",
        // Naming the fields is the entire point: this is the cheapest feedback
        // signal in the system and it arrives in the same turn.
        message: `${name} rejected ${errors.length} argument problem(s)`,
        errors,
      };
    }

    try {
      return { ok: true, value: (await spec.run(args as never, context)) as R };
    } catch (error) {
      if (error instanceof ToolRefusal) {
        return { ok: false, code: "REFUSED", message: error.message, errors: [] };
      }
      throw error;
    }
  }
}

export const ALL_ROLES: readonly AgentRole[] = [
  "orchestrator",
  "index-manager",
  "context-builder",
  "writer",
  "verifier",
];
