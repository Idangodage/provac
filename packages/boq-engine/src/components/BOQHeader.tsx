/**
 * BOQ Header Component
 * Header with save, export, and navigation controls
 */

'use client';

import { Save, Download, ArrowLeft, ArrowRight } from 'lucide-react';
import React from 'react';

import { useBOQStore } from '../store';

interface BOQHeaderProps {
  projectName?: string;
  onSave?: () => void;
  onExport?: () => void;
  backLink?: {
    href: string;
    label: string;
  };
  nextLink?: {
    href: string;
    label: string;
  };
  /** Custom link component (for Next.js Link) */
  LinkComponent?: React.ComponentType<{ href: string; className?: string; children: React.ReactNode }>;
}

export function BOQHeader({
  projectName = 'Project',
  onSave,
  onExport,
  backLink,
  nextLink,
  LinkComponent,
}: BOQHeaderProps) {
  const { isDirty, lastSaved } = useBOQStore();

  const Link = LinkComponent || (({ href, className, children }) => (
    <a href={href} className={className}>{children}</a>
  ));

  return (
    <div className="flex items-center justify-between border-b bg-gray-900 px-4 py-3 text-white">
      <div className="flex items-center gap-4">
        {backLink && (
          <>
            <Link
              href={backLink.href}
              className="flex items-center gap-2 text-gray-300 hover:text-white"
            >
              <ArrowLeft size={18} />
              <span className="text-sm">{backLink.label}</span>
            </Link>
            <div className="h-6 w-px bg-gray-700" />
          </>
        )}
        <h1 className="text-lg font-semibold">Bill of Quantities (BOQ)</h1>
        <span className="text-sm text-gray-400">- {projectName}</span>
      </div>
      <div className="flex items-center gap-3">
        {isDirty && <span className="text-sm text-yellow-400">Unsaved changes</span>}
        {lastSaved && (
          <span className="text-sm text-gray-400">
            Last saved: {lastSaved.toLocaleTimeString()}
          </span>
        )}
        {onSave && (
          <button
            onClick={onSave}
            className="flex items-center gap-2 rounded bg-blue-600 px-4 py-1.5 text-sm hover:bg-blue-700"
          >
            <Save size={16} />
            Save
          </button>
        )}
        {onExport && (
          <button
            onClick={onExport}
            className="flex items-center gap-2 rounded bg-gray-700 px-4 py-1.5 text-sm hover:bg-gray-600"
          >
            <Download size={16} />
            Export
          </button>
        )}
        {nextLink && (
          <Link
            href={nextLink.href}
            className="flex items-center gap-2 rounded bg-green-600 px-4 py-1.5 text-sm hover:bg-green-700"
          >
            {nextLink.label}
            <ArrowRight size={16} />
          </Link>
        )}
      </div>
    </div>
  );
}
