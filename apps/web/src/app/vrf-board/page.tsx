'use client';

import dynamic from 'next/dynamic';

// Browser-only (Konva) — no SSR.
const VrfBoard = dynamic(
  () => import('@provacx/drawing-engine/vrf').then((m) => m.VrfBoard),
  {
    ssr: false,
    loading: () => <div style={{ padding: 24, color: '#5f5e5a' }}>Loading board…</div>,
  },
);
const Toolbar = dynamic(
  () => import('@provacx/drawing-engine/vrf').then((m) => m.Toolbar),
  { ssr: false, loading: () => null },
);

export default function VrfBoardPage() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <Toolbar />
      <div style={{ flex: 1, minHeight: 0 }}>
        <VrfBoard />
      </div>
    </div>
  );
}
