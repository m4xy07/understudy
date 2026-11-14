"use client"; // Error boundaries must be Client Components
// Last resort: the root layout itself failed. Renders its own document (no global styles apply).

export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "4rem 1.5rem", color: "#1c1b19", background: "#faf8f3" }}>
        <main role="alert" style={{ maxWidth: "36rem", margin: "0 auto" }}>
          <title>Something went wrong · Understudy</title>
          <h1 style={{ fontSize: "1.75rem", margin: 0 }}>Understudy could not load this page.</h1>
          <p style={{ lineHeight: 1.5 }}>
            The server hit an error or took too long to answer. Your data is unchanged. Try again, or go back to the
            start page.
          </p>
          <p style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button type="button" onClick={() => retry()} style={{ padding: "0.6rem 1rem", fontSize: "1rem", cursor: "pointer" }}>
              Try again
            </button>
            {/* A plain link on purpose: the router may be what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={{ padding: "0.6rem 1rem", fontSize: "1rem" }}>
              Back to the start page
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
