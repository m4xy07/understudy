// Masking runs inside every adapter before a Segment is returned (ARCHITECTURE section 4).
// Secret values are discarded and replaced by [SECRET:<type>]; credential NAMES are kept.
// Emails and phones become [CONTACT:p-<n>] (known person) or [CONTACT:c-<n>]; the real value is
// returned AES-256-GCM encrypted for the contacts table.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ContactHit } from "@/lib/types";
import type { PersonRegistry } from "./identity";

export type { ContactHit };

export interface MaskContext {
  contactsKey: string;
  people?: PersonRegistry | null;
}

export interface MaskResult {
  text: string;
  secrets: number;
  secretTypes: string[];
  contacts: ContactHit[];
}

// ---------- contact encryption ----------

/** 32-byte key from CONTACTS_KEY: 64 hex chars, base64 of 32 bytes, or any passphrase (sha256). */
export function contactsKeyBytes(key: string): Buffer {
  const k = (key ?? "").trim();
  if (!k) throw new Error("contacts key is empty (env CONTACTS_KEY)");
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, "hex");
  if (/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(k)) {
    const b = Buffer.from(k, "base64");
    if (b.length === 32) return b;
  }
  return createHash("sha256").update(k).digest();
}

export function encryptContact(value: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contactsKeyBytes(key), iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptContact(valueEnc: string, key: string): string {
  const buf = Buffer.from(valueEnc, "base64");
  if (buf.length < 29) throw new Error("encrypted contact value is too short");
  const decipher = createDecipheriv("aes-256-gcm", contactsKeyBytes(key), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

// ---------- entropy ----------

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True for a 20+ char mixed alnum token that looks random (not a word, slug, hash or id). */
export function looksHighEntropy(tok: string): boolean {
  if (tok.length < 20) return false;
  if (!/[A-Za-z]/.test(tok) || !/[0-9]/.test(tok)) return false;
  if (/^[0-9a-fA-F-]+$/.test(tok) && tok.length <= 64) return false; // commit SHAs, hashes, UUIDs
  if (/^seg_[0-9a-f]{16}$/.test(tok)) return false; // our own segment ids
  const parts = tok.split(/[-_]+/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => p.length <= 12 && (/^[A-Za-z]+$/.test(p) || /^[0-9]+$/.test(p) || p.length <= 3))) {
    return false; // slugs like firmware-deploy-2026-v2, SNAKE_CASE_NAMES_2
  }
  const threshold = Math.min(4.0, Math.log2(tok.length) * 0.85);
  if (shannonEntropy(tok) < threshold) return false;
  const letters = tok.replace(/[^A-Za-z]/g, "");
  const vowels = letters.replace(/[^aeiouAEIOU]/g, "").length;
  const digits = tok.replace(/[^0-9]/g, "").length;
  return vowels / Math.max(1, letters.length) < 0.3 || digits >= 3;
}

// ---------- patterns ----------

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

const KNOWN_TOKENS: { re: RegExp; type: string }[] = [
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, type: "github_token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, type: "slack_token" },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, type: "aws_access_key" },
  { re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, type: "api_key" },
];

const AWS_SECRET = /(aws_secret(?:_access)?_key(?:_id)?["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi;

const ASSIGNMENT =
  /(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*["']?)([ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,;)\]}]+)/gi;

const KEY_NOT_SECRET = /(expir|rotat|renew|name|owner|holder|url|uri|path|file|ttl|count|type|length|endpoint|scope|header|location|ref|id$)/i;
const VALUE_PLACEHOLDER = /^(null|none|nil|true|false|redacted|<redacted>|\*+|x+|tbd|todo|n\/a|-)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE_INTL = /\+\d[\d \t().-]{6,18}\d/g;
const PHONE_IN = /(^|[^\d+\w])((?:0|91[ -]?)?[6-9]\d{4}[ -]?\d{5})(?!\d)/g;
const HIGH_ENTROPY = /[A-Za-z0-9+=_-]{20,}/g;

function secretTypeForKey(key: string): string {
  const k = key.toLowerCase();
  if (/pass|pwd/.test(k)) return "password";
  if (/api[_-]?key|apikey/.test(k)) return "api_key";
  if (/private[_-]?key/.test(k)) return "private_key";
  if (/access[_-]?key/.test(k)) return "access_key";
  if (/token/.test(k)) return "token";
  return "secret";
}

function isReferenceValue(v: string): boolean {
  return (
    v.startsWith("$") || v.startsWith("{") || v.startsWith("<") || v.startsWith("%") ||
    v.startsWith("[SECRET") || v.startsWith("[CONTACT") || v.includes("{{") || /^secrets\./i.test(v) ||
    /^env\./i.test(v) || /^process\.env/i.test(v)
  );
}

/** Mask secrets and contacts in `text`. Pure apart from random IVs. */
export function maskText(text: string, ctx: MaskContext): MaskResult {
  let out = text ?? "";
  let secrets = 0;
  const secretTypes: string[] = [];
  const contacts: ContactHit[] = [];
  const hit = (type: string) => {
    secrets++;
    secretTypes.push(type);
    return `[SECRET:${type}]`;
  };

  out = out.replace(PRIVATE_KEY, () => hit("private_key"));
  for (const { re, type } of KNOWN_TOKENS) out = out.replace(re, () => hit(type));
  out = out.replace(AWS_SECRET, (_m, keyPart: string) => keyPart.replace(/["']$/, "") + hit("aws_secret_key"));
  out = out.replace(ASSIGNMENT, (m, key: string, sep: string, rawVal: string, offset: number, whole: string) => {
    if (whole[offset - 1] === "[") return m; // our own [SECRET:x] / [CONTACT:x] placeholders
    const quoted = /^["']/.test(rawVal);
    const val = quoted ? rawVal.slice(1, -1).trim() : rawVal.trim();
    if (!val || val.length < 4 || VALUE_PLACEHOLDER.test(val) || isReferenceValue(val)) return m;
    if (KEY_NOT_SECRET.test(key.replace(/["']$/, ""))) return m;
    // prose after a colon ("token: rotate it yearly") is kept; config values are masked
    if (sep.includes(":") && !quoted && /^[a-z]+$/.test(val)) return m;
    if (/^\d{4}-\d{2}-\d{2}/.test(val)) return m;
    return key + sep + hit(secretTypeForKey(key));
  });

  // contacts
  const local = new Map<string, string>();
  let localN = 0;
  const contactFor = (kind: "email" | "phone", value: string): string => {
    let personId: string | null = null;
    let token: string;
    if (kind === "email" && ctx.people) personId = ctx.people.lookupEmail(value)?.id ?? null;
    if (personId) token = personId;
    else if (ctx.people) token = ctx.people.contactToken(kind, value);
    else {
      const k = `${kind}:${value.toLowerCase().replace(/[\s().-]/g, "")}`;
      token = local.get(k) ?? `c-${++localN}`;
      local.set(k, token);
    }
    const placeholder = `[CONTACT:${token}]`;
    contacts.push({ token: placeholder, kind, personId, valueEnc: encryptContact(value, ctx.contactsKey) });
    return placeholder;
  };

  out = out.replace(EMAIL, (m) => (/^git@/i.test(m) ? m : contactFor("email", m)));
  out = out.replace(PHONE_INTL, (m) => {
    const digits = m.replace(/\D/g, "").length;
    if (digits < 8 || digits > 15) return m;
    return contactFor("phone", m.trim());
  });
  out = out.replace(PHONE_IN, (_m, pre: string, num: string) => pre + contactFor("phone", num));

  out = out.replace(HIGH_ENTROPY, (m) => (looksHighEntropy(m) ? hit("high_entropy") : m));

  return { text: out, secrets, secretTypes, contacts };
}
