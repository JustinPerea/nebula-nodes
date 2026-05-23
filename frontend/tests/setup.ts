import '@testing-library/jest-dom';

// JSDOM does not implement document.elementsFromPoint. Define a no-op stub so
// vi.spyOn can intercept it in tests that mock the return value.
if (typeof document.elementsFromPoint !== 'function') {
  document.elementsFromPoint = (_x: number, _y: number): Element[] => [];
}
