// Shared types for Understudy. The contract is docs/ARCHITECTURE.md.
// Only the foundation owns this file; other modules propose changes.

export type RoleKey = "president" | "tech_lead" | "new_member" | "treasurer" | "leaver";

export type SourceKind = "whatsapp" | "slack" | "github" | "tasks_csv" | "markdown" | "ics" | "interview";

export type SegmentKind = "message" | "commit" | "file" | "task" | "note" | "event" | "answer";

export type Attribute =
  | "owner" | "status" | "deadline" | "location" | "procedure" | "access"
  | "decision" | "reason" | "dependency" | "contact" | "risk";

export const MULTI_VALUED: readonly Attribute[] = ["reason", "dependency", "contact"];

export type Trust = "from_record" | "corroborated" | "leaver_said" | "second_hand" | "inferred" | "ranked_options";

export type ClaimState = "active" | "superseded" | "conflicting" | "dropped";

export type Coverage = "covered" | "partial" | "missing" | "restricted" | "conflicting";

export type Importance = "normal" | "important" | "blocking";

export type ReviewTier = "A" | "B" | "C";

export type ReviewState = "pending" | "approved" | "edited" | "rejected";

export type ResponsibilityKind =
  | "deploy_operate" | "external_relationship" | "recurring_obligation" | "open_decision" | "unfinished_work";

export type ResponsibilityOrigin = "task_board" | "footprint" | "role_template";

export type WTag = "WHO" | "WHERE" | "HOW" | "WHY" | "WHEN";

export interface Person {
  id: string;                // "p-<n>", stable within a workspace
  displayName: string;       // shown only in UI, never used for IDs
  emailHmac: string | null;  // HMAC-SHA256 of the lowercased email, or null
  aliases: string[];         // other display names seen across sources
}

export interface Segment {
  id: string;                // seg_ + 16 hex, see ARCHITECTURE section 4
  sourceId: string;
  sourceKind: SourceKind;
  kind: SegmentKind;
  ts: string;                // ISO 8601
  authorId: string | null;   // Person.id
  thread: string;            // chat/channel name, file path, board name, calendar name
  position: number;          // order within the thread (ties only)
  text: string;              // already masked
  textHash: string;          // sha256 of norm(text), hex
  roleSet: RoleKey[];
  version: number;
  meta: Record<string, unknown>; // e.g. task fields, replyTo segment id, commit sha, file path
}

export interface RejectedRow {
  line: number;
  raw: string;
  reason: string;
}

export interface AdapterResult {
  segments: Segment[];
  people: Person[];
  rejected: RejectedRow[];
  maskedSecrets: number;
  maskedContacts: number;
}

export interface Source {
  id: string;
  workspaceId: string;
  kind: SourceKind;
  name: string;
  roleSet: RoleKey[];
  segmentCount: number;
  rejected: RejectedRow[];
  maskedSecrets: number;
  maskedContacts: number;
  importedAt: string;
}

export interface Citation {
  segmentId: string;
  quote: string | null;
  accepted: boolean;         // set by the verifier, never by the model
  exact: boolean;            // norm(quote) found in norm(segment)
}

export interface Claim {
  id: string;
  workspaceId: string;
  entity: string;            // normalised key, e.g. "firmware-deploy"
  entityLabel: string;       // human label, e.g. "Firmware deploy to the robot"
  attribute: Attribute;
  value: string;
  statement: string;         // the one sentence shown to people
  citations: Citation[];
  trust: Trust;
  state: ClaimState;
  stateNote: string | null;  // rule that fired, e.g. "Superseded: task board owns deadlines"
  supersededBy: string | null;
  roleSet: RoleKey[];        // intersection of cited segments' role sets
  validFrom: string;         // ISO time of the newest cited segment
  authorId: string | null;
  sourceKinds: SourceKind[];
  importance: Importance;
  tier: ReviewTier;
  review: ReviewState;
  reviewNote: string | null;
  origin: "extracted" | "structured" | "leaver_answer";
  supportCheck: "yes" | "partly" | "no" | null;
}

export interface CheckDef {
  key: string;               // e.g. "rollback"
  label: string;             // e.g. "Rollback"
  wTag: WTag;
  weight: 1 | 3 | 5;
  attributes: Attribute[];   // attributes that can satisfy this check
}

export interface Responsibility {
  id: string;
  workspaceId: string;
  key: string;               // "R01"
  title: string;
  kind: ResponsibilityKind;
  entities: string[];        // claim entity keys this responsibility covers
  origin: ResponsibilityOrigin;
  originDetail: string;      // rule that fired or card id
  dueDate: string | null;
  confirmed: boolean;
}

export interface CheckResult {
  responsibilityId: string;
  checkKey: string;
  coverage: Coverage;
  claimIds: string[];
  bestTrust: Trust | null;
  note: string;              // what stops the successor, or why restricted
}

export interface Scores {
  b: number;
  c: number;                 // 0..1
  k: number | null;          // 0..1, null when nothing is covered
}

export interface TestRun {
  id: string;
  workspaceId: string;
  role: RoleKey;
  createdAt: string;
  scores: Scores;
  results: CheckResult[];
  provisional: boolean;
  modelUsed: boolean;
}

export interface GapQuestion {
  id: string;
  workspaceId: string;
  rank: number;
  responsibilityId: string;
  checkKey: string;
  gapType: "missing" | "partial" | "conflicting";
  text: string;
  score: number;             // weight x uncertainty x urgency
  answeredClaimId: string | null;
}

export interface PlanItem {
  responsibilityId: string;
  checkKey: string;
  owner: string;
  dueDate: string;
  riskNote: string;
}

export interface Snapshot {
  id: string;
  workspaceId: string;
  version: number;
  hash: string;              // sha256 hex of the canonical payload
  approvedBy: RoleKey;       // always "president"
  approvedAt: string;
  claimIds: string[];
  openBlocking: number;
  plan: PlanItem[];
}

export interface ReadbackItem {
  key: string;               // from the pack
  label: string;
  type: "date" | "text" | "contact" | "command";
  expectedClaimId: string | null;
}

export interface ReadbackVerdict {
  key: string;
  typed: string;
  normalised: string;
  expected: string | null;   // null when this role may not see it
  verdict: "match" | "mismatch" | "not_visible";
}
