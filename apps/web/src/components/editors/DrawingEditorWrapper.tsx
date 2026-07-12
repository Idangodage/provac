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
import { useCallback, useRef, useState } from "react";

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
          {saveError && (
            <span
              className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-medium text-red-600"
              title={saveError}
            >
              Save failed
            </span>
          )}
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
