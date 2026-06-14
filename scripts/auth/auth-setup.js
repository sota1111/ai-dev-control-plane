'use strict';

const readline = require('readline');
const path = require('path');
const { createOrUpdateUser } = require('./firebase-user');
const { syncCloudRunEnvVars } = require('./cloudrun-sync');

const APPS_CONFIG_PATH = path.join(__dirname, '../../config/auth/apps.json');

function loadApps() {
  try {
    return require(APPS_CONFIG_PATH);
  } catch (e) {
    console.error('Error: config/auth/apps.json not found at ' + APPS_CONFIG_PATH);
    process.exit(1);
  }
}

function readLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readPassword(promptText) {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let password = '';
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '') {
        process.stdout.write('\n');
        process.exit(0);
      } else if (char === '') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        password += char;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

function showAppsStatus(apps) {
  console.log('\n=== アプリ認証移行状況 ===');
  console.log('');
  apps.forEach((app) => {
    const status = app.authMigrationStatus === 'done' ? '✓ 移行済み' : '○ 未移行';
    const sync = app.cloudRunSyncEnabled ? '[sync有効]' : '[sync無効]';
    console.log('  ' + app.name + ' — ' + status + ' ' + sync + ' (' + app.frameworkType + ')');
    if (app.notes) {
      console.log('    注意: ' + app.notes);
    }
  });
  console.log('');
}

async function runFirebaseUserSetup() {
  console.log('\n=== Firebase ユーザー作成/更新 ===');
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    console.log('FIREBASE_PROJECT_ID が設定されていません。');
    const pid = await readLine('Firebase プロジェクトID を入力してください: ');
    if (!pid) { console.log('キャンセルしました。'); return; }
    process.env.FIREBASE_PROJECT_ID = pid;
  }
  console.log('プロジェクト: ' + process.env.FIREBASE_PROJECT_ID);

  const email = await readLine('メールアドレス: ');
  if (!email || !email.includes('@')) {
    console.log('有効なメールアドレスを入力してください。');
    return;
  }

  const password = await readPassword('パスワード (非表示): ');
  if (!password || password.length < 6) {
    console.log('パスワードは6文字以上必要です。');
    return;
  }

  console.log('\n以下の操作を実行します:');
  console.log('  Firebase プロジェクト: ' + process.env.FIREBASE_PROJECT_ID);
  console.log('  メールアドレス: ' + email);
  console.log('  操作: ユーザー作成または更新 (emailVerified=true)');
  console.log('');
  const confirm = await readLine('続行しますか？ (y/N): ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('キャンセルしました。');
    return;
  }

  try {
    const result = await createOrUpdateUser(email, password);
    console.log('\n[OK] Firebase ユーザー ' + result.action + ': ' + result.email + ' (uid: ' + result.uid + ')');
  } catch (err) {
    console.error('\n[ERROR] ' + err.message);
  }
}

async function runCloudRunSync(apps) {
  console.log('\n=== Cloud Run 環境変数同期 ===');
  const syncableApps = apps.filter((a) => a.cloudRunSyncEnabled);
  if (syncableApps.length === 0) {
    console.log('同期可能なアプリがありません (cloudRunSyncEnabled=false)。');
    console.log('Firebase Auth 移行後に config/auth/apps.json の cloudRunSyncEnabled を true に設定してください。');
    return;
  }

  console.log('同期対象アプリ:');
  syncableApps.forEach((a) => console.log('  - ' + a.name + ' (' + a.cloudRunService + ')'));

  console.log('\nFirebase 設定値を入力してください (すでに env で設定済みの場合はそのまま使用):');
  const firebaseVars = {};
  const varPrompts = [
    { key: 'NEXT_PUBLIC_FIREBASE_API_KEY', label: 'Firebase API Key' },
    { key: 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', label: 'Firebase Auth Domain (e.g. project.firebaseapp.com)' },
    { key: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', label: 'Firebase Project ID' },
    { key: 'NEXT_PUBLIC_FIREBASE_APP_ID', label: 'Firebase App ID' },
  ];

  for (const { key, label } of varPrompts) {
    const existing = process.env[key];
    if (existing) {
      console.log('  ' + key + ' = [環境変数から読み込み済み]');
      firebaseVars[key] = existing;
    } else {
      const val = await readLine('  ' + label + ' (' + key + '): ');
      if (!val) { console.log('キャンセルしました。'); return; }
      firebaseVars[key] = val;
    }
  }

  const allowedEmails = await readLine('ALLOWED_USER_EMAILS (カンマ区切り、例: a@b.com,c@d.com): ');
  if (!allowedEmails || allowedEmails.trim() === '') {
    console.log('[ERROR] ALLOWED_USER_EMAILS が空です。反映を中止します。');
    return;
  }

  console.log('\n以下を Cloud Run に反映します:');
  syncableApps.forEach((a) => {
    console.log('\n  アプリ: ' + a.name + ' (' + a.cloudRunService + ' / ' + a.region + ')');
    console.log('  更新する変数: ' + Object.keys(firebaseVars).concat(['ALLOWED_USER_EMAILS']).join(', '));
  });
  console.log('');
  const confirm = await readLine('続行しますか？ (y/N): ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('キャンセルしました。');
    return;
  }

  const envVars = Object.assign({}, firebaseVars, { ALLOWED_USER_EMAILS: allowedEmails });
  for (const app of syncableApps) {
    try {
      const result = await syncCloudRunEnvVars(app, envVars);
      if (result.skipped) {
        console.log('[SKIP] ' + app.name);
      } else {
        console.log('[OK] ' + app.name);
      }
    } catch (err) {
      console.error('[ERROR] ' + app.name + ': ' + err.message);
    }
  }
  console.log('\nCloud Run 同期完了。');
}

async function main() {
  const apps = loadApps();

  console.log('\n==============================');
  console.log('  共通 Firebase 認証セットアップ');
  console.log('==============================');
  console.log('\n[重要] パスワードは画面に表示されません。Linear・README・.env には書かないでください。\n');

  console.log('操作を選択してください:');
  console.log('  1. Firebase ユーザー作成/更新');
  console.log('  2. Cloud Run 認証環境変数同期');
  console.log('  3. 両方実行');
  console.log('  4. 設定状況確認');
  console.log('  0. 終了');

  const choice = await readLine('\n選択 (0-4): ');

  switch (choice) {
    case '1':
      await runFirebaseUserSetup();
      break;
    case '2':
      await runCloudRunSync(apps);
      break;
    case '3':
      await runFirebaseUserSetup();
      await runCloudRunSync(apps);
      break;
    case '4':
      showAppsStatus(apps);
      break;
    case '0':
    case '':
      console.log('終了します。');
      break;
    default:
      console.log('無効な選択です: ' + choice);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[FATAL] ' + err.message);
  process.exit(1);
});
