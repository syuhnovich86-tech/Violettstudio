/** Select a healthy server before sending a request; never replay mutations. */
export class OriginSelector {
  private selected: string;
  private validUntil = 0;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly primary: string,
    private readonly fallback: string,
    private readonly probe: (origin: string) => Promise<boolean>,
    private readonly now: () => number = Date.now,
  ) { this.selected = primary; }

  current() { return this.selected; }
  invalidate() { this.validUntil = 0; }

  async resolve(): Promise<string> {
    if (this.now() < this.validUntil) return this.selected;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const direct = await this.probe(this.primary);
      const backup = !direct && await this.probe(this.fallback);
      if (direct) this.selected = this.primary;
      else if (backup) this.selected = this.fallback;
      // Retry soon when neither route is available; don't invent a success.
      this.validUntil = this.now() + (direct || backup ? 30_000 : 5_000);
      return this.selected;
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
}

export async function probeOrigin(origin: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${origin}/health`, { signal: controller.signal, cache: 'no-store' });
    return response.ok;
  } catch { return false; }
  finally { clearTimeout(timer); }
}
