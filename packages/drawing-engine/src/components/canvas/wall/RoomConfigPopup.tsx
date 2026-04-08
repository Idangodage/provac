/**
 * RoomConfigPopup
 *
 * Configuration popup for room creation shortcut.
 * Allows setting width, height, wall thickness, and material.
 */

import React from 'react';

import type { RoomConfig, WallMaterial } from '../../../types';

// =============================================================================
// Types
// =============================================================================

export interface RoomConfigPopupProps {
  config: RoomConfig;
  onChange: (config: Partial<RoomConfig>) => void;
  onConfirm: () => void;
  onCancel: () => void;
  position?: { x: number; y: number };
}

// =============================================================================
// Component
// =============================================================================

export function RoomConfigPopup({
  config,
  onChange,
  onConfirm,
  onCancel,
  position = { x: 100, y: 100 },
}: RoomConfigPopupProps): React.ReactElement {
  const handleWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (!isNaN(value) && value > 0) {
      onChange({ width: value });
    }
  };

  const handleHeightChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (!isNaN(value) && value > 0) {
      onChange({ height: value });
    }
  };

  const handleThicknessChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (!isNaN(value) && value > 0) {
      onChange({ wallThickness: value });
    }
  };

  const handleMaterialChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChange({ material: e.target.value as WallMaterial });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onConfirm();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        zIndex: 1000,
        backgroundColor: 'white',
        border: '1px solid #e0e0e0',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        padding: '16px',
        minWidth: '280px',
      }}
      onKeyDown={handleKeyDown}
    >
      <h3
        style={{
          margin: '0 0 16px 0',
          fontSize: '14px',
          fontWeight: 600,
          color: '#333',
        }}
      >
        Room Configuration
      </h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* Width */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', width: '80px', color: '#555' }}>Width:</span>
          <input
            type="number"
            value={config.width}
            onChange={handleWidthChange}
            min={100}
            step={100}
            style={{
              flex: 1,
              padding: '6px 8px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '13px',
            }}
            autoFocus
          />
          <span style={{ fontSize: '12px', color: '#888' }}>mm</span>
        </label>

        {/* Height */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', width: '80px', color: '#555' }}>Height:</span>
          <input
            type="number"
            value={config.height}
            onChange={handleHeightChange}
            min={100}
            step={100}
            style={{
              flex: 1,
              padding: '6px 8px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '13px',
            }}
          />
          <span style={{ fontSize: '12px', color: '#888' }}>mm</span>
        </label>

        {/* Wall Thickness */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', width: '80px', color: '#555' }}>Thickness:</span>
          <input
            type="number"
            value={config.wallThickness}
            onChange={handleThicknessChange}
            min={50}
            step={10}
            style={{
              flex: 1,
              padding: '6px 8px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '13px',
            }}
          />
          <span style={{ fontSize: '12px', color: '#888' }}>mm</span>
        </label>

        {/* Material */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', width: '80px', color: '#555' }}>Material:</span>
          <select
            value={config.material}
            onChange={handleMaterialChange}
            style={{
              flex: 1,
              padding: '6px 8px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '13px',
              backgroundColor: 'white',
            }}
          >
            <option value="brick">Brick</option>
            <option value="concrete">Concrete</option>
            <option value="partition">Partition</option>
          </select>
        </label>
      </div>

      {/* Preview info */}
      <div
        style={{
          marginTop: '16px',
          padding: '8px',
          backgroundColor: '#f5f5f5',
          borderRadius: '4px',
          fontSize: '12px',
          color: '#666',
        }}
      >
        Room: {(config.width / 1000).toFixed(1)}m x {(config.height / 1000).toFixed(1)}m
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
        <button
          onClick={onConfirm}
          style={{
            flex: 1,
            padding: '8px 16px',
            backgroundColor: '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '13px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Create Room
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '8px 16px',
            backgroundColor: '#f0f0f0',
            color: '#333',
            border: '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
