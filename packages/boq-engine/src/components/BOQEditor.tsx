/**
 * BOQ Editor Component
 * Main editor that combines header, table, and sidebar
 */

'use client';

import React, { useEffect } from 'react';

import { useBOQStore } from '../store';
import type { BOQEditorProps } from '../types';

import { BOQHeader } from './BOQHeader';
import { BOQSidebar } from './BOQSidebar';
import { BOQTable } from './BOQTable';

export function BOQEditor({
  projectId,
  projectName = 'Project',
  initialData,
  onSave,
  onDataChange,
  className = '',
  backLink,
  nextLink,
}: BOQEditorProps) {
  const { initialize, getData, markSaved, categories, currency, taxRate } = useBOQStore();

  // Initialize store with data
  useEffect(() => {
    initialize({
      projectId,
      ...initialData,
    });
  }, [projectId, initialData, initialize]);

  // Notify parent of data changes
  useEffect(() => {
    if (onDataChange) {
      onDataChange(getData());
    }
  }, [categories, currency, taxRate, onDataChange, getData]);

  const handleSave = async () => {
    if (onSave) {
      await onSave(getData());
      markSaved();
    }
  };

  const handleExport = () => {
    const data = getData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `boq-${projectId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`flex h-full flex-col bg-gray-100 ${className}`}>
      <BOQHeader
        projectName={projectName}
        onSave={handleSave}
        onExport={handleExport}
        backLink={backLink}
        nextLink={nextLink}
      />

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 p-6">
          <BOQTable />
        </div>

        <div className="w-80 border-l overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-gray-300">
          <BOQSidebar />
        </div>
      </div>
    </div>
  );
}
