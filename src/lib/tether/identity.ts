// Identity: people merge automatically ONLY on an exact email, compared as HMAC-SHA256
// with the identity key. Name matches are suggestions, never merges.
import { createHmac } from "node:crypto";
import type { Person } from "@/lib/types";

export interface MergeSuggestion {
  a: string; // Person.id
  b: string; // Person.id
  reason: string;
}

export function emailHmac(identityKey: string, email: string): string {
  return createHmac("sha256", identityKey).update(email.trim().toLowerCase()).digest("hex");
}

function nameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export class PersonRegistry {
  private people: Person[] = [];
  private byHmac = new Map<string, Person>();
  private byScopedName = new Map<string, Person>();
  private contactTokens = new Map<string, string>();
  private contactCounter = 0;
  private suggestionList: MergeSuggestion[] = [];
  private suggestionKeys = new Set<string>();

  constructor(private readonly identityKey: string) {
    if (!identityKey) throw new Error("PersonRegistry needs an identity key (env IDENTITY_KEY)");
  }

  hmac(email: string): string {
    return emailHmac(this.identityKey, email);
  }

  /**
   * Create or return a Person. Same email (HMAC) -> same person. Without an email, the same
   * display name inside the same `scope` (usually the source id) is the same person; across
   * scopes a new person is created and a suggestion recorded.
   */
  resolve(input: { displayName: string; email?: string | null; scope?: string }): Person {
    const displayName = (input.displayName ?? "").trim() || "Unknown";
    const scope = input.scope ?? "";
    const scopedKey = `${scope}\u0000${nameKey(displayName)}`;
    const email = input.email?.trim();

    if (email) {
      const h = this.hmac(email);
      const hit = this.byHmac.get(h);
      if (hit) {
        this.addAlias(hit, displayName);
        if (!this.byScopedName.has(scopedKey)) this.byScopedName.set(scopedKey, hit);
        return hit;
      }
      const p = this.create(displayName, h);
      this.byHmac.set(h, p);
      if (!this.byScopedName.has(scopedKey)) this.byScopedName.set(scopedKey, p);
      return p;
    }

    const scoped = this.byScopedName.get(scopedKey);
    if (scoped) return scoped;
    const p = this.create(displayName, null);
    this.byScopedName.set(scopedKey, p);
    return p;
  }

  /** Person whose email HMAC matches, or null. Never creates. */
  lookupEmail(email: string): Person | null {
    return this.byHmac.get(this.hmac(email)) ?? null;
  }

  get(id: string): Person | null {
    return this.people.find((p) => p.id === id) ?? null;
  }

  /** Stable "c-<n>" token for a contact value that is not a known person. */
  contactToken(kind: "email" | "phone", value: string): string {
    const canon = kind === "phone" ? value.replace(/[^\d+]/g, "").replace(/^0+/, "") : value.trim().toLowerCase();
    const k = this.hmac(`${kind}:${canon}`);
    let t = this.contactTokens.get(k);
    if (!t) {
      t = `c-${++this.contactCounter}`;
      this.contactTokens.set(k, t);
    }
    return t;
  }

  suggestions(): MergeSuggestion[] {
    return this.suggestionList.map((s) => ({ ...s }));
  }

  all(): Person[] {
    return this.people.map((p) => ({ ...p, aliases: [...p.aliases] }));
  }

  private create(displayName: string, hmac: string | null): Person {
    const p: Person = { id: `p-${this.people.length + 1}`, displayName, emailHmac: hmac, aliases: [] };
    for (const other of this.people) this.maybeSuggest(other, p);
    this.people.push(p);
    return p;
  }

  private addAlias(p: Person, name: string): void {
    if (nameKey(name) !== nameKey(p.displayName) && !p.aliases.some((a) => nameKey(a) === nameKey(name))) {
      p.aliases.push(name);
    }
  }

  private maybeSuggest(a: Person, b: Person): void {
    const bothEmails = !!(a.emailHmac && b.emailHmac); // emails differ, or they would have merged
    const an = [a.displayName, ...a.aliases].map(nameKey);
    const bn = nameKey(b.displayName);
    let reason: string | null = null;
    if (an.includes(bn)) reason = bothEmails ? "same display name, different emails" : "same display name";
    else if (!bothEmails) {
      const bFirst = bn.split(" ")[0];
      const aFirsts = an.map((n) => n.split(" ")[0]);
      const oneWord = !bn.includes(" ") || an.some((n) => !n.includes(" "));
      if (bFirst.length >= 3 && oneWord && aFirsts.includes(bFirst)) reason = "first name matches";
    }
    if (!reason) return;
    const key = `${a.id}|${b.id}`;
    if (this.suggestionKeys.has(key)) return;
    this.suggestionKeys.add(key);
    this.suggestionList.push({ a: a.id, b: b.id, reason });
  }
}
