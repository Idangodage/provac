'use client';

import { X, RotateCcw, Check, Pen } from 'lucide-react';
import React, { useRef, useEffect, useState } from 'react';

export interface SignaturePadProps {
  onSave: (signatureData: string, signedBy?: string) => void;
  onCancel: () => void;
  initialData?: string | null;
  width?: number;
  height?: number;
}

/**
 * Signature pad component for capturing digital signatures.
 */
export const SignaturePad: React.FC<SignaturePadProps> = ({
  onSave,
  onCancel,
  initialData,
  width = 500,
  height = 200,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [signedBy, setSignedBy] = useState('');
  const [hasSignature, setHasSignature] = useState(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    canvas.width = width;
    canvas.height = height;

    // Set drawing styles
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Fill with white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // Load initial data if provided
    if (initialData) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        setHasSignature(true);
      };
      img.src = initialData;
    }
  }, [width, height, initialData]);

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    if ('touches' in e) {
      const touch = e.touches[0];
      if (!touch) return null;
      return {
        x: (touch.clientX - rect.left) * scaleX,
        y: (touch.clientY - rect.top) * scaleY,
      };
    } else {
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };
    }
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const coords = getCoordinates(e);
    if (!coords) return;

    setIsDrawing(true);
    lastPointRef.current = coords;
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (!isDrawing) return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const coords = getCoordinates(e);
    if (!coords || !lastPointRef.current) return;

    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(coords.x, coords.y);
    ctx.stroke();

    lastPointRef.current = coords;
    setHasSignature(true);
  };

  const stopDrawing = () => {
    setIsDrawing(false);
    lastPointRef.current = null;
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasSignature) return;

    const signatureData = canvas.toDataURL('image/png');
    onSave(signatureData, signedBy || undefined);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
      }}
    >
      <div
        style={{
          backgroundColor: 'white',
          borderRadius: 8,
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.3)',
          maxWidth: 600,
          width: '90%',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #e0e0e0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Pen size={20} color="#0066cc" />
            <h3 style={{ margin: 0, fontSize: 16 }}>Digital Signature</h3>
          </div>
          <button
            onClick={onCancel}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <X size={20} color="#666" />
          </button>
        </div>

        {/* Canvas */}
        <div style={{ padding: 20 }}>
          <div
            style={{
              border: '1px solid #ccc',
              borderRadius: 4,
              overflow: 'hidden',
              backgroundColor: '#fafafa',
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                display: 'block',
                width: '100%',
                height: 'auto',
                cursor: 'crosshair',
                touchAction: 'none',
              }}
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
            />
          </div>

          <p
            style={{
              fontSize: 11,
              color: '#999',
              textAlign: 'center',
              margin: '8px 0 0 0',
            }}
          >
            Draw your signature above
          </p>

          {/* Signed By Input */}
          <div style={{ marginTop: 16 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>
              Signed By (Optional)
            </label>
            <input
              type="text"
              value={signedBy}
              onChange={(e) => setSignedBy(e.target.value)}
              placeholder="Enter your name"
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: 13,
                border: '1px solid #ddd',
                borderRadius: 4,
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* Actions */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderTop: '1px solid #e0e0e0',
            backgroundColor: '#f8f9fa',
          }}
        >
          <button
            onClick={clearSignature}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 16px',
              fontSize: 13,
              backgroundColor: 'white',
              color: '#666',
              border: '1px solid #ddd',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            <RotateCcw size={14} />
            Clear
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onCancel}
              style={{
                padding: '8px 16px',
                fontSize: 13,
                backgroundColor: 'white',
                color: '#666',
                border: '1px solid #ddd',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasSignature}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 20px',
                fontSize: 13,
                backgroundColor: hasSignature ? '#0066cc' : '#ccc',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                cursor: hasSignature ? 'pointer' : 'not-allowed',
              }}
            >
              <Check size={14} />
              Save Signature
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignaturePad;
