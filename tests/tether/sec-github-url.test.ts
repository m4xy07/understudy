// S8: an owner or repository name can never be "." or "..", so a pasted URL cannot climb out of
// /repos/<owner>/<repo> on the GitHub API or raw host.
import { describe, expect, it } from "vitest";
import { fetchPublicRepo, GithubFetchError, parseRepoUrl } from "@/lib/tether/github-fetch";

describe("S8: parseRepoUrl rejects dot segments", () => {
  it.each([
    "https://github.com/../..",
    "https://github.com/./repo",
    "https://github.com/owner/..",
    "https://github.com/owner/.",
    "github.com/../users",
    "../..",
    "./repo",
    "owner/..",
    "owner/a..b",
    "https://github.com/.hidden/repo",
    "https://github.com/owner/-repo",
    "https://github.com/owner/..git",
  ])("refuses %s", (url) => {
    expect(() => parseRepoUrl(url)).toThrow(GithubFetchError);
  });

  it("still accepts ordinary names, with dots, dashes and underscores inside", () => {
    expect(parseRepoUrl("https://github.com/club/firmware")).toEqual({ owner: "club", repo: "firmware" });
    expect(parseRepoUrl("github.com/club/firmware.git")).toEqual({ owner: "club", repo: "firmware" });
    expect(parseRepoUrl("https://github.com/club/firmware/tree/main/docs")).toEqual({ owner: "club", repo: "firmware" });
    expect(parseRepoUrl("my-org/site.v2_x")).toEqual({ owner: "my-org", repo: "site.v2_x" });
    expect(parseRepoUrl("https://www.github.com/a1/b.js/")).toEqual({ owner: "a1", repo: "b.js" });
    expect(parseRepoUrl("vercel/next.js")).toEqual({ owner: "vercel", repo: "next.js" });
  });

  it("fetchPublicRepo makes no request for a dot-segment URL", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(fetchPublicRepo("https://github.com/../..", { fetchImpl })).rejects.toMatchObject({ code: "bad_url" });
    expect(calls).toBe(0);
  });
});
