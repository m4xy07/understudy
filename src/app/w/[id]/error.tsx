"use client"; // Error boundaries must be Client Components
// A workspace page that throws keeps the header (steps, role switcher) and offers a retry and a
// way back to Connect, the page that always renders.
import { useParams } from "next/navigation";
import { ErrorPanel } from "@/components/ErrorPanel";

export default function WorkspaceError({ error, retry }: { error: unknown; retry: () => void }) {
  const params = useParams<{ id?: string }>();
  const id = typeof params?.id === "string" ? params.id : "";
  return (
    <ErrorPanel
      error={error}
      retry={retry}
      backHref={id ? `/w/${id}/connect` : "/"}
      backLabel={id ? "Back to Connect" : "Back to the start page"}
    />
  );
}
