import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
afterEach(() => cleanup());

// jsdom has no PointerEvent; give fireEvent.pointer* real coordinates.
if (typeof window !== 'undefined' && !window.PointerEvent) {
  class PointerEvent extends MouseEvent {
    constructor(type, params = {}) { super(type, params); this.pointerId = params.pointerId ?? 0; this.pointerType = params.pointerType || 'mouse'; }
  }
  window.PointerEvent = PointerEvent;
}
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
