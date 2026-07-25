import type {
  BattleLogEvent,
  BoardState,
  CardState,
  ReplaySnapshot,
} from './ptcgBattleLogReplay.js';
import { replayBattleLog } from './ptcgBattleLogReplay.js';

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function describeEvent(event: BattleLogEvent | null): string {
  if (!event) return '対戦開始時の盤面';
  switch (event.type) {
    case 'draw':
      return `${event.player} が山札から ${event.count} 枚引いた`;
    case 'play-active':
      return `${event.player} が ${event.card.name} をバトル場に出した`;
    case 'play-bench':
      return `${event.player} が ${event.card.name} をベンチに出した`;
    case 'attach-energy':
      return `${event.player} が ${event.targetId} に ${event.energy} エネルギーを付けた`;
    case 'damage':
      return `${event.player} の ${event.targetId} に ${event.amount} ダメージ`;
    case 'knockout':
      return `${event.player} の ${event.targetId} がきぜつ`;
    case 'take-prize':
      return `${event.player} がサイドを ${event.count} 枚取った`;
    case 'end-turn':
      return `ターン終了。次は ${event.nextPlayer}`;
    case 'declare-winner':
      return `${event.player} の勝利`;
  }
}

function cardMarkup(card: CardState | null, emptyLabel: string): string {
  if (!card) return `<div class="card empty">${escapeHtml(emptyLabel)}</div>`;
  const hp = Math.max(0, card.maxHp - card.damage);
  return `<div class="card">
    <strong>${escapeHtml(card.name)}</strong>
    <span>HP ${hp}/${card.maxHp}</span>
    <span>ダメージ ${card.damage}</span>
    <span>エネルギー ${card.energy.length ? card.energy.map(escapeHtml).join(', ') : 'なし'}</span>
    <span>技 ${card.attacks?.length ? card.attacks.map(escapeHtml).join(' / ') : 'なし'}</span>
  </div>`;
}

function playerMarkup(player: string, state: BoardState): string {
  const board = state.players[player];
  return `<section class="player-board">
    <h2>${escapeHtml(player)}${state.currentPlayer === player ? ' <small>現在のプレイヤー</small>' : ''}</h2>
    <div class="counts">
      <span>手札 <b>${board.handCount}</b></span>
      <span>山札 <b>${board.deckCount}</b></span>
      <span>サイド <b>${board.prizesRemaining}</b></span>
      <span>トラッシュ <b>${board.discard.length}</b></span>
    </div>
    <h3>バトル場</h3>
    ${cardMarkup(board.active, 'ポケモンなし')}
    <h3>ベンチ</h3>
    <div class="bench">${board.bench.length ? board.bench.map((card) => cardMarkup(card, '')).join('') : '<span class="muted">ポケモンなし</span>'}</div>
    <details><summary>トラッシュの内容</summary><p>${board.discard.length ? board.discard.map(escapeHtml).join(', ') : 'なし'}</p></details>
  </section>`;
}

export function renderSnapshot(snapshot: ReplaySnapshot, position: number, total: number): string {
  const state = snapshot.state;
  return `<div class="status">
    <span>時点 <b>${position}</b> / ${total - 1}</span>
    <span>ターン <b>${state.turn}</b></span>
    ${state.winner ? `<span class="winner">勝者: ${escapeHtml(state.winner)}</span>` : ''}
  </div>
  <p class="event">${escapeHtml(describeEvent(snapshot.event))}</p>
  <div class="boards">${Object.keys(state.players)
    .map((player) => playerMarkup(player, state))
    .join('')}</div>`;
}

export interface TimelineViewModel {
  battleId: string;
  snapshots: ReplaySnapshot[];
  descriptions: string[];
}

export function createTimelineViewModel(input: unknown): TimelineViewModel {
  const snapshots = replayBattleLog(input);
  const battleId =
    typeof input === 'object' && input !== null && 'battleId' in input
      ? String(input.battleId)
      : '';
  return { battleId, snapshots, descriptions: snapshots.map(({ event }) => describeEvent(event)) };
}

