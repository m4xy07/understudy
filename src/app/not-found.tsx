import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4">
      <p className="eyebrow">Not found</p>
      <h1 className="mt-2 text-3xl">This workspace or page does not exist.</h1>
      <p className="mt-3 text-ink-2">Workspaces are private copies and may be deleted after 7 days.</p>
      <p className="mt-6">
        <Link href="/" className="btn">
          Start again
        </Link>
      </p>
    </main>
  );
}
