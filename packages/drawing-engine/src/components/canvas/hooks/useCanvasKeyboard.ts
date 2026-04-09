/**
 * useCanvasKeyboard Hook
 *
 * Handles keyboard events for the drawing canvas including:
 * - Space key for panning mode
 * - Escape for canceling current operation
 * - Delete/Backspace for deleting selected elements
 */

import { useEffect } from "react";

import type { DrawingTool } from "../../../types";
import { isEditableElement } from "../toolUtils";

export interface UseCanvasKeyboardOptions {
  tool: DrawingTool;
  selectedIds: string[];
  deleteSelected: () => void;
  setIsSpacePressed: (pressed: boolean) => void;
  setTool?: (tool: DrawingTool) => void;
  onEscape?: () => boolean;
  onCopy?: () => void;
  onPaste?: () => void;
}

export function useCanvasKeyboard({
  selectedIds,
  deleteSelected,
  setIsSpacePressed,
  setTool,
  onEscape,
  onCopy,
  onPaste,
}: UseCanvasKeyboardOptions) {
  // Space key for panning
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        isEditableElement(event.target)
      )
        return;
      event.preventDefault();
      setIsSpacePressed(true);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        setIsSpacePressed(false);
      }
    };

    const clearSpacePan = () => setIsSpacePressed(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearSpacePan);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearSpacePan);
    };
  }, [setIsSpacePressed]);

  // Delete/Backspace key handler
  useEffect(() => {
    const handleDeleteKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isEditableElement(event.target)) return;
      if (selectedIds.length === 0) return;
      event.preventDefault();
      deleteSelected();
    };

    window.addEventListener("keydown", handleDeleteKey);
    return () => {
      window.removeEventListener("keydown", handleDeleteKey);
    };
  }, [selectedIds, deleteSelected]);

  // Copy / Paste shortcuts
  useEffect(() => {
    const handleClipboardKey = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) return;
      const withModifier = event.ctrlKey || event.metaKey;
      if (!withModifier) return;

      const key = event.key.toLowerCase();
      if (key === "c") {
        if (selectedIds.length === 0 || !onCopy) return;
        event.preventDefault();
        onCopy();
      }

      if (key === "v") {
        if (!onPaste) return;
        event.preventDefault();
        onPaste();
      }
    };

    window.addEventListener("keydown", handleClipboardKey);
    return () => {
      window.removeEventListener("keydown", handleClipboardKey);
    };
  }, [selectedIds, onCopy, onPaste]);

  // Single-key tool shortcuts
  useEffect(() => {
    if (!setTool) return;

    const handleToolShortcut = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.repeat) return;

      const key = event.key.toLowerCase();
      if (key === "escape") {
        if (onEscape?.()) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        setTool("select");
        return;
      }
      if (key === "v") {
        event.preventDefault();
        setTool("select");
        return;
      }
      if (key === "m") {
        event.preventDefault();
        setTool("select");
        return;
      }
      if (key === "w") {
        event.preventDefault();
        setTool("wall");
        return;
      }
      if (key === "q") {
        event.preventDefault();
        setTool("partition-wall");
        return;
      }
      if (key === "r") {
        event.preventDefault();
        setTool("room");
        return;
      }
      if (key === "t") {
        event.preventDefault();
        setTool("text");
        return;
      }
      if (key === "e") {
        event.preventDefault();
        setTool("eraser");
        return;
      }
      if (key === "s") {
        event.preventDefault();
        setTool("spline");
        return;
      }
      if (key === "d") {
        event.preventDefault();
        setTool("dimension");
        return;
      }
      if (key === "i") {
        event.preventDefault();
        setTool("refrigerant-pipe");
        return;
      }
      if (key === "u") {
        event.preventDefault();
        setTool("duct");
        return;
      }
      if (key === "g") {
        event.preventDefault();
        setTool("extend");
        return;
      }
      if (key === "k") {
        event.preventDefault();
        setTool("section-line");
      }
    };

    window.addEventListener("keydown", handleToolShortcut);
    return () => {
      window.removeEventListener("keydown", handleToolShortcut);
    };
  }, [onEscape, setTool]);
}
