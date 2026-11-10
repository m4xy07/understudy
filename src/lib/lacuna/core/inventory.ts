// Responsibility inventory (ARCHITECTURE section 4): task board + leaver footprint + role template,
// merged by entity. Pure: no database, no model.
import type { Responsibility, ResponsibilityKind, ResponsibilityOrigin, RoleKey, Segment } from "@/lib/types";
import { norm, sha256Hex } from "@/lib/text/norm";
import { checklistForKind, KIND_ORDER } from "./checks";
import type { LacunaPack, PackEntity } from "./pack";

/** A footprint hit from Tether. */
export interface FootprintCandidate {
  entityKey: string;
  rule: string;
  evidenceSegmentIds: string[];
  detail: string;
}

export interface BuildInventoryInput {
  workspaceId: string;
  tasks: readonly Segment[];
  footprint: readonly FootprintCandidate[];
  pack: LacunaPack;
  successorRole: RoleKey;
  /** ISO date or date-time; "recently active" means updated within 30 days of this. */
  today: string;
}

export const RECENT_DAYS = 30;
const DAY_MS = 86_400_000;
const DONE_STATUSES = new Set(["done", "closed", "complete", "completed", "resolved", "cancelled", "canceled", "archived"]);

// Spec order matters: first matching rule wins.
const KIND_RULES: readonly [ResponsibilityKind, RegExp][] = [
  ["deploy_operate", /\b(deploy\w*|infra\w*|devops|ops|pipeline|ci|server\w*|hosting)\b/],
  ["external_relationship", /\b(sponsor\w*|vendor\w*|contact\w*|supplier\w*|partner\w*|outreach)\b/],
  ["recurring_obligation", /\b(renew\w*|book\w*|fees?|weekly|monthly|terms?|termly|yearly|annual\w*|subscription\w*)\b/],
  ["open_decision", /\b(decide\w*|decision\w*|choose|chosen|select\w*|venue\w*|vote)\b/],
];

const ORIGIN_RANK: Record<ResponsibilityOrigin, number> = { task_board: 0, footprint: 1, role_template: 2 };
const ORIGIN_LABEL: Record<ResponsibilityOrigin, string> = {
  task_board: "Task board",
  footprint: "Footprint",
  role_template: "Role template",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function labelsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).map((s) => s.trim()).filter(Boolean);
  return str(v).split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
}

