"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";

import DrawingEditorWrapper from "@/components/editors/DrawingEditorWrapper";
import { trpc } from "@/lib/trpc";

function parseCanvasData(input: unknown): unknown {
  if (!input) return undefined;
  if (typeof input !== "string") return input;

  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function CanvasLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-[#f6f1e7]">
      <div className="text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-amber-400 border-t-transparent mx-auto mb-4" />
        <p className="text-slate-500">Loading drawing canvas...</p>
      </div>
    </div>
  );
}

export default function DrawingPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [mounted, setMounted] = useState(false);

  // Get project details
  const { data: project, isLoading: projectLoading } = trpc.project.getById.useQuery(
    { id: projectId },
    { enabled: !!projectId }
  );
  const { data: drawings, isLoading: drawingsLoading } =
    trpc.drawing.listByProject.useQuery(
      { projectId },
      { enabled: !!projectId }
    );

  useEffect(() => {
    setMounted(true);
  }, []);

  if (projectLoading || drawingsLoading || !mounted) {
    return <CanvasLoading />;
  }

  if (!project) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f6f1e7]">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-slate-900">Project not found</h2>
          <Link href="/dashboard" className="mt-4 block text-amber-700 hover:underline">
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const latestDrawing = drawings?.[0];

  return (
    <DrawingEditorWrapper
      projectId={projectId}
      projectName={project.name}
      initialData={parseCanvasData(latestDrawing?.canvasData)}
      drawingId={latestDrawing?.id}
    />
  );
}
