// What a browser may learn about a run. The runs row keeps the raw failure text of a step (a
// database error, a model endpoint's reply, a file path) for the team; the status sent to the
// client says that a step failed and what to do, never why in the server's own words.
import type { RunStatus, RunStep } from "@/lib/db/mappers";

export const STEP_FAILED_NOTE = "This step failed. What was read so far is kept; press Run again.";
export const RUN_FAILED_MESSAGE = "The run finished with errors. Failed steps are marked; press Run again to retry them.";

/** Messages the pipeline itself wrote for people: safe to show as they are. */
const OWN_MESSAGE = /^The run was stopped after \d+ slices\./;

function publicStep(step: RunStep): RunStep {
  return step.status === "failed" ? { ...step, note: STEP_FAILED_NOTE } : step;
}

/** The run status with every raw error message replaced by a fixed sentence. */
export function publicRun(run: RunStatus | null): RunStatus | null {
  if (!run) return null;
  const steps = Array.isArray(run.steps) ? run.steps.map(publicStep) : run.steps;
  if (!run.error) return { ...run, steps };
  const own = run.error.split("\n").filter((line) => OWN_MESSAGE.test(line));
  return { ...run, steps, error: own.length ? own.join("\n") : RUN_FAILED_MESSAGE };
}
