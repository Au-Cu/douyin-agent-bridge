import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function visualProgressView(id, report, live, operationId) {
  const current = live?.operationId === operationId && live?.id === id;
  const saved = report && typeof report === 'object' ? report : {};
  const matching = !current || (saved.fps === live.fps && saved.completedSegments === live.completed && saved.totalSegments === live.total);
  const completed = nonnegative(current ? live.completed : saved.completedSegments);
  const total = nonnegative(current ? live.total : saved.totalSegments);
  const duration = nonnegative(saved.duration);
  const coverage = matching ? nonnegative(saved.coveredUntil) : null;
  return { id, source: current ? 'running' : 'saved', status: current ? 'running' : saved.status || 'pending',
    completed: total !== null && completed !== null ? Math.min(completed, total) : completed, total,
    fps: nonnegative(current ? live.fps : saved.fps), duration,
    coveredUntil: coverage === null ? null : duration === null ? coverage : Math.min(coverage, duration) };
}
// Presentation only: join an operation to its actual incoming video messages.
// Never attach global progress to a task merely because the need/title matches.
export async function attachVisualProgress(cards, { store, live, readReport = async item => JSON.parse(await readFile(join(dirname(item.path), 'visual-report.json'), 'utf8')) }) {
  const reports = new Map();
  const reportFor = async id => {
    if (!reports.has(id)) reports.set(id, (async () => {
      const item = store.knowledge(id);
      if (!item) return null;
      try { return await readReport(item); } catch { return null; }
    })());
    return reports.get(id);
  };
  return Promise.all(cards.map(async card => {
    const ids = new Set((card.videoIds || []).filter(id => /^\d{5,30}$/.test(id)));
    if (live?.operationId === card.id && /^\d{5,30}$/.test(live.id)) ids.add(live.id);
    const visuals = await Promise.all([...ids].map(async id => visualProgressView(id, await reportFor(id), live, card.id)));
    return { ...card, visuals };
  }));
}
