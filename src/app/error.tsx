"use client"; // Error boundaries must be Client Components
import { ErrorPanel } from "@/components/ErrorPanel";

export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4">
      <ErrorPanel error={error} retry={retry} backHref="/" backLabel="Back to the start page" />
    </main>
  );
}
