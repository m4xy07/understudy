// Pure orchestration: run several sources through one shared PersonRegistry (no DB).
import type { AdapterResult, Person, RoleKey, SourceKind } from "@/lib/types";
import { parseSource, type SourceFile } from "./adapters";
import { PersonRegistry, type MergeSuggestion } from "./identity";

export interface IngestInput {
  kind: SourceKind;
  name: string;
  roleSet: RoleKey[];
  files: SourceFile[];
  sourceId?: string;
}

export interface IngestOutput {
  sources: (IngestInput & { sourceId: string; result: AdapterResult })[];
  people: Person[];
  suggestions: MergeSuggestion[];
}

/**
 * Order matters for contact tokens: sources that carry emails (slack users, github, tasks)
 * should come before free text so that emails in messages resolve to [CONTACT:p-n].
 * `orderByIdentity` (default true) sorts sources that way, stable otherwise.
 */
export function ingestAll(
  inputs: IngestInput[],
  opts: { identityKey: string; contactsKey: string; registry?: PersonRegistry; now?: string; orderByIdentity?: boolean },
): IngestOutput {
  const people = opts.registry ?? new PersonRegistry(opts.identityKey);
  const rank: Record<SourceKind, number> = { slack: 0, github: 1, tasks_csv: 2, markdown: 3, ics: 4, whatsapp: 5, interview: 6, finding: 7 };
  const ordered = inputs.map((s, i) => ({ s, i }));
  if (opts.orderByIdentity !== false) ordered.sort((a, b) => rank[a.s.kind] - rank[b.s.kind] || a.i - b.i);
  const out = ordered.map(({ s, i }) => {
    const sourceId = s.sourceId ?? `src-${i + 1}`;
    const result = parseSource(s.kind, s.files, {
      sourceId,
      roleSet: s.roleSet,
      identityKey: opts.identityKey,
      contactsKey: opts.contactsKey,
      people,
      now: opts.now,
    });
    return { ...s, sourceId, result, i };
  });
  out.sort((a, b) => a.i - b.i);
  return {
    sources: out.map((o) => ({ kind: o.kind, name: o.name, roleSet: o.roleSet, files: o.files, sourceId: o.sourceId, result: o.result })),
    people: people.all(),
    suggestions: people.suggestions(),
  };
}
