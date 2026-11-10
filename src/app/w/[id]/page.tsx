import { Suspense } from "react";
import { redirect } from "next/navigation";
import type { WsParams } from "@/lib/page";

export default function WorkspaceIndex({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={null}>
      <Go params={params} />
    </Suspense>
  );
}

async function Go({ params }: { params: WsParams }) {
  const { id } = await params;
  redirect(`/w/${id}/connect`);
  return null;
}