function parseTime(v: string): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** ISO date (YYYY-MM-DD) or null. */
function isoDate(v: string): string | null {
  const t = parseTime(v);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTerm(haystack: string, term: string): boolean {
  const t = norm(term);
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(t)}($|[^a-z0-9])`).test(haystack);
}

/** Best pack entity for a piece of text: most distinct alias hits, then longest alias, then pack order. */
export function matchEntity(text: string, entities: readonly PackEntity[]): PackEntity | null {
  const h = norm(text);
  let best: { e: PackEntity; hits: number; longest: number } | null = null;
  for (const e of entities) {
    const terms = [...new Set([...e.aliases, e.key, e.key.replace(/-/g, " ")])];
    let hits = 0;
    let longest = 0;
    for (const term of terms) {
      if (containsTerm(h, term)) {
        hits++;
        longest = Math.max(longest, norm(term).length);
      }
    }
    if (hits === 0) continue;
    if (!best || hits > best.hits || (hits === best.hits && longest > best.longest)) best = { e, hits, longest };
  }
  return best?.e ?? null;
}

/** Kind from labels/keywords (first matching rule), or null when nothing matches. */
export function guessKind(text: string): ResponsibilityKind | null {
  const h = norm(text);
  for (const [kind, re] of KIND_RULES) if (re.test(h)) return kind;
  return null;
}

function footprintKind(c: FootprintCandidate, entityText: string): ResponsibilityKind | null {
  const rule = norm(c.rule);
  if (/sole.?contact|external/.test(rule)) return "external_relationship";
  if (/schedule|calendar|cron|renewal|recurring/.test(rule)) return "recurring_obligation";
  if (/credential|secret|access/.test(rule)) return "deploy_operate";
  return guessKind(`${entityText} ${c.detail}`);
}

interface Item {
  origin: ResponsibilityOrigin;
  entities: string[];
  title: string;
  detail: string;
  kindExplicit: ResponsibilityKind | null; // role template kind
  kindGuess: ResponsibilityKind | null;
  dueDate: string | null;
  overrideKeys: string[];
}

export function isOpenOrRecent(task: Segment, today: string): boolean {
  const status = norm(str(task.meta.status));
  if (!DONE_STATUSES.has(status)) return true;
  const now = parseTime(today);
  const updated = parseTime(str(task.meta.updated_at)) ?? parseTime(task.ts);
  if (now === null || updated === null) return false;
  return now - updated <= RECENT_DAYS * DAY_MS;
}

function boardItems(input: BuildInventoryInput): Item[] {
  const groups = new Map<string, { entity: PackEntity | null; cards: Segment[] }>();
  for (const t of input.tasks) {
    if (t.kind !== "task") continue;
    if (!isOpenOrRecent(t, input.today)) continue;
    const id = str(t.meta.id) || t.id;
    const labels = labelsOf(t.meta.labels);
    const entity = matchEntity(`${str(t.meta.title)} ${labels.join(" ")}`, input.pack.entities);
    const key = entity ? entity.key : `task-${id}`;
    const g = groups.get(key) ?? { entity, cards: [] };
    g.cards.push(t);
    groups.set(key, g);
  }
  const items: Item[] = [];
  for (const [key, g] of groups) {
    const ids = g.cards.map((c) => str(c.meta.id) || c.id);
    const text = g.cards.map((c) => `${str(c.meta.title)} ${labelsOf(c.meta.labels).join(" ")}`).join(" ");
    const open = g.cards.filter((c) => !DONE_STATUSES.has(norm(str(c.meta.status))));
    const dues = (open.length > 0 ? open : g.cards)
      .map((c) => isoDate(str(c.meta.due)))
      .filter((d): d is string => d !== null)
      .sort();
    const title = g.cards.length === 1 ? str(g.cards[0].meta.title) || key : g.entity?.label ?? key;
    items.push({
      origin: "task_board",
      entities: [key],
      title,
      detail: `${ids.length === 1 ? "card" : "cards"} ${ids.join(", ")}`,
      kindExplicit: null,
      kindGuess: guessKind(text) ?? (g.entity ? guessKind(`${g.entity.label} ${g.entity.aliases.join(" ")}`) : null),
      dueDate: dues[0] ?? null,
      overrideKeys: [key, ...ids, ...ids.map((i) => `task-${i}`)],
    });
  }
  return items;
}

function footprintItems(input: BuildInventoryInput): Item[] {
  const byEntity = new Map<string, FootprintCandidate[]>();
  for (const c of input.footprint) {
    const list = byEntity.get(c.entityKey) ?? [];
    list.push(c);
    byEntity.set(c.entityKey, list);
  }
  const items: Item[] = [];
  for (const [key, cands] of byEntity) {
    const entity = input.pack.entities.find((e) => e.key === key) ?? null;
    const entityText = entity ? `${entity.label} ${entity.aliases.join(" ")}` : key.replace(/-/g, " ");
    let kindGuess: ResponsibilityKind | null = null;
    for (const c of cands) {
      kindGuess = footprintKind(c, entityText);
      if (kindGuess) break;
    }
    items.push({
      origin: "footprint",
      entities: [key],
      title: entity?.label ?? (cands[0].detail || key),
      detail: [...new Set(cands.map((c) => c.rule))].join(", "),
      kindExplicit: null,
      kindGuess,
      dueDate: null,
      overrideKeys: [key],
    });
  }
  return items;
}

function templateItems(input: BuildInventoryInput): Item[] {
  const list = input.pack.roleTemplates?.[input.successorRole] ?? [];
  return list.map((t) => ({
    origin: "role_template" as const,
    entities: t.entities.length > 0 ? [...t.entities] : [`template-${t.key}`],
    title: t.title,
    detail: t.key,
    kindExplicit: t.kind,
    kindGuess: null,
    dueDate: t.dueDate ? isoDate(t.dueDate) : null,
    overrideKeys: [...t.entities],
  }));
}

/** Union items that share any entity key. Keeps first-seen order. */
function mergeByEntity(items: Item[]): Item[][] {
  const groups: Item[][] = [];
  const entityGroup = new Map<string, number>();
  for (const item of items) {
    const hit = [...new Set(item.entities.map((e) => entityGroup.get(e)).filter((g): g is number => g !== undefined))];
    if (hit.length === 0) {
      groups.push([item]);
      for (const e of item.entities) entityGroup.set(e, groups.length - 1);
      continue;
    }
    const target = Math.min(...hit);
    groups[target].push(item);
    for (const other of hit.filter((g) => g !== target).sort((a, b) => b - a)) {
      groups[target].push(...groups[other]);
      groups[other] = [];
    }
    for (const g of groups[target]) for (const e of g.entities) entityGroup.set(e, target);
  }
  return groups.filter((g) => g.length > 0);
}

function kindWeight(kind: ResponsibilityKind, pack: LacunaPack): [number, number] {
  const checks = checklistForKind(kind, pack);
  const blocking = checks.filter((c) => c.weight === 5);
  return [blocking.length, blocking.reduce((s, c) => s + c.weight, 0)];
}

/**
 * Entity keys with the pack's part-of links applied: a part maps to its whole, and a whole
 * brings its parts along (so claims on either count toward one responsibility).
 */
export function expandEntities(entities: readonly string[], packEntities: readonly PackEntity[]): string[] {
  const parent = new Map(packEntities.filter((e) => e.partOf && e.partOf !== e.key).map((e) => [e.key, e.partOf as string]));
  const root = (k: string): string => {
    const seen = new Set<string>();
    let cur = k;
    while (parent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parent.get(cur)!;
    }
    return cur;
  };
  const out: string[] = [];
  const add = (k: string) => { if (!out.includes(k)) out.push(k); };
  for (const e of entities) {
    const r = root(e);
    add(r);
    for (const [child] of parent) if (child !== r && root(child) === r) add(child);
    add(e);
  }
  return out;
}

export function buildInventory(input: BuildInventoryInput): Responsibility[] {
  const all = [...boardItems(input), ...footprintItems(input), ...templateItems(input)];
  if (input.pack.entities.some((e) => e.partOf)) {
    for (const item of all) {
      item.entities = expandEntities(item.entities, input.pack.entities);
      const whole = input.pack.entities.find((e) => e.key === item.entities[0]);
      if (item.origin === "footprint" && whole) item.title = whole.label;
    }
  }
  const overrides = input.pack.kindOverrides ?? {};

  const drafts = mergeByEntity(all).map((group) => {
    const sorted = [...group].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin]);
    const strongest = sorted[0];
    const template = sorted.find((i) => i.origin === "role_template");
    const entities = [...new Set(sorted.flatMap((i) => i.entities))];

    let kind: ResponsibilityKind | undefined;
    for (const k of sorted.flatMap((i) => i.overrideKeys)) {
      if (overrides[k]) { kind = overrides[k]; break; }
    }
    kind ??= template?.kindExplicit
      ?? sorted.find((i) => i.kindGuess)?.kindGuess
      ?? "unfinished_work";

    const dues = sorted.map((i) => i.dueDate).filter((d): d is string => d !== null).sort();
    const originDetail = sorted.map((i) => `${ORIGIN_LABEL[i.origin]}: ${i.detail}`).join(" · ");
    return {
      entities,
      title: template?.title ?? strongest.title,
      kind,
      origin: strongest.origin,
      originDetail,
      dueDate: dues[0] ?? null,
    };
  });

  const weightCache = new Map<ResponsibilityKind, [number, number]>();
  const kw = (k: ResponsibilityKind) => {
    if (!weightCache.has(k)) weightCache.set(k, kindWeight(k, input.pack));
    return weightCache.get(k)!;
  };
  drafts.sort((a, b) => {
    const [ab, aw] = kw(a.kind);
    const [bb, bw] = kw(b.kind);
    if (ab !== bb) return bb - ab;
    if (aw !== bw) return bw - aw;
    const ko = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (ko !== 0) return ko;
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    return a.entities[0] < b.entities[0] ? -1 : a.entities[0] > b.entities[0] ? 1 : 0;
  });

  return drafts.map((d, i) => ({
    id: `resp_${sha256Hex(`${input.workspaceId}|${[...d.entities].sort().join(",")}`).slice(0, 16)}`,
    workspaceId: input.workspaceId,
    key: `R${String(i + 1).padStart(2, "0")}`,
    title: d.title,
    kind: d.kind,
    entities: d.entities,
    origin: d.origin,
    originDetail: d.originDetail,
    dueDate: d.dueDate,
    confirmed: false,
  }));
}
