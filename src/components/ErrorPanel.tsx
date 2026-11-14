"use client";
// What a person sees when a page throws: what happened in plain words, a retry, and a way back.
// Used by the error boundaries (src/app/error.tsx and src/app/w/[id]/error.tsx).
import { useEffect } from "react";
import Link from "next/link";

export function ErrorPanel({
  error, retry, backHref, backLabel,
}: { error: unknown; retry: () => void; backHref: string; backLabel: string }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  return (
    <div role="alert" className="mx-auto max-w-xl py-10">
      <p className="eyebrow">Something went wrong</p>
      <h1 className="mt-2 text-3xl">This page could not be shown.</h1>
      <p className="mt-3 text-ink-2">
        The server hit an error or took too long to answer. Your data is unchanged: nothing is saved halfway.
        Try again; if it keeps happening, go back and reopen the page.
      </p>
      <p className="mt-6 flex flex-wrap gap-3">
        <button type="button" className="btn" onClick={() => retry()}>
          Try again
        </button>
        <Link href={backHref} className="btn btn-quiet">
          {backLabel}
        </Link>
      </p>
      {digest && <p className="mono mt-6 text-xs text-muted">Reference: {digest}</p>}
    </div>
  );
}
