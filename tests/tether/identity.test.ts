import { describe, expect, it } from "vitest";
import { PersonRegistry, emailHmac } from "@/lib/tether/identity";
import { KEYS } from "./helpers";

describe("PersonRegistry", () => {
  it("merges only on an exact email (case and whitespace insensitive), compared as HMAC", () => {
    const r = new PersonRegistry(KEYS.identityKey);
    const a = r.resolve({ displayName: "Priya Nair", email: "priya.nair@club.example" });
    const b = r.resolve({ displayName: "priya-n", email: "  PRIYA.NAIR@club.example " });
    expect(b.id).toBe(a.id);
    expect(r.all()).toHaveLength(1);
    expect(r.all()[0].aliases).toEqual(["priya-n"]);
    expect(r.all()[0].emailHmac).toBe(emailHmac(KEYS.identityKey, "priya.nair@club.example"));
    expect(JSON.stringify(r.all())).not.toContain("priya.nair@");
  });

  it("never merges on name alone; records a suggestion instead", () => {
    const r = new PersonRegistry(KEYS.identityKey);
    const slack = r.resolve({ displayName: "Priya Nair", email: "priya.nair@club.example", scope: "slack" });
    const wa = r.resolve({ displayName: "Priya Nair", scope: "whatsapp" });
    expect(wa.id).not.toBe(slack.id);
    expect(r.suggestions()).toEqual([{ a: slack.id, b: wa.id, reason: "same display name" }]);
  });

  it("same name inside one source is the same person", () => {
    const r = new PersonRegistry(KEYS.identityKey);
    const x = r.resolve({ displayName: "Arjun Mehta", scope: "chat" });
    const y = r.resolve({ displayName: "Arjun  Mehta", scope: "chat" });
    expect(y.id).toBe(x.id);
  });

  it("different emails with the same name stay separate (suggestion only)", () => {
    const r = new PersonRegistry(KEYS.identityKey);
    const x = r.resolve({ displayName: "Arjun Mehta", email: "arjun@club.example" });
    const y = r.resolve({ displayName: "Arjun Mehta", email: "arjun.m@gmail.example" });
    expect(y.id).not.toBe(x.id);
    expect(r.suggestions()[0].reason).toBe("same display name, different emails");
  });

  it("suggests first-name matches", () => {
    const r = new PersonRegistry(KEYS.identityKey);
    const x = r.resolve({ displayName: "Priya Nair", email: "p@club.example" });
    const y = r.resolve({ displayName: "Priya", scope: "chat" });
    expect(r.suggestions()).toEqual([{ a: x.id, b: y.id, reason: "first name matches" }]);
  });

  it("assigns p-1, p-2 ... in insertion order and a different key gives different HMACs", () => {
    const r = new PersonRegistry(KEYS.identityKey);
    expect(r.resolve({ displayName: "A", email: "a@x.example" }).id).toBe("p-1");
    expect(r.resolve({ displayName: "B" }).id).toBe("p-2");
    expect(r.resolve({ displayName: "C", email: "c@x.example" }).id).toBe("p-3");
    expect(r.lookupEmail("A@X.example")?.id).toBe("p-1");
    expect(r.lookupEmail("nobody@x.example")).toBeNull();
    expect(emailHmac("k1", "a@x.example")).not.toBe(emailHmac("k2", "a@x.example"));
  });
});
