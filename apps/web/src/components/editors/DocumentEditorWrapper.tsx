"use client";

/**
 * Document Editor Wrapper (Covering Letter)
 * Thin wrapper around @provacx/document-editor for app-specific integration
 */

import dynamic from "next/dynamic";
import Link from "next/link";

// Dynamically import to avoid SSR issues with canvas/fabric.js
const CoveringLetterEditor = dynamic(
  () => import("@provacx/document-editor").then((mod) => ({ default: mod.CoveringLetterEditor })),
  { ssr: false, loading: () => <EditorLoading /> }
);

function EditorLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-100">
      <div className="text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent mx-auto mb-4" />
        <p className="text-gray-600">Loading document editor...</p>
      </div>
    </div>
  );
}

interface DocumentEditorWrapperProps {
  projectId: string;
  projectName?: string;
  initialData?: unknown;
}

export default function DocumentEditorWrapper({
  projectId,
  projectName,
  initialData: _initialData,
}: DocumentEditorWrapperProps) {
  const handleExportPDF = async () => {
    // TODO: Implement PDF export
    console.log("Exporting PDF...");
  };

  return (
    <div className="h-screen w-full overflow-hidden flex flex-col">
      {/* Navigation Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b">
        <div className="flex items-center gap-4">
          <Link
            href={`/projects/${projectId}/boq`}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to BOQ
          </Link>
          <span className="text-sm text-gray-400">|</span>
          <span className="text-sm font-medium text-gray-800">
            {projectName || "Covering Letter"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportPDF}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Export PDF
          </button>
          <Link
            href={`/projects/${projectId}/proposal`}
            className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700"
          >
            Next: Proposal →
          </Link>
        </div>
      </div>
      
      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300">
          <CoveringLetterEditor />
        </div>
      </div>
    </div>
  );
}
