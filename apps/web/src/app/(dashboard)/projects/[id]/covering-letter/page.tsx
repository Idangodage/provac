"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";

import { trpc } from "@/lib/trpc";

// Dynamically import the covering letter editor to avoid SSR issues
const CoveringLetterEditor = dynamic(
  () => import("@provacx/document-editor").then((mod) => ({ default: mod.CoveringLetterEditor })),
  { ssr: false, loading: () => <EditorLoading /> }
);

function EditorLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-100">
      <div className="text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent mx-auto mb-4" />
        <p className="text-gray-600">Loading covering letter editor...</p>
      </div>
    </div>
  );
}

export default function CoveringLetterPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [mounted, setMounted] = useState(false);

  // Get project details
  const { data: project, isLoading } = trpc.project.getById.useQuery(
    { id: projectId },
    { enabled: !!projectId }
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  if (isLoading || !mounted) {
    return <EditorLoading />;
  }

  if (!project) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-100">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-800 mb-4">Project not found</h2>
          <Link
            href="/dashboard"
            className="text-blue-600 hover:text-blue-700 underline"
          >
            Return to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full overflow-hidden">
      <CoveringLetterEditor />
    </div>
  );
}
