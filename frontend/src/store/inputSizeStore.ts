import { create } from 'zustand';
import { apiFetch } from '../lib/backend';
import type { InputSize } from '../lib/pricing';

export type SizeRef = { ref: string; kind: 'Image' | 'Video' };

interface InputSizeState {
  /** Measured input files by ref; null when the backend can't read one. */
  sizes: Record<string, InputSize | null>;
  request: (refs: SizeRef[]) => void;
}

const asked = new Set<string>();

/** The size of each Image or Video Input file a price reads (SeedVR2, FLUX
 * Video Upscale and Edit), asked of the backend once per file, which reads
 * only its header (POST /api/pricing/input-sizes). A failed ask is tried
 * again the next time the file is wanted. */
export const useInputSizeStore = create<InputSizeState>((set) => ({
  sizes: {},
  request: (refs) => {
    const fresh = refs.filter((item) => !asked.has(item.ref)).slice(0, 64);
    if (!fresh.length) return;
    for (const item of fresh) asked.add(item.ref);
    apiFetch('/api/pricing/input-sizes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refs: fresh }),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((body: { sizes?: Record<string, InputSize | null> }) => set((state) => ({ sizes: { ...state.sizes, ...body.sizes } })))
      .catch(() => { for (const item of fresh) asked.delete(item.ref); });
  },
}));
