import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTimelineViewModel,
  renderBattleTimelinePage,
  renderSnapshot,
} from '../lib/ptcgBattleTimelineViewer.js';

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'src/__tests__/fixtures/battle-log.valid.json'), 'utf8')
);
const snapshotFixture = JSON.parse(
  readFileSync(join(process.cwd(), 'src/__tests__/fixtures/battle-log.snapshot.json'), 'utf8')
);

describe('battle timeline viewer', () => {
  test('exposes the initial board and every replay point', () => {
    const model = createTimelineViewModel(fixture);
    expect(model.battleId).toBe('fixture-001');
    expect(model.snapshots).toHaveLength(fixture.events.length + 1);
    expect(model.descriptions[0]).toBe('対戦開始時の盤面');
    expect(model.descriptions.at(-1)).toBe('matsu の勝利');
  });

  test('renders board zones, counts, and the event at an arbitrary point', () => {
    const model = createTimelineViewModel(fixture);
    const frame = renderSnapshot(model.snapshots[3], 3, model.snapshots.length);
    expect(frame).toContain('Matsu EX');
    expect(frame).toContain('Take EX');
    expect(frame).toContain('手札');
    expect(frame).toContain('山札');
    expect(frame).toContain('サイド');
    expect(frame).toContain('トラッシュ');
    expect(frame).toContain('fire エネルギー');
  });

  test('renders concrete Pokemon names and attacks for human review', () => {
    const page = renderBattleTimelinePage(snapshotFixture);
    expect(page).toContain('ピカチュウex');
    expect(page).toContain('リザードンex');
    expect(page).toContain('エレキサークル 60');
    expect(page).toContain('バーニングダーク 180+');
    expect(page).toContain('エレキサークル 60（必要エネルギー 雷）');
    expect(page).toContain('サンダーボルト 200（必要エネルギー 雷・雷・無）');
  });

  test('provides bounded first, previous, next, last, and arbitrary navigation', () => {
    const page = renderBattleTimelinePage(fixture);
    expect(page).toContain('id="first"');
    expect(page).toContain('id="prev"');
    expect(page).toContain('id="next"');
    expect(page).toContain('id="last"');
    expect(page).toContain('type="range" min="0" max="7"');
    expect(page).toContain('Math.max(0,position-1)');
    expect(page).toContain('Math.min(frames.length-1,position+1)');
    expect(page).toContain('position===0');
    expect(page).toContain('position===frames.length-1');
  });

  test('provides an iPhone-safe responsive layout and touch-sized controls', () => {
    const page = renderBattleTimelinePage(fixture);
    expect(page).toContain('viewport-fit=cover');
    expect(page).toContain('@media (max-width:600px)');
    expect(page).toContain('env(safe-area-inset-bottom)');
    expect(page).toContain('min-height:44px');
    expect(page).toContain('touch-action:manipulation');
    expect(page).toContain('grid-template-columns:minmax(0,1fr)');
  });

  test('escapes log-provided display values before embedding HTML', () => {
    const unsafe = structuredClone(fixture);
    unsafe.battleId = '<img src=x onerror=alert(1)>';
    unsafe.events[0].card.name = '<script>alert(1)</script>';
    const page = renderBattleTimelinePage(unsafe);
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
