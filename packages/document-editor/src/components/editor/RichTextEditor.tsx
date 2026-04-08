'use client';

import React, { useRef, useEffect } from 'react';

export interface RichTextEditorProps {
  content: string;
  onChange: (html: string, text: string) => void;
  onBlur?: () => void;
  style?: React.CSSProperties;
  placeholder?: string;
}

/**
 * Simple rich text editor using contentEditable.
 * For more advanced features, consider using a library like TipTap or Slate.
 */
export const RichTextEditor: React.FC<RichTextEditorProps> = ({
  content,
  onChange,
  onBlur,
  style,
  placeholder = 'Type here...',
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const isInitializing = useRef(true);

  useEffect(() => {
    if (editorRef.current && isInitializing.current) {
      editorRef.current.innerHTML = content;
      isInitializing.current = false;
      // Focus at end
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(editorRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      editorRef.current.focus();
    }
  }, [content]);

  const handleInput = () => {
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      const text = editorRef.current.innerText || editorRef.current.textContent || '';
      onChange(html, text);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle formatting shortcuts
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'b':
          e.preventDefault();
          document.execCommand('bold');
          break;
        case 'i':
          e.preventDefault();
          document.execCommand('italic');
          break;
        case 'u':
          e.preventDefault();
          document.execCommand('underline');
          break;
      }
    }
  };

  return (
    <div
      ref={editorRef}
      contentEditable
      onInput={handleInput}
      onBlur={onBlur}
      onKeyDown={handleKeyDown}
      suppressContentEditableWarning
      style={{
        outline: 'none',
        cursor: 'text',
        minHeight: 20,
        padding: 4,
        border: '1px solid #0066cc',
        borderRadius: 2,
        backgroundColor: 'white',
        ...style,
      }}
      data-placeholder={placeholder}
    />
  );
};

export default RichTextEditor;
