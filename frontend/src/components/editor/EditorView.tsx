export function EditorView() {
  // Placeholder zIndex sits BELOW the CanvasTabs pill (var(--sr-layer-panel, 100))
  // so the user can click Canvas to return. Full surface lands in Task 16.
  return (
    <div style={{ position: 'fixed', inset: 0, color: '#fff', padding: '120px 80px 80px', background: '#000', zIndex: 1 }}>
      Editor placeholder — full surface lands in Task 16
    </div>
  );
}
