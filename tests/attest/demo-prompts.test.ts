// Regression: the demo's extraction prompts (and so their model cache keys) depend only on the demo
// data. Two demo workspaces built in one process (a warm serverless instance) get identical prompts,
// whatever the checkout's line endings (Windows CRLF vs Linux LF) or path separators.
import { describe, expect, it } from "vitest";
import { EXTRACT_MAX_CHARS } from "@/lib/attest";
import { planBatches } from "@/lib/attest/core/extract";
import { buildUserPrompt } from "@/lib/attest/core/prompts";
import { cacheKey } from "@/lib/model/client";
import { sourceIdFor } from "@/lib/pipeline/ingest";
import { loadDemoSources } from "@/lib/tether/demo";
import { ingestAll } from "@/lib/tether/ingest";
import { CLUB_DEMO_DIR, CLUB_ROLE_ORDER } from "../helpers/club";

function demoPrompts(transform: (content: string) => string = (c) => c) {
  const demo = loadDemoSources(CLUB_DEMO_DIR);
  const out = ingestAll(
    demo.map((d) => ({
      kind: d.kind,
      name: d.name,
      roleSet: d.roleSet,
      files: d.files.map((f) => ({ path: f.path, content: transform(f.content) })),
      sourceId: sourceIdFor(d.kind, d.name),
    })),
    { identityKey: "test-identity-key", contactsKey: "test-contacts-key" },
  );
  const names = Object.fromEntries(out.people.map((p) => [p.id, p.displayName]));
  const segments = out.sources.flatMap((s) => s.result.segments.map((seg) => ({ ...seg, sourceId: s.sourceId })));
  const batches = planBatches(segments, { roleOrder: CLUB_ROLE_ORDER, maxChars: EXTRACT_MAX_CHARS });
  const prompts = batches.map((b) => buildUserPrompt(b, { authorLabel: (id) => (id ? (names[id] ?? id) : "unknown") }));
  return { segments, prompts, keys: prompts.map((u) => cacheKey("tag", "system", u, "attest_claims")) };
}

describe("demo extraction prompts", () => {
  it("are identical for two demo workspaces built in one process", () => {
    const a = demoPrompts();
    const b = demoPrompts();
    expect(a.prompts.length).toBeGreaterThan(10);
    expect(b.prompts).toEqual(a.prompts);
    expect(b.keys).toEqual(a.keys);
  });

  it("do not depend on the checkout's line endings", () => {
    const lf = demoPrompts((c) => c.replace(/\r\n/g, "\n"));
    const crlf = demoPrompts((c) => c.replace(/\r?\n/g, "\r\n"));
    expect(crlf.keys).toEqual(lf.keys);
  });

  it("never put a backslash in a thread or file path", () => {
    const { segments } = demoPrompts();
    for (const d of loadDemoSources(CLUB_DEMO_DIR)) for (const f of d.files) expect(f.path).not.toContain("\\");
    for (const s of segments) expect(s.thread, s.id).not.toContain("\\");
  });
});
