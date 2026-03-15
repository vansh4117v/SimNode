/**
 * Generic min-heap priority queue.
 * O(log n) push/pop, used as the timer scheduling backbone.
 */
export class MinHeap<T> {
  private heap: T[] = [];

  constructor(private readonly comparator: (a: T, b: T) => number) {}

  get size(): number {
    return this.heap.length;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  push(value: T): void {
    this.heap.push(value);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    const n = this.heap.length;
    if (n === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  /** Remove first entry matching predicate. Returns true if found. */
  remove(predicate: (v: T) => boolean): boolean {
    const idx = this.heap.findIndex(predicate);
    if (idx === -1) return false;
    const last = this.heap.pop()!;
    if (idx < this.heap.length) {
      this.heap[idx] = last;
      this.bubbleUp(idx);
      this.sinkDown(idx);
    }
    return true;
  }

  toArray(): T[] {
    return [...this.heap];
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.comparator(this.heap[i], this.heap[parent]) >= 0) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.comparator(this.heap[left], this.heap[smallest]) < 0)
        smallest = left;
      if (right < n && this.comparator(this.heap[right], this.heap[smallest]) < 0)
        smallest = right;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}
