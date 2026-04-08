'use client';

import { useEffect, useCallback } from 'react';

import { useEditorStore } from '../store/editorStore';

export interface UseKeyboardShortcutsOptions {
  enabled?: boolean;
  onSave?: () => void;
}

/**
 * Hook for keyboard shortcuts in the document editor.
 */
export const useKeyboardShortcuts = (options: UseKeyboardShortcutsOptions = {}) => {
  const { enabled = true, onSave } = options;
  
  const {
    selectedElement,
    elements,
    isEditing,
    undo,
    redo,
    duplicateElement,
    deleteElement,
    stopEditing,
    selectElement,
    setSelectedTool,
  } = useEditorStore();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;
    
    // Don't handle shortcuts when typing in inputs
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      // Only allow Escape to exit
      if (e.key === 'Escape') {
        if (isEditing) stopEditing();
        selectElement(null);
      }
      return;
    }

    // Ctrl/Cmd shortcuts
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'z':
          if (e.shiftKey) {
            e.preventDefault();
            redo();
          } else {
            e.preventDefault();
            undo();
          }
          break;
        case 'y':
          e.preventDefault();
          redo();
          break;
        case 's':
          e.preventDefault();
          onSave?.();
          break;
        case 'd':
          e.preventDefault();
          if (selectedElement) duplicateElement(selectedElement);
          break;
        case 'a':
          // Select all - could be implemented
          break;
      }
      return;
    }

    // Single key shortcuts
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (selectedElement) {
          const element = elements.find((el) => el.id === selectedElement);
          if (element && !element.locked) {
            e.preventDefault();
            deleteElement(selectedElement);
          }
        }
        break;
      case 'Escape':
        if (isEditing) {
          stopEditing();
        }
        selectElement(null);
        setSelectedTool('select');
        break;
      case 'v':
        setSelectedTool('select');
        break;
      case 't':
        setSelectedTool('text');
        break;
      case 'r':
        setSelectedTool('rectangle');
        break;
      case 'c':
        setSelectedTool('circle');
        break;
      case 'l':
        setSelectedTool('line');
        break;
      case 'i':
        setSelectedTool('image');
        break;
    }
  }, [
    enabled,
    selectedElement,
    elements,
    isEditing,
    undo,
    redo,
    duplicateElement,
    deleteElement,
    stopEditing,
    selectElement,
    setSelectedTool,
    onSave,
  ]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return null;
};

export default useKeyboardShortcuts;
