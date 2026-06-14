'use strict';

const { execSync } = require('child_process');

function escapeEnvValue(value) {
  // Escape backslash and comma for gcloud --update-env-vars format
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

function buildEnvVarString(envVars) {
  return Object.entries(envVars)
    .map(([k, v]) => k + '=' + escapeEnvValue(String(v)))
    .join(',');
}

async function syncCloudRunEnvVars(appConfig, envVars) {
  const { name, cloudRunService, region, gcpProject, cloudRunSyncEnabled } = appConfig;

  if (!cloudRunSyncEnabled) {
    console.log('[SKIP] ' + name + ': cloudRunSyncEnabled=false (not yet migrated to Firebase Auth)');
    return { skipped: true, reason: 'cloudRunSyncEnabled is false' };
  }

  const allowedEmails = envVars.ALLOWED_USER_EMAILS;
  if (!allowedEmails || String(allowedEmails).trim() === '') {
    throw new Error(
      'ALLOWED_USER_EMAILS が空です。空のメールリストを本番 Cloud Run へ反映することはできません。\n' +
      '少なくとも1件のメールアドレスを指定してください。'
    );
  }

  const varNames = Object.keys(envVars).join(', ');
  console.log('[SYNC] ' + name + ': ' + cloudRunService + ' (' + region + ') — updating: ' + varNames);

  const envVarStr = buildEnvVarString(envVars);
  const cmd = 'gcloud run services update ' + cloudRunService +
    ' --region ' + region +
    ' --project ' + gcpProject +
    ' --update-env-vars ' + envVarStr +
    ' --quiet';

  try {
    const output = execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    console.log('[OK] ' + name + ': Cloud Run updated successfully');
    return { success: true, app: name };
  } catch (err) {
    const errMsg = err.stderr ? err.stderr.toString() : (err.message || 'unknown error');
    throw new Error('Cloud Run update failed for ' + name + ': ' + errMsg);
  }
}

module.exports = { syncCloudRunEnvVars };
