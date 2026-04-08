'use client';

import {
  Trash2,
  Copy,
  ChevronUp,
  ChevronDown,
  ChevronsUp,
  ChevronsDown,
  Lock,
  Unlock,
  Eye,
  EyeOff,
} from 'lucide-react';
import React from 'react';

import type { EditorElement, TextElement, TextStyle } from '../../types';

export interface PropertyPanelProps {
  element: EditorElement | null;
  onUpdate: (id: string, updates: Partial<EditorElement>) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onReorder: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => void;
}

/**
 * Property panel for editing selected element properties.
 */
export const PropertyPanel: React.FC<PropertyPanelProps> = ({
  element,
  onUpdate,
  onDelete,
  onDuplicate,
  onReorder,
}) => {
  if (!element) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>
        <p style={{ fontSize: 13 }}>Select an element to edit its properties</p>
      </div>
    );
  }

  const sectionStyle: React.CSSProperties = {
    padding: '12px 15px',
    borderBottom: '1px solid #e0e0e0',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 4,
    color: '#666',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    fontSize: 12,
    border: '1px solid #ddd',
    borderRadius: 4,
    boxSizing: 'border-box',
  };

  const buttonStyle: React.CSSProperties = {
    padding: '6px',
    backgroundColor: '#f0f0f0',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div style={{ fontSize: 12 }}>
      {/* Header */}
      <div
        style={{
          padding: '12px 15px',
          backgroundColor: '#f8f9fa',
          borderBottom: '1px solid #e0e0e0',
        }}
      >
        <h4 style={{ margin: 0, fontSize: 13 }}>Properties</h4>
        <span style={{ fontSize: 11, color: '#666' }}>{element.type.toUpperCase()}</span>
      </div>

      {/* Quick Actions */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <button
            onClick={() => onReorder(element.id, 'top')}
            title="Bring to Front"
            style={buttonStyle}
          >
            <ChevronsUp size={14} />
          </button>
          <button
            onClick={() => onReorder(element.id, 'up')}
            title="Bring Forward"
            style={buttonStyle}
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => onReorder(element.id, 'down')}
            title="Send Backward"
            style={buttonStyle}
          >
            <ChevronDown size={14} />
          </button>
          <button
            onClick={() => onReorder(element.id, 'bottom')}
            title="Send to Back"
            style={buttonStyle}
          >
            <ChevronsDown size={14} />
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => onUpdate(element.id, { locked: !element.locked })}
            title={element.locked ? 'Unlock' : 'Lock'}
            style={{
              ...buttonStyle,
              backgroundColor: element.locked ? '#ff6b6b' : '#f0f0f0',
              color: element.locked ? 'white' : '#333',
            }}
          >
            {element.locked ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
          <button
            onClick={() => onUpdate(element.id, { visible: !element.visible })}
            title={element.visible ? 'Hide' : 'Show'}
            style={buttonStyle}
          >
            {element.visible ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => onDuplicate(element.id)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: '8px',
              fontSize: 11,
              backgroundColor: '#e8f4f8',
              color: '#0066cc',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            <Copy size={12} />
            Duplicate
          </button>
          <button
            onClick={() => onDelete(element.id)}
            disabled={element.locked}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: '8px',
              fontSize: 11,
              backgroundColor: element.locked ? '#e0e0e0' : '#ffe6e6',
              color: element.locked ? '#999' : '#cc0000',
              border: 'none',
              borderRadius: 4,
              cursor: element.locked ? 'not-allowed' : 'pointer',
            }}
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      </div>

      {/* Position & Size */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Position & Size</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <label style={{ fontSize: 10, color: '#999' }}>X</label>
            <input
              type="number"
              value={Math.round(element.x)}
              onChange={(e) => onUpdate(element.id, { x: parseFloat(e.target.value) || 0 })}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#999' }}>Y</label>
            <input
              type="number"
              value={Math.round(element.y)}
              onChange={(e) => onUpdate(element.id, { y: parseFloat(e.target.value) || 0 })}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#999' }}>Width</label>
            <input
              type="number"
              value={Math.round(element.width)}
              onChange={(e) => onUpdate(element.id, { width: parseFloat(e.target.value) || 0 })}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: '#999' }}>Height</label>
            <input
              type="number"
              value={Math.round(element.height)}
              onChange={(e) => onUpdate(element.id, { height: parseFloat(e.target.value) || 0 })}
              style={inputStyle}
            />
          </div>
        </div>
      </div>

      {/* Text Properties */}
      {element.type === 'text' && (
        <TextProperties
          element={element as TextElement}
          onUpdate={onUpdate}
          labelStyle={labelStyle}
          inputStyle={inputStyle}
          sectionStyle={sectionStyle}
        />
      )}

      {/* Shape Properties */}
      {(element.type === 'rectangle' || element.type === 'circle') && (
        <ShapeProperties
          element={element}
          onUpdate={onUpdate}
          labelStyle={labelStyle}
          inputStyle={inputStyle}
          sectionStyle={sectionStyle}
        />
      )}

      {/* Line Properties */}
      {element.type === 'line' && (
        <LineProperties
          element={element}
          onUpdate={onUpdate}
          labelStyle={labelStyle}
          inputStyle={inputStyle}
          sectionStyle={sectionStyle}
        />
      )}

      {/* Image Properties */}
      {element.type === 'image' && (
        <ImageProperties
          element={element}
          onUpdate={onUpdate}
          labelStyle={labelStyle}
          inputStyle={inputStyle}
          sectionStyle={sectionStyle}
        />
      )}

      {/* Advanced Properties */}
      <AdvancedProperties
        element={element}
        onUpdate={onUpdate}
        labelStyle={labelStyle}
        inputStyle={inputStyle}
        sectionStyle={sectionStyle}
      />
    </div>
  );
};

