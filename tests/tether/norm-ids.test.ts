import { describe, expect, it } from "vitest";
import { norm, sha256Hex } from "@/lib/text/norm";
import { segmentId, parseDateLoose, toIstIso } from "@/lib/tether/ids";
import { parseWhatsapp } from "@/lib/tether/adapters";
import { ctx, fixture } from "./helpers";

describe("norm", () => {
  it("lowercases and applies NFKC", () => {
    expect(norm("ＡＢＣ ﬁle")).toBe("abc file");
  });
  it("removes markdown markup and collapses whitespace", () => {
    expect(norm("# Heading\n\n**Bold**  _it_ `code`\t[the link](https://x.example/a)")).toBe("heading bold it code the link");
    expect(norm("  ## Deploy  steps  ")).toBe("deploy steps");
    expect(norm("![alt text](img.png) end")).toBe("alt text end");
  });
  it("keeps the meaning of a quote: removing 'not' is not a substring", () => {
    const seg = "Do **not** flash the firmware before 6 pm.";
    expect(norm(seg).includes(norm("do not flash the firmware"))).toBe(true);
    expect(norm(seg).includes(norm("Do flash the firmware"))).toBe(false);
  });
  it("sha256Hex matches the standard vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("segment ids", () => {
  it("has the seg_ + 16 hex shape and depends on the text", () => {
    const a = segmentId("slack", "2026-08-12T21:14:00+05:30", "#general", 0, "hello");
    expect(a).toMatch(/^seg_[0-9a-f]{16}$/);
    expect(segmentId("slack", "2026-08-12T21:14:00+05:30", "#general", 0, "hello ")).toBe(a); // norm
    expect(segmentId("slack", "2026-08-12T21:14:00+05:30", "#general", 0, "hello!")).not.toBe(a);
    expect(segmentId("slack", "2026-08-12T21:14:00+05:30", "#general", 1, "hello")).not.toBe(a);
  });

  it("the same chat exported twice gives the same ids", () => {
    const files = fixture("whatsapp");
    const r1 = parseWhatsapp(files, ctx());
    const r2 = parseWhatsapp(files, ctx({ sourceId: "another-import" }));
    expect(r1.segments.length).toBeGreaterThan(0);
    expect(r2.segments.map((s) => s.id)).toEqual(r1.segments.map((s) => s.id));
  });

  it("changing a display name does not change ids", () => {
    const files = fixture("whatsapp");
    const renamed = files.map((f) => ({ ...f, content: f.content.replaceAll("Priya Nair", "Priya N. (old phone)") }));
    const r1 = parseWhatsapp(files, ctx());
    const r2 = parseWhatsapp(renamed, ctx());
    expect(r2.segments.map((s) => s.id)).toEqual(r1.segments.map((s) => s.id));
    expect(r2.segments.map((s) => s.textHash)).toEqual(r1.segments.map((s) => s.textHash));
  });
});

describe("dates", () => {
  it("formats in +05:30", () => {
    expect(toIstIso(Date.UTC(2026, 7, 12, 15, 44))).toBe("2026-08-12T21:14:00+05:30");
  });
  it("parses loose dates and rejects impossible ones", () => {
    expect(parseDateLoose("2026-12-15")).toBe("2026-12-15T00:00:00+05:30");
    expect(parseDateLoose("15/12/2026")).toBe("2026-12-15T00:00:00+05:30");
    expect(parseDateLoose("2026-08-12T10:00:00Z")).toBe("2026-08-12T15:30:00+05:30");
    expect(parseDateLoose("2026-02-30")).toBeNull();
    expect(parseDateLoose("2026-13-45")).toBeNull();
    expect(parseDateLoose("soon")).toBeNull();
  });
});
