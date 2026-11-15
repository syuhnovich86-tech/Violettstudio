export type MediaPage = { offset: number; browseYear: number | undefined };

export function nextMediaPage(lastCount: number, lastPage: MediaPage, filterYear: number | undefined, years: number[]): MediaPage | undefined {
  if (lastCount === 100) return { ...lastPage, offset: lastPage.offset + 100 };
  if (filterYear === undefined && lastPage.browseYear !== undefined) {
    const index = years.indexOf(lastPage.browseYear);
    const next = index < 0 ? undefined : years[index + 1];
    if (next !== undefined) return { offset: 0, browseYear: next };
  }
  return undefined;
}

export function yearAtPosition(years: number[], position: number): number | undefined {
  if (!years.length || !Number.isFinite(position)) return undefined;
  return years[Math.round(Math.max(0, Math.min(1, position)) * (years.length - 1))];
}
