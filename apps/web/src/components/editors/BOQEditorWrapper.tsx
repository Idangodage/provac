"use client";

/**
 * BOQ Editor Wrapper
 * Thin wrapper around @provacx/boq-engine for app-specific integration
 */

import { BOQEditor } from "@provacx/boq-engine";
import type { BOQData } from "@provacx/boq-engine";

interface BOQEditorWrapperProps {
  projectId: string;
  projectName?: string;
  initialData?: BOQData;
}

export default function BOQEditorWrapper({ 
  projectId, 
  projectName,
  initialData 
}: BOQEditorWrapperProps) {
  const handleSave = async (data: BOQData) => {
    // Save to localStorage for now
    localStorage.setItem(`provacx-boq-data-${projectId}`, JSON.stringify({
      ...data,
      savedAt: new Date().toISOString(),
    }));
    // TODO: Implement save to database via tRPC
    console.log("Saving BOQ...", data);
  };

  const handleDataChange = (data: BOQData) => {
    // Auto-save could be implemented here with debouncing
    console.log("BOQ data changed", data);
  };

  return (
    <BOQEditor
      projectId={projectId}
      projectName={projectName}
      initialData={initialData}
      onSave={handleSave}
      onDataChange={handleDataChange}
      backLink={{
        href: `/projects/${projectId}/drawing`,
        label: "Back to Drawing",
      }}
      nextLink={{
        href: `/projects/${projectId}/covering-letter`,
        label: "Next: Covering Letter",
      }}
      className="h-screen"
    />
  );
}
