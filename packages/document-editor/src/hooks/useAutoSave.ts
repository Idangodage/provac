'use client';

import { useEffect, useRef, useCallback } from 'react';

import { useEditorStore } from '../store/editorStore';

export interface UseAutoSaveOptions {
  interval?: number; // in seconds
  enabled?: boolean;
  onSave?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Hook for auto-saving editor state to localStorage.
 */
export const useAutoSave = (options: UseAutoSaveOptions = {}) => {
  const { interval = 30, enabled = true, onSave, onError } = options;
  
  const { saveToLocalStorage, isDirty } = useEditorStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSaveRef = useRef<number>(0);

  const save = useCallback(() => {
    try {
      saveToLocalStorage();
      lastSaveRef.current = Date.now();
      onSave?.();
    } catch (error) {
      onError?.(error as Error);
    }
  }, [saveToLocalStorage, onSave, onError]);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      if (isDirty) {
        save();
      }
    }, interval * 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, interval, isDirty, save]);

  // Save on unmount if dirty
  useEffect(() => {
    return () => {
      if (isDirty) {
        save();
      }
    };
  }, [isDirty, save]);

  return {
    save,
    lastSaved: lastSaveRef.current,
  };
};

export default useAutoSave;
