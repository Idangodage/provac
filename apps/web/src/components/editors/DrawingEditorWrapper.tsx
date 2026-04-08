"use client";

/**
 * Drawing Editor Wrapper
 * Thin wrapper around @provacx/drawing-engine for app-specific integration
 */

import { SmartDrawingEditor } from "@provacx/drawing-engine/editor";
import { ArrowLeft, ArrowRight, Share2 } from "lucide-react";
import Link from "next/link";

interface DrawingEditorWrapperProps {
  projectId: string;
  projectName?: string;
  initialData?: unknown;
}

export default function DrawingEditorWrapper({
  projectId,
  projectName,
  initialData,
}: DrawingEditorWrapperProps) {
  const handleSave = async (data: unknown) => {
    // Save to localStorage for now
    localStorage.setItem(
      `provacx-drawing-data-${projectId}`,
      JSON.stringify({
        data,
        savedAt: new Date().toISOString(),
      })
    );
    // TODO: Implement save to database via tRPC
  };

  return (
    <div className="fixed inset-0 z-[60] flex h-screen w-screen flex-col bg-[#f6f1e7]">
      {/* Navigation Header */}
      <div className="flex h-12 items-center justify-between gap-3 border-b border-amber-200/70 bg-white px-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={`/projects/${projectId}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-200/80 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-amber-50 hover:text-slate-900"
          >
            <ArrowLeft size={14} />
            Back to Project
          </Link>
          <div className="hidden h-5 w-px bg-amber-200/80 sm:block" />
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-400 text-[10px] font-bold text-amber-950">
              PX
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-xs font-semibold text-slate-900">
                {projectName || "Untitled Project"}
              </div>
              <div className="text-[10px] text-slate-500">Smart Drawing</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 text-xs text-slate-500 lg:flex">
            <span className="px-2 py-1 rounded-full border border-amber-200/80 bg-amber-50">
              {projectName || "Untitled Document"}
            </span>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-200/80 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-amber-50"
          >
            <Share2 size={14} />
            Share
          </button>
          <Link
            href={`/projects/${projectId}/boq`}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-400 px-2.5 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-300"
          >
            Next: BOQ
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <SmartDrawingEditor
          projectId={projectId}
          initialData={initialData}
          onSave={handleSave}
          className="h-full"
        />
      </div>
    </div>
  );
}
