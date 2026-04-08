/**
 * Smart Drawing Page
 * 
 * HVAC CAD drawing editor for a project.
 */

'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { trpc } from '@/lib/trpc';

// Dynamically import to avoid SSR issues with Fabric.js
const DrawingEditorWrapper = dynamic(
  () => import('@/components/editors/DrawingEditorWrapper'),
  { 
    ssr: false, 
    loading: () => (
      <div className="flex items-center justify-center h-screen bg-[#f6f1e7]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-amber-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-500">Loading drawing editor...</p>
        </div>
      </div>
    )
  }
);

function parseCanvasData(input: unknown): unknown {
  if (!input) return undefined;
  if (typeof input !== 'string') return input;

  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

export default function SmartDrawingPage() {
  const params = useParams();
  const projectId = params.id as string;

  // Fetch project data
  const { data: project, isLoading: projectLoading } = trpc.project.getById.useQuery(
    { id: projectId },
    { enabled: !!projectId }
  );

  // Fetch latest drawing data for this project if any
  const { data: drawings, isLoading: drawingsLoading } = trpc.drawing.listByProject.useQuery(
    { projectId },
    { enabled: !!projectId }
  );

  if (projectLoading || drawingsLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#f6f1e7]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-amber-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-500">Loading drawing editor...</p>
        </div>
      </div>
    );
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
  const initialData = parseCanvasData(latestDrawing?.canvasData);

  return (
    <DrawingEditorWrapper
      projectId={projectId}
      projectName={project.name}
      initialData={initialData}
    />
  );
}
