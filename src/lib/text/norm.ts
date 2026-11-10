// Shared text normalisation (Tether segment hashes, Attest citation check).
// Contract: docs/ARCHITECTURE.md section 4.
import { createHash } from "node:crypto";

/**
 * norm(x) = lowercase(NFKC(x)) with markdown markup removed and whitespace collapsed.
 * Removed: `*`, `_`, backticks, leading `#` heading marks, link/image syntax `[t](u)` -> `t`.
 */
export function norm(x: string): string {
  let s = (x ?? "").normalize("NFKC");
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"); // [t](u) and ![t](u) -> t
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, ""); // heading marks at line start
  s = s.replace(/[*_`]/g, "");
  s = s.toLowerCase();
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}
