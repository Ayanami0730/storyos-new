/**
 * Choosing a backend, and being honest about which one you got.
 *
 * Falling back silently would be the worst of the options here. A run that
 * asked for `docker`, found no daemon and quietly used prompt enforcement would
 * report a guarantee it does not have — and the whole reason this layer exists
 * is that "the write gate is OS-enforced" should be a checked fact rather than
 * an intention. So a fallback is loud, and the summary records the backend that
 * actually ran together with the probe that demonstrated its gate.
 */

import { DockerSandbox, DockerUnavailable, dockerAvailable } from "./docker.ts";
import { LocalSandbox } from "./local.ts";
import type { SandboxBackend, SandboxId } from "./types.ts";

/**
 * The null backend: the shell runs on the host with nothing between it and the
 * tree, and the only thing stopping a write is our own refusal list.
 *
 * Kept because it is what every run before this used, so it is the control arm
 * for "does confinement cost anything". It says `prompt` for enforcement, which
 * is the truth and reads as the weak claim it is.
 */
class NoSandbox implements SandboxBackend {
  readonly id = "none" as const;
  readonly enforcement = "prompt" as const;
  readonly shell = {
    exec: async () => {
      throw new Error("the `none` backend does not route the shell; pi's own env is used");
    },
  };
  async withWriteAccess<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async probe() {
    return {
      writeRefused: false,
      detail:
        "no sandbox: canonical state is protected by the shell policy's refusal list only, " +
        "which is a claim about the commands we thought of",
    };
  }
  async dispose(): Promise<void> {}
}

export interface SelectionResult {
  readonly backend: SandboxBackend;
  /** Set when the requested backend was unavailable and something else ran. */
  readonly fellBackFrom: SandboxId | null;
  readonly reason: string | null;
}

export async function selectSandbox(
  requested: SandboxId,
  root: string,
): Promise<SelectionResult> {
  if (requested === "none") {
    return { backend: new NoSandbox(), fellBackFrom: null, reason: null };
  }

  if (requested === "docker") {
    if (await dockerAvailable()) {
      const backend = new DockerSandbox({ root });
      try {
        await backend.start();
        return { backend, fellBackFrom: null, reason: null };
      } catch (error) {
        if (!(error instanceof DockerUnavailable)) throw error;
        const local = new LocalSandbox(root);
        await local.engage();
        return {
          backend: local,
          fellBackFrom: "docker",
          reason: error.message,
        };
      }
    }
    const local = new LocalSandbox(root);
    await local.engage();
    return {
      backend: local,
      fellBackFrom: "docker",
      reason: "no docker daemon is reachable",
    };
  }

  const local = new LocalSandbox(root);
  await local.engage();
  return { backend: local, fellBackFrom: null, reason: null };
}
