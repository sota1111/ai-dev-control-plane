'use strict';

import fs from 'node:fs';
import path from 'node:path';
import * as runner from '../runner.js';

export interface WorkerCooldown {
  worker: 'antigravity' | 'codex' | 'runner';
  active: boolean;
  resumeAt: string | null;        // ISO8601
  resumeAtEpoch: number | null;   // seconds
  remainingSeconds: number | null;
  remainingHuman: string | null;
}

export interface WorkerCooldownStatus {
  now: string;                    // ISO8601
  degraded: boolean;              // true when BOTH antigravity AND codex are active
  workers: WorkerCooldown[];      // always 3 entries: antigravity, codex, runner
}

/**
 * Human-readable remaining time: "2h 5m" / "45m" / "30s"
 */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return '0s';
  
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  
  return parts.join(' ');
}

export function getWorkerCooldownStatus(nowMs: number = Date.now(), logDir?: string): WorkerCooldownStatus {
  const now = new Date(nowMs);
  const effectiveLogDir = logDir || runner.LOG_DIR;
  
  const workers: WorkerCooldown[] = [
    getJsonWorkerStatus('antigravity', 'antigravity.cooldown.json', nowMs, effectiveLogDir),
    getJsonWorkerStatus('codex', 'codex.cooldown.json', nowMs, effectiveLogDir),
    getRunnerStatus(nowMs)
  ];
  
  const antigravity = workers.find(w => w.worker === 'antigravity')!;
  const codex = workers.find(w => w.worker === 'codex')!;
  
  return {
    now: now.toISOString(),
    degraded: !!(antigravity.active && codex.active),
    workers
  };
}

function getJsonWorkerStatus(worker: 'antigravity' | 'codex', fileName: string, nowMs: number, logDir: string): WorkerCooldown {
  const filePath = path.join(logDir, fileName);
  const inactive: WorkerCooldown = {
    worker,
    active: false,
    resumeAt: null,
    resumeAtEpoch: null,
    remainingSeconds: null,
    remainingHuman: null
  };
  
  try {
    if (!fs.existsSync(filePath)) return inactive;
    
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    const resumeAtEpoch = Number(data.resumeAtEpoch);
    
    if (isNaN(resumeAtEpoch) || resumeAtEpoch * 1000 <= nowMs) {
      return inactive;
    }
    
    const remainingSeconds = Math.max(0, resumeAtEpoch - Math.floor(nowMs / 1000));
    
    return {
      worker,
      active: true,
      resumeAt: new Date(resumeAtEpoch * 1000).toISOString(),
      resumeAtEpoch,
      remainingSeconds,
      remainingHuman: formatRemaining(remainingSeconds)
    };
  } catch {
    return inactive;
  }
}

function getRunnerStatus(nowMs: number): WorkerCooldown {
  const inactive: WorkerCooldown = {
    worker: 'runner',
    active: false,
    resumeAt: null,
    resumeAtEpoch: null,
    remainingSeconds: null,
    remainingHuman: null
  };
  
  try {
    // runner.getUsageLimitCooldownUntil doesn't take logDir as parameter, 
    // it uses runner.COOLDOWN_FILE which is hardcoded in runner.ts.
    // For unit tests of this aggregator, we'll mostly rely on mocking runner.ts or 
    // just accepting that runner status depends on the real COOLDOWN_FILE unless 
    // we mock runner.getUsageLimitCooldownUntil.
    const cooldown = runner.getUsageLimitCooldownUntil(nowMs);
    if (!cooldown || !cooldown.retryAt) return inactive;
    
    const retryAtMs = new Date(cooldown.retryAt).getTime();
    if (isNaN(retryAtMs) || retryAtMs <= nowMs) return inactive;
    
    const resumeAtEpoch = Math.floor(retryAtMs / 1000);
    const remainingSeconds = Math.max(0, resumeAtEpoch - Math.floor(nowMs / 1000));
    
    return {
      worker: 'runner',
      active: true,
      resumeAt: new Date(retryAtMs).toISOString(),
      resumeAtEpoch,
      remainingSeconds,
      remainingHuman: formatRemaining(remainingSeconds)
    };
  } catch {
    return inactive;
  }
}
