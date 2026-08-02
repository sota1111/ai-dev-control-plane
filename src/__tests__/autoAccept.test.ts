import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AUTO_ACCEPT_CONFIG,
  loadAutoAcceptConfig,
  resolveReviewDirective,
  shouldHoldForHuman,
  markAutoAccepted,
  wasRecentlyAutoAccepted,
  clearAutoAcceptedMarkers,
} from '../lib/autoAccept.js';

describe('autoAccept — loadAutoAcceptConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-accept-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns enabled defaults when the config file is missing', () => {
    const cfg = loadAutoAcceptConfig(path.join(dir, 'missing.json'));
    expect(cfg).toEqual(DEFAULT_AUTO_ACCEPT_CONFIG);
    expect(cfg.enabled).toBe(true);
  });

  it('fails CLOSED (disabled) on an unparseable config — acceptance is a safety boundary', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ not json');
    expect(loadAutoAcceptConfig(file).enabled).toBe(false);
  });

  it('reads enabled/hold_labels/hold_title_prefixes and ignores __doc__', () => {
    const file = path.join(dir, 'ok.json');
    fs.writeFileSync(file, JSON.stringify({
      __doc__: 'x',
      enabled: true,
      hold_labels: ['human-review', 'design-change'],
      hold_title_prefixes: ['[PLAN]'],
    }));
    const cfg = loadAutoAcceptConfig(file);
    expect(cfg.enabled).toBe(true);
    expect(cfg.holdLabels).toEqual(['human-review', 'design-change']);
    expect(cfg.holdTitlePrefixes).toEqual(['[PLAN]']);
  });

  it('honors enabled=false', () => {
    const file = path.join(dir, 'off.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: false }));
    expect(loadAutoAcceptConfig(file).enabled).toBe(false);
  });
});

describe('autoAccept — resolveReviewDirective', () => {
  it('returns null when no directive is present', () => {
    expect(resolveReviewDirective(['some description', 'a comment'])).toBeNull();
  });

  it('finds review=human in a description', () => {
    expect(resolveReviewDirective(['## 目的\nreview=human\n...'])).toBe('human');
  });

  it('newest occurrence wins across description and comments', () => {
    expect(resolveReviewDirective(['review=human', 'later comment: review=auto'])).toBe('auto');
    expect(resolveReviewDirective(['review=auto', 'review=human'])).toBe('human');
  });

  it('is case-insensitive and tolerates spaces around =', () => {
    expect(resolveReviewDirective(['Review = Human'])).toBe('human');
  });

  it('does not match inside other words', () => {
    expect(resolveReviewDirective(['previewer=humanoid'])).toBeNull();
  });
});

describe('autoAccept — shouldHoldForHuman', () => {
  const cfg = DEFAULT_AUTO_ACCEPT_CONFIG;

  it('does not hold a routine issue', () => {
    const d = shouldHoldForHuman(cfg, { title: 'usage-limit後のresume保存', labels: ['auto-improve'] });
    expect(d.hold).toBe(false);
  });

  it('holds on the human-review label (case-insensitive)', () => {
    expect(shouldHoldForHuman(cfg, { labels: ['Human-Review'] }).hold).toBe(true);
  });

  it('holds on a [PLAN] / [QUESTION] title prefix', () => {
    expect(shouldHoldForHuman(cfg, { title: '[PLAN] 設計方針' }).hold).toBe(true);
    expect(shouldHoldForHuman(cfg, { title: '  [QUESTION] どちらが良い?' }).hold).toBe(true);
    expect(shouldHoldForHuman(cfg, { title: 'implement [PLAN] parser' }).hold).toBe(false);
  });

  it('holds on review=human directive; review=auto overrides labels/prefixes', () => {
    expect(shouldHoldForHuman(cfg, { directiveTexts: ['review=human'] }).hold).toBe(true);
    expect(shouldHoldForHuman(cfg, {
      title: '[PLAN] x',
      labels: ['human-review'],
      directiveTexts: ['review=auto'],
    }).hold).toBe(false);
  });
});

describe('autoAccept — auto-accepted markers', () => {
  beforeEach(() => clearAutoAcceptedMarkers());

  it('remembers a marked issue within the TTL', () => {
    const now = 1_000_000;
    markAutoAccepted('SOT-1', now);
    expect(wasRecentlyAutoAccepted('SOT-1', now + 60_000)).toBe(true);
    expect(wasRecentlyAutoAccepted('SOT-2', now)).toBe(false);
  });

  it('expires after the TTL', () => {
    const now = 1_000_000;
    markAutoAccepted('SOT-1', now);
    expect(wasRecentlyAutoAccepted('SOT-1', now + 16 * 60 * 1000)).toBe(false);
  });
});
