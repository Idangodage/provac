'use client';

import dynamic from 'next/dynamic';

// Dynamically import to avoid SSR issues (the engine bundle is browser-only).
const PipeStudioCanvas = dynamic(
  () => import('@provacx/drawing-engine/components').then((m) => m.PipeStudioCanvas),
  {
    ssr: false,
    loading: () => (
      <div style={{ padding: 48, color: '#5f5e5a' }}>Loading pipe editor…</div>
    ),
  },
);

export default function PipeStudioPage() {
  return (
    <div style={{ maxWidth: 760, margin: '40px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 6 }}>VRF pipe editor</h1>
      <p style={{ fontSize: 14, color: '#5f5e5a', marginBottom: 20 }}>
        Draw a centerline, see the concentric gas/liquid pair with arc fittings, and edit the path.
      </p>
      <PipeStudioCanvas />
    </div>
  );
}