// Sub-components for specific element types
const TextProperties: React.FC<{
  element: TextElement;
  onUpdate: (id: string, updates: Partial<EditorElement>) => void;
  labelStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
  sectionStyle: React.CSSProperties;
}> = ({ element, onUpdate, labelStyle, inputStyle, sectionStyle }) => {
  const textStyle = element.textStyle;

  const updateTextStyle = (updates: Partial<TextStyle>) => {
    onUpdate(element.id, {
      textStyle: { ...textStyle, ...updates },
    } as any);
  };

  return (
    <div style={sectionStyle}>
      <label style={labelStyle}>Text Style</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <label style={{ fontSize: 10, color: '#999' }}>Font Family</label>
          <select
            value={textStyle.fontFamily}
            onChange={(e) => updateTextStyle({ fontFamily: e.target.value })}
            style={inputStyle}
          >
            {['Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Courier New'].map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 10, color: '#999' }}>Font Size</label>
          <input
            type="number"
            value={textStyle.fontSize}
            onChange={(e) => updateTextStyle({ fontSize: parseInt(e.target.value) || 12 })}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={{ fontSize: 10, color: '#999' }}>Color</label>
          <input
            type="color"
            value={textStyle.color}
            onChange={(e) => updateTextStyle({ color: e.target.value })}
            style={{ ...inputStyle, padding: 2, height: 30 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 10, color: '#999' }}>Align</label>
          <select
            value={textStyle.align}
            onChange={(e) => updateTextStyle({ align: e.target.value as any })}
            style={inputStyle}
          >
            {['left', 'center', 'right', 'justify'].map((align) => (
              <option key={align} value={align}>
                {align.charAt(0).toUpperCase() + align.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          onClick={() => updateTextStyle({ bold: !textStyle.bold })}
          style={{
            padding: '6px 12px',
            backgroundColor: textStyle.bold ? '#0066cc' : '#f0f0f0',
            color: textStyle.bold ? 'white' : '#333',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          B
        </button>
        <button
          onClick={() => updateTextStyle({ italic: !textStyle.italic })}
          style={{
            padding: '6px 12px',
            backgroundColor: textStyle.italic ? '#0066cc' : '#f0f0f0',
            color: textStyle.italic ? 'white' : '#333',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontStyle: 'italic',
          }}
        >
          I
        </button>
        <button
          onClick={() => updateTextStyle({ underline: !textStyle.underline })}
          style={{
            padding: '6px 12px',
            backgroundColor: textStyle.underline ? '#0066cc' : '#f0f0f0',
            color: textStyle.underline ? 'white' : '#333',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          U
        </button>
      </div>
    </div>
  );
};

const ShapeProperties: React.FC<{
  element: EditorElement;
  onUpdate: (id: string, updates: Partial<EditorElement>) => void;
  labelStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
  sectionStyle: React.CSSProperties;
}> = ({ element, onUpdate, labelStyle, inputStyle, sectionStyle }) => (
  <div style={sectionStyle}>
    <label style={labelStyle}>Shape Style</label>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <div>
        <label style={{ fontSize: 10, color: '#999' }}>Fill Color</label>
        <input
          type="color"
          value={(element as any).fillColor || '#ffffff'}
          onChange={(e) => onUpdate(element.id, { fillColor: e.target.value } as any)}
          style={{ ...inputStyle, padding: 2, height: 30 }}
        />
      </div>
      <div>
        <label style={{ fontSize: 10, color: '#999' }}>Stroke Color</label>
        <input
          type="color"
          value={(element as any).strokeColor || '#000000'}
          onChange={(e) => onUpdate(element.id, { strokeColor: e.target.value } as any)}
          style={{ ...inputStyle, padding: 2, height: 30 }}
        />
      </div>
      <div style={{ gridColumn: 'span 2' }}>
        <label style={{ fontSize: 10, color: '#999' }}>Stroke Width</label>
        <input
          type="number"
          value={(element as any).strokeWidth || 1}
          onChange={(e) => onUpdate(element.id, { strokeWidth: parseInt(e.target.value) || 1 } as any)}
          style={inputStyle}
        />
      </div>
    </div>
  </div>
);

const LineProperties: React.FC<{
  element: EditorElement;
  onUpdate: (id: string, updates: Partial<EditorElement>) => void;
  labelStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
  sectionStyle: React.CSSProperties;
}> = ({ element, onUpdate, labelStyle, inputStyle, sectionStyle }) => (
  <div style={sectionStyle}>
    <label style={labelStyle}>Line Style</label>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <div>
        <label style={{ fontSize: 10, color: '#999' }}>Color</label>
        <input
          type="color"
          value={(element as any).strokeColor || '#000000'}
          onChange={(e) => onUpdate(element.id, { strokeColor: e.target.value } as any)}
          style={{ ...inputStyle, padding: 2, height: 30 }}
        />
      </div>
      <div>
        <label style={{ fontSize: 10, color: '#999' }}>Width</label>
        <input
          type="number"
          value={(element as any).strokeWidth || 2}
          onChange={(e) => onUpdate(element.id, { strokeWidth: parseInt(e.target.value) || 2 } as any)}
          style={inputStyle}
        />
      </div>
      <div style={{ gridColumn: 'span 2' }}>
        <label style={{ fontSize: 10, color: '#999' }}>Style</label>
        <select
          value={(element as any).lineStyle || 'solid'}
          onChange={(e) => onUpdate(element.id, { lineStyle: e.target.value } as any)}
          style={inputStyle}
        >
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
          <option value="dotted">Dotted</option>
        </select>
      </div>
    </div>
  </div>
);

const ImageProperties: React.FC<{
  element: EditorElement;
  onUpdate: (id: string, updates: Partial<EditorElement>) => void;
  labelStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
  sectionStyle: React.CSSProperties;
}> = ({ element, onUpdate, labelStyle, inputStyle, sectionStyle }) => {
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      onUpdate(element.id, { src: event.target?.result as string } as any);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div style={sectionStyle}>
      <label style={labelStyle}>Image</label>
      <input
        type="file"
        accept="image/*"
        onChange={handleImageUpload}
        style={{ marginBottom: 8, fontSize: 11 }}
      />
      <div>
        <label style={{ fontSize: 10, color: '#999' }}>Fit Mode</label>
        <select
          value={(element as any).objectFit || 'contain'}
          onChange={(e) => onUpdate(element.id, { objectFit: e.target.value } as any)}
          style={inputStyle}
        >
          <option value="contain">Contain</option>
          <option value="cover">Cover</option>
          <option value="fill">Fill</option>
          <option value="none">None</option>
        </select>
      </div>
    </div>
  );
};

const AdvancedProperties: React.FC<{
  element: EditorElement;
  onUpdate: (id: string, updates: Partial<EditorElement>) => void;
  labelStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
  sectionStyle: React.CSSProperties;
}> = ({ element, onUpdate, labelStyle, inputStyle, sectionStyle }) => {
  const advancedStyle = element.advancedStyle || {};

  const updateAdvancedStyle = (updates: Partial<typeof advancedStyle>) => {
    onUpdate(element.id, {
      advancedStyle: { ...advancedStyle, ...updates },
    });
  };

  return (
    <div style={sectionStyle}>
      <label style={labelStyle}>Advanced</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <label style={{ fontSize: 10, color: '#999' }}>Opacity (%)</label>
          <input
            type="number"
            min={0}
            max={100}
            value={advancedStyle.opacity ?? 100}
            onChange={(e) => updateAdvancedStyle({ opacity: parseInt(e.target.value) || 100 })}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={{ fontSize: 10, color: '#999' }}>Rotation (°)</label>
          <input
            type="number"
            value={advancedStyle.transform?.rotation ?? 0}
            onChange={(e) =>
              updateAdvancedStyle({
                transform: { ...advancedStyle.transform, rotation: parseInt(e.target.value) || 0 },
              })
            }
            style={inputStyle}
          />
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label style={{ fontSize: 10, color: '#999' }}>Border Radius</label>
          <input
            type="number"
            value={advancedStyle.border?.radius ?? 0}
            onChange={(e) =>
              updateAdvancedStyle({
                border: { ...advancedStyle.border, radius: parseInt(e.target.value) || 0, width: 0, style: 'solid', color: '#000' },
              })
            }
            style={inputStyle}
          />
        </div>
      </div>
    </div>
  );
};

export default PropertyPanel;
