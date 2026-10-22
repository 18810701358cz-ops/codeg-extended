/**
 * Layout for component tests: jsdom lays nothing out — every element is 0
 * tall, and the ResizeObserver stub in `test-setup.ts` never reports.
 */

/**
 * Lay out a clamped block: every element reads the given `scrollHeight` and
 * `clientHeight`, and a ResizeObserver reports each element as it starts
 * observing it, the way a browser reports a node at its first layout. Call
 * before rendering; returns the undo.
 */
export function mockClampLayout(
  scrollHeight: number,
  clientHeight: number
): () => void {
  const descriptors = (["scrollHeight", "clientHeight"] as const).map(
    (prop) =>
      [prop, Object.getOwnPropertyDescriptor(Element.prototype, prop)] as const
  )
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  })
  const InertResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target } as ResizeObserverEntry],
        this as unknown as ResizeObserver
      )
    }
    unobserve() {}
    disconnect() {}
  }
  return () => {
    globalThis.ResizeObserver = InertResizeObserver
    for (const [prop, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Element.prototype, prop, descriptor)
    }
  }
}