export function renderBattleTimelinePage(input: unknown): string {
  const model = createTimelineViewModel(input);
  const frames = model.snapshots.map((snapshot, index) =>
    renderSnapshot(snapshot, index, model.snapshots.length)
  );
  const encodedFrames = JSON.stringify(frames).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>対戦タイムライン — ${escapeHtml(model.battleId)}</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background:#101827; color:#eef2ff; }
    * { box-sizing:border-box; }
    body { margin:0; padding:24px; max-width:1200px; margin-inline:auto; }
    header { display:flex; gap:16px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    .controls { display:flex; gap:8px; align-items:center; }
    button { min-width:44px; min-height:44px; border:1px solid #64748b; border-radius:8px; padding:8px 14px; background:#1e293b; color:inherit; cursor:pointer; touch-action:manipulation; }
    button:disabled { opacity:.35; cursor:not-allowed; }
    input[type=range] { width:min(420px, 45vw); }
    .status,.counts { display:flex; gap:12px; flex-wrap:wrap; }
    .status span,.counts span { background:#1e293b; padding:6px 10px; border-radius:999px; }
    .event { border-left:4px solid #38bdf8; padding:12px; background:#172033; font-size:1.1rem; }
    .boards { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; }
    .player-board { background:#172033; border:1px solid #334155; border-radius:14px; padding:16px; }
    small { color:#38bdf8; } h3 { margin-bottom:8px; color:#94a3b8; }
    .card { display:grid; gap:4px; border:1px solid #64748b; border-radius:10px; padding:12px; background:#263449; min-width:150px; }
    .card.empty { color:#94a3b8; border-style:dashed; }
    .bench { display:flex; gap:8px; overflow-x:auto; padding-bottom:6px; }
    .muted { color:#94a3b8; } .winner { background:#14532d !important; }
    @media (max-width:600px) {
      body {
        padding:12px;
        padding-top:max(12px, env(safe-area-inset-top));
        padding-right:max(12px, env(safe-area-inset-right));
        padding-bottom:max(12px, env(safe-area-inset-bottom));
        padding-left:max(12px, env(safe-area-inset-left));
      }
      h1 { font-size:1.5rem; margin-bottom:4px; }
      header, .controls { width:100%; }
      .controls { display:grid; grid-template-columns:44px 44px minmax(0,1fr) 44px 44px; position:sticky; top:0; z-index:1; padding:8px 0; background:#101827; }
      .controls button { padding:8px 4px; }
      input[type=range] { width:100%; min-width:0; }
      .boards { grid-template-columns:minmax(0,1fr); }
      .player-board { padding:12px; min-width:0; }
      .event { font-size:1rem; }
      .card { min-width:140px; }
    }
  </style>
</head>
<body>
  <header><div><h1>対戦タイムライン</h1><p>Battle ID: ${escapeHtml(model.battleId)}</p></div>
    <nav class="controls" aria-label="タイムライン操作">
      <button id="first" aria-label="先頭へ">|◀</button><button id="prev" aria-label="前へ">◀</button>
      <input id="timeline" aria-label="時点を選択" type="range" min="0" max="${frames.length - 1}" value="0">
      <button id="next" aria-label="次へ">▶</button><button id="last" aria-label="末尾へ">▶|</button>
    </nav>
  </header>
  <main id="viewer" aria-live="polite"></main>
  <script>
    const frames=${encodedFrames}; let position=0;
    const viewer=document.querySelector('#viewer'), timeline=document.querySelector('#timeline');
    const render=()=>{ viewer.innerHTML=frames[position]; timeline.value=String(position);
      document.querySelector('#first').disabled=document.querySelector('#prev').disabled=position===0;
      document.querySelector('#next').disabled=document.querySelector('#last').disabled=position===frames.length-1; };
    document.querySelector('#first').onclick=()=>{position=0;render()};
    document.querySelector('#prev').onclick=()=>{position=Math.max(0,position-1);render()};
    document.querySelector('#next').onclick=()=>{position=Math.min(frames.length-1,position+1);render()};
    document.querySelector('#last').onclick=()=>{position=frames.length-1;render()};
    timeline.oninput=()=>{position=Number(timeline.value);render()}; render();
  </script>
</body></html>`;
}
