'use client';

import React from 'react';

export interface HeaderFooterAreaProps {
  type: 'header' | 'footer';
  enabled: boolean;
  height: number;
  pageHeight?: number;
}

/**
 * Reusable Header/Footer area indicator component.
 */
export const HeaderFooterArea: React.FC<HeaderFooterAreaProps> = ({
  type,
  enabled,
  height,
  // pageHeight is optional for future use with footer positioning
  pageHeight: _pageHeight,
}) => {
  if (!enabled) return null;

  const isHeader = type === 'header';

  return (
    <div
      style={{
        position: 'absolute',
        ...(isHeader ? { top: 0 } : { bottom: 0 }),
        left: 0,
        right: 0,
        height,
        borderTop: isHeader ? undefined : '2px dashed #0066cc',
        borderBottom: isHeader ? '2px dashed #0066cc' : undefined,
        backgroundColor: 'rgba(0, 102, 204, 0.05)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          ...(isHeader ? { bottom: -15 } : { top: -15 }),
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 10,
          color: '#0066cc',
          backgroundColor: 'white',
          padding: '2px 8px',
          borderRadius: '3px',
          border: '1px solid #0066cc',
        }}
      >
        {isHeader ? 'Header Area' : 'Footer Area'}
      </div>
    </div>
  );
};

export default HeaderFooterArea;
