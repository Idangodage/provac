"use client";

/**
 * Drawing Editor Wrapper
 * Thin wrapper around @provacx/drawing-engine for app-specific integration.
 *
 * Persistence (PR 3): the canvas is saved to the database via tRPC
 * (drawing.update, with create-if-missing via drawing.create). A localStorage
 * copy is kept as a best-effort offline fallback.
 */

import { SmartDrawingEditor } from "@provacx/drawing-engine/editor";
import { ArrowLeft, ArrowRight, Share2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { trpc } from "@/lib/trpc";

interface DrawingEditorWrapperProps {
  projectId: string;
  projectName?: string;
  initialData?: unknown;
  /** Existing drawing id for this project, if one has already been persisted. */
  drawingId?: string;
}

/**
 * The editor's exportData() returns a JSON *string*, but the tRPC `canvasData`
 * input is an object (z.record). Normalize to a plain object so it round-trips
 * through Prisma's JSON column and back into the editor's loadData() (which
 * accepts either an object or a string).
 */
function toCanvasObject(data: unknown): Record<string, unknown> {
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON — fall through to the raw wrapper below.
    }
  } else if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  // Defensive: never drop the payload even if the shape is unexpected.
  return { __raw: data };
}

export default function DrawingEditorWrapper({
  projectId,
  projectName,
  initialData,
  drawingId: initialDrawingId,
}: DrawingEditorWrapperProps) {
  // Track the drawing id locally so create-if-missing persists across saves
  // within a session. We deliberately do NOT invalidate the page's
  // listByProject query after a save: that would refetch, change the
  // `initialData` identity, and trigger the editor's reload effect — clobbering
  // the user's in-progress state and undo history. A fresh page load re-reads
  // the saved data from the DB.
  const drawingIdRef = useRef<string | undefined>(initialDrawingId);
  const createInFlightRef = useRef<Promise<string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { mutateAsync: createDrawing } = trpc.drawing.create.useMutation();
  const { mutateAsync: updateDrawing } = trpc.drawing.update.useMutation();

  useEffect(() => {
    drawingIdRef.current = initialDrawingId;
    createInFlightRef.current = null;
  }, [initialDrawingId, projectId]);

  const handleSave = useCallback(
    async (data: unknown) => {
      const canvasData = toCanvasObject(data);

      // Best-effort offline fallback; must never block or fail the DB save.
      try {
        localStorage.setItem(
          `provacx-drawing-data-${projectId}`,
          JSON.stringify({ data, savedAt: new Date().toISOString() })
        );
      } catch {
        // localStorage may be unavailable (private mode / quota) — non-fatal.
      }

      try {
        setSaveError(null);

        if (!drawingIdRef.current) {
          // First save for a project with no drawing yet: create it.
          // De-dupe against concurrent saves so we never create two records.
          if (!createInFlightRef.current) {
            const name = projectName?.trim()
              ? `${projectName.trim().slice(0, 180)} — Drawing`
              : "Untitled Drawing";
            createInFlightRef.current = createDrawing({
              projectId,
              name,
              viewType: "PLAN",
              canvasData,
            })
              .then((created) => {
                drawingIdRef.current = created.id;
                return created.id;
              })
              .finally(() => {
                createInFlightRef.current = null;
              });
          }
          await createInFlightRef.current;
          return;
        }

        await updateDrawing({ id: drawingIdRef.current, canvasData });
      } catch (err) {
        setSaveError(
          err instanceof Error ? err.message : "Failed to save drawing"
        );
        // Re-throw so SmartDrawingEditor reflects its error save-state.
        throw err;
      }
    },
    [projectId, projectName, createDrawing, updateDrawing]
  );

  return (
    <div className="fixed inset-0 z-[60] flex h-dvh w-screen flex-col overflow-hidden bg-[#f6f1e7]">
      {/* Navigation Header */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-amber-200/70 bg-white px-2 sm:px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/projects/${projectId}`}
            aria-label="Back to project"
            title="Back to project"
            className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-amber-200/80 px-2 text-xs font-medium text-slate-600 hover:bg-amber-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            <ArrowLeft size={14} />
            <span className="hidden sm:inline">Back to Project</span>
          </Link>
          <div className="hidden h-5 w-px bg-amber-200/80 sm:block" />
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-400 text-[10px] font-bold text-amber-950">
              PX
            </div>
            <div className="flex min-w-0 items-center gap-2 leading-tight">
              <div className="truncate text-xs font-semibold text-slate-900">
                {projectName || "Untitled Project"}
              </div>
              <span className="hidden shrink-0 border-l border-slate-200 pl-2 text-[10px] text-slate-500 md:inline">Smart Drawing</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {saveError && (
            <span
              className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-medium text-red-600"
              title={saveError}
            >
              Save failed
            </span>
          )}
          <button
            type="button"
            aria-label="Share drawing"
            title="Share drawing"
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-amber-200/80 px-2 text-xs font-medium text-slate-700 hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            <Share2 size={14} />
            <span className="hidden sm:inline">Share</span>
          </button>
          <Link
            href={`/projects/${projectId}/boq`}
            className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md bg-amber-400 px-2.5 text-xs font-semibold text-amber-950 hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
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
