/**
 * Lightweight ordered timeline collector used by the C2 runtime.
 */
export class RuntimeTimeline {
  private items: string[] = [];
  add(event: string) {
    if (!event) return;
    this.items.push(event);
  }
  list(): string[] {
    return [...this.items];
  }
}