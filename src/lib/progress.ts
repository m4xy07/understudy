// Which of the seven steps are done, and the one-line "what to do next" hint.
import { db } from "@/lib/db/client";
import { leaverName } from "@/lib/lacuna/adapt";
import { roleLabel, roleShort, type ResolvedPack } from "@/lib/pack";

export type StepKey = "connect" | "claims" | "verify" | "test" | "ask" | "review" | "handover";

export interface StepInfo {
  key: StepKey;
  label: string;
  href: string;        // path segment under /w/[id]
  module: "tether" | "attest" | "lacuna" | "relay";
  done: boolean;
  hint: string;
}

export interface Progress {
  steps: StepInfo[];
  next: StepInfo | null;
  /** True while the approver has marked the leaver as unreachable. */
  recovery: boolean;
}

type HintPack = Pick<ResolvedPack, "roles" | "leaverRole" | "leaverPerson">;

/**
 * The Ask step's hint. Recovery on (the approver marked the leaver as unreachable): the leaver's
 * answer boxes are closed, so the hint points at the people the Ask page lists instead of telling
 * the viewer to switch to the leaver. Otherwise: switch to the leaver and answer, or just answer
 * when already viewing as the leaver.
 */
export function askHint(pack: HintPack, opts: { recovery: boolean; viewerIsLeaver?: boolean }): string {
  if (opts.recovery) {
    return `${leaverName(pack) || "The leaver"} is marked as unreachable: ask the people listed on the Ask page.`;
  }
  if (opts.viewerIsLeaver) return "Answer a gap question.";
  return `Switch to ${roleShort(pack.leaverRole, pack as ResolvedPack)} (leaver) and answer a gap question.`;
}

export async function getProgress(ws: string, pack: ResolvedPack): Promise<Progress> {
  const [r] = await db()`
    SELECT
      (SELECT count(*)::int FROM sources WHERE workspace_id = ${ws} AND kind NOT IN ('interview', 'finding')) AS sources,
      (SELECT count(*)::int FROM claims WHERE workspace_id = ${ws}) AS claims,
      (SELECT count(*)::int FROM claim_events WHERE workspace_id = ${ws} AND event = 'verified') AS verified,
      (SELECT count(*)::int FROM test_runs WHERE workspace_id = ${ws}) AS tests,
      (SELECT count(*)::int FROM gap_questions WHERE workspace_id = ${ws}) AS questions,
      (SELECT count(*)::int FROM gap_questions WHERE workspace_id = ${ws} AND answered_claim_id IS NOT NULL) AS answered,
      (SELECT leaver_unreachable::int FROM workspaces WHERE id = ${ws}) AS recovery,
      (SELECT count(*)::int FROM recovery_steps WHERE workspace_id = ${ws} AND status IN ('answered', 'found')) AS recovered,
      (SELECT count(*)::int FROM snapshots WHERE workspace_id = ${ws}) AS snapshots,
      (SELECT count(*)::int FROM acknowledgements WHERE workspace_id = ${ws}) AS acks`;
  const n = (k: string) => Number(r?.[k] ?? 0);
  const recovery = n("recovery") > 0;
  // Recovery on: the step is done once a colleague answered or a trace was found (the leaver cannot answer).
  const asked = n("answered") > 0 || (n("tests") > 0 && n("questions") === 0) || (recovery && n("recovered") > 0);
  const steps: StepInfo[] = [
    { key: "connect", label: "Connect", href: "connect", module: "tether", done: n("sources") > 0,
      hint: "Add sources (or open a demo), then press Run Understudy." },
    { key: "claims", label: "Reconstruct", href: "claims", module: "attest", done: n("claims") > 0,
      hint: "Run Understudy to turn your sources into cited claims." },
    { key: "verify", label: "Verify", href: "claims?view=verify", module: "attest", done: n("verified") > 0 || (n("claims") > 0 && n("tests") > 0),
      hint: "Open a claim's citation to see the exact quote in its source." },
    { key: "test", label: "Test", href: "test", module: "lacuna", done: n("tests") > 0,
      hint: `See what ${roleShort(pack.successorRole, pack)} still could not do tomorrow.` },
    { key: "ask", label: "Ask", href: "ask", module: "lacuna", done: asked,
      hint: askHint(pack, { recovery }) },
    { key: "review", label: "Review", href: "review", module: "relay", done: n("snapshots") > 0,
      hint: `As ${roleLabel(pack.approverRole, pack)}, approve claims, plan open gaps, then approve the snapshot.` },
    { key: "handover", label: "Handover", href: "handover", module: "relay", done: n("acks") > 0,
      hint: "Switch roles to compare what each role's handover shows." },
  ];
  return { steps, next: steps.find((s) => !s.done) ?? null, recovery };
}
