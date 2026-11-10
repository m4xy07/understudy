import { describe, expect, it } from "vitest";
import { decryptContact, looksHighEntropy, maskText } from "@/lib/tether/mask";
import { PersonRegistry } from "@/lib/tether/identity";
import { KEYS } from "./helpers";

const m = (text: string, people?: PersonRegistry) => maskText(text, { contactsKey: KEYS.contactsKey, people });

describe("maskText: secrets", () => {
  const planted: [string, string, string][] = [
    ["GitHub classic token", "use ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 for CI", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"],
    ["GitHub oauth token", "gho_16C7e42F292c6912E7710c838347Ae178B4a here", "gho_16C7e42F292c6912E7710c838347Ae178B4a"],
    ["GitHub fine-grained PAT", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
    ["AWS access key id", "key AKIAIOSFODNN7EXAMPLE in prod", "AKIAIOSFODNN7EXAMPLE"],
    ["AWS secret", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["Slack bot token", "xoxb-1234567890-0987654321-AbCdEfGhIjKlMnOp", "xoxb-1234567890-0987654321-AbCdEfGhIjKlMnOp"],
    ["OpenAI-style key", "OPENAI sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv", "sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv"],
    ["Anthropic-style key", "sk-ant-api03-Zq8xW2vB7nM4kL1pO9iU6yT3rE5", "sk-ant-api03-Zq8xW2vB7nM4kL1pO9iU6yT3rE5"],
    ["password=", "db password=Robo@2026! ok", "Robo@2026!"],
    ["passwd:", "passwd: hunter2go", "hunter2go"],
    ["token=", "TOKEN=abc123def456", "abc123def456"],
    ["secret= quoted", 'client_secret="s3cr3t value here"', "s3cr3t value here"],
    ["api_key: yaml", "api_key: 'k-77Ahd8sKd'", "k-77Ahd8sKd"],
    ["high entropy", "the backup key is 9fK2xQ7mZp4LwR8tY3vB6nH1sD5gJ0 ok", "9fK2xQ7mZp4LwR8tY3vB6nH1sD5gJ0"],
  ];
  for (const [label, text, secret] of planted) {
    it(`masks ${label}`, () => {
      const r = m(text);
      expect(r.text).not.toContain(secret);
      expect(r.text).toMatch(/\[SECRET:[a-z_]+\]/);
      expect(r.secrets).toBeGreaterThanOrEqual(1);
    });
  }

  it("masks a private key block entirely", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAMwAAAAtzc2gtZWQyNTUxOQ\n-----END OPENSSH PRIVATE KEY-----";
    const r = m(`deploy key:\n${pem}\nthanks`);
    expect(r.text).toBe("deploy key:\n[SECRET:private_key]\nthanks");
    expect(r.secrets).toBe(1);
  });

  it("keeps the credential NAME and drops the value", () => {
    const r = m("DNS_API_TOKEN=Zq8xW2vB7nM4kL1p");
    expect(r.text).toBe("DNS_API_TOKEN=[SECRET:token]");
  });

  it("does not mask credential names without a value, references or prose", () => {
    const safe = [
      "The DNS_API_TOKEN lives in the repo secrets; rotate it every March.",
      "DNS_API_TOKEN: ${{ secrets.DNS_API_TOKEN }}",
      "token: rotate yearly",
      "token_expiry: 2027-03-01",
      "password manager is Bitwarden, ask the president",
    ];
    for (const s of safe) {
      const r = m(s);
      expect(r.text, s).toBe(s);
      expect(r.secrets, s).toBe(0);
    }
  });

  it("leaves normal text, slugs, commit SHAs and ids untouched", () => {
    const normal = [
      "Flashed the firmware on the bot again, deploy went fine at 21:14.",
      "fixed in a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 and 3f2a9c1",
      "see firmware-deploy-checklist-2026-v2 and LAB_BOOKING_FORM_2026",
      "uuid 123e4567-e89b-12d3-a456-426614174000 and seg_0123456789abcdef",
      "handleFirmwareDeployment2 is the function name",
      "Competition on 2026-02-14T09:00:00+05:30, budget 12500",
    ];
    for (const s of normal) {
      const r = m(s);
      expect(r.text, s).toBe(s);
      expect(r.secrets + r.contacts.length, s).toBe(0);
    }
    expect(looksHighEntropy("averyveryveryverylongwordwithoutdigits")).toBe(false);
  });
});

describe("maskText: contacts", () => {
  it("tokenises emails: known person -> p-n, unknown -> c-n, stable", () => {
    const people = new PersonRegistry(KEYS.identityKey);
    const priya = people.resolve({ displayName: "Priya Nair", email: "priya.nair@club.example" });
    const r = m("mail Priya.Nair@club.example or vendor@pcb.example, again vendor@pcb.example", people);
    expect(r.text).toBe(`mail [CONTACT:${priya.id}] or [CONTACT:c-1], again [CONTACT:c-1]`);
    expect(r.contacts).toHaveLength(3);
    expect(r.contacts[0]).toMatchObject({ token: `[CONTACT:${priya.id}]`, kind: "email", personId: priya.id });
    expect(r.contacts[1]).toMatchObject({ token: "[CONTACT:c-1]", kind: "email", personId: null });
    expect(decryptContact(r.contacts[1].valueEnc, KEYS.contactsKey)).toBe("vendor@pcb.example");
    expect(r.contacts[1].valueEnc).not.toContain("vendor");
  });

  it("tokenises Indian and international phone numbers", () => {
    const people = new PersonRegistry(KEYS.identityKey);
    const nums = ["+91 98765 43210", "+91-9876543210", "9876543210", "09876543210", "+44 20 7946 0958", "+1 (415) 555-0100"];
    for (const n of nums) {
      const r = m(`call ${n} today`, people);
      expect(r.text, n).toMatch(/^call \[CONTACT:c-\d+\] today$/);
      expect(r.contacts[0].kind).toBe("phone");
      expect(decryptContact(r.contacts[0].valueEnc, KEYS.contactsKey)).toBe(n);
    }
    // same number written differently -> same token
    const a = m("+91 98765 43210", people).text;
    const b = m("+91-98765-43210", people).text;
    expect(a).toBe(b);
  });

  it("decryption fails with the wrong key", () => {
    const r = m("x@y.example");
    expect(() => decryptContact(r.contacts[0].valueEnc, "wrong-key")).toThrow();
  });
});
