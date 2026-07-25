/**
 * `read_skill` and `write_skill`.
 *
 * Two tools rather than one, and asymmetric on purpose: reading is how a skill
 * pays for itself, writing is how the library grows, and the write path has to
 * refuse the thing that would make the library useless — story state. A skill
 * that says "Araine is at the docks" is not a procedure, it is a fact with no
 * provenance, no schema and no verifier reading it.
 */

import { Type } from "typebox";

import { type SkillLibrary, SkillError } from "./skills.ts";

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

export interface SkillToolOptions {
  /** Refresh the prompt's skills section after a write. */
  readonly onChange?: () => Promise<void> | void;
  readonly knownEntities?: () => readonly string[];
}

export function skillTools(library: SkillLibrary, options: SkillToolOptions = {}): unknown[] {
  const knownEntities = options.knownEntities ?? (() => []);
  return [
    {
      label: "Read skill",
      name: "read_skill",
      description:
        "Open one of your skills in full, by its slug. Only the descriptions are in your " +
        "prompt; this is how you get the procedure.",
      parameters: Type.Object({ slug: Type.String() }),
      execute: async (_id: string, args: { slug: string }) => {
        const skill = await library.read(args.slug);
        if (!skill) {
          const all = await library.all();
          return toolText(
            `no skill ${JSON.stringify(args.slug)}. ` +
              (all.length > 0
                ? `You have: ${all.map((s) => s.slug).join(", ")}.`
                : `Your library is empty.`),
          );
        }
        return toolText(`# ${skill.name}\n\n${skill.description}\n\n${skill.body}`);
      },
    },
    {
      label: "Write skill",
      name: "write_skill",
      description:
        "Record a procedure that will be right again next time — an order to check things " +
        "in, a way to audit something. Reuse a slug to replace it. Not for facts about " +
        "this story, and not for what you learnt about this project (that is `remember`).",
      parameters: Type.Object({
        slug: Type.String({ description: "e.g. promise-payoff-audit" }),
        name: Type.String(),
        description: Type.String({ description: "One line; this is all that is loaded" }),
        body: Type.String({ description: "The procedure, as numbered steps" }),
        uses: Type.Optional(
          Type.Array(Type.String({ description: "Tools the procedure calls, for documentation" })),
        ),
      }),
      execute: async (
        _id: string,
        args: { slug: string; name: string; description: string; body: string; uses?: string[] },
      ) => {
        const haystack = `${args.name}\n${args.description}\n${args.body}`.toLowerCase();
        const mentioned = knownEntities().filter(
          (id) => id.length >= 3 && haystack.includes(id.toLowerCase()),
        );
        if (mentioned.length > 0) {
          return toolText(
            `rejected: mentions story entities (${mentioned.join(", ")}). A skill is a ` +
              `procedure that would be correct in a different story; anything specific to ` +
              `this one belongs in the index, or in memory if it is about how you work. ` +
              `Rewrite the steps so they hold for any scene.`,
          );
        }
        try {
          await library.write({
            slug: args.slug,
            name: args.name,
            description: args.description,
            body: args.body,
            ...(args.uses ? { uses: args.uses } : {}),
          });
        } catch (error) {
          if (error instanceof SkillError) return toolText(`rejected: ${error.message}`);
          throw error;
        }
        await options.onChange?.();
        return toolText(`skill ${args.slug} written. Its description is in your prompt from now on.`);
      },
    },
  ];
}
