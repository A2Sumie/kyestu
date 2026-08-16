export type Listener<T> = (event: T) => void

export class Emitter<T> {
  private listeners = new Set<Listener<T>>()

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // listener faults are isolated from the runtime
      }
    }
  }
}
