'use strict';

const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length > 0) return;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      'FIREBASE_PROJECT_ID env var is required. Set it to your Firebase project ID.\n' +
      'Example: export FIREBASE_PROJECT_ID=your-project-id'
    );
  }
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  });
}

async function createOrUpdateUser(email, password) {
  initAdmin();
  const auth = admin.auth();
  let result;
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { password, emailVerified: true });
    result = { uid: existing.uid, email, action: 'updated' };
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      const user = await auth.createUser({ email, password, emailVerified: true });
      result = { uid: user.uid, email, action: 'created' };
    } else if (
      err.code === 'auth/configuration-not-found' ||
      (err.message && err.message.includes('CONFIGURATION_NOT_FOUND'))
    ) {
      throw new Error(
        'Firebase Email/Password プロバイダが無効です。\n' +
        'Firebase Console で有効化してください:\n' +
        'https://console.firebase.google.com/project/' + (process.env.FIREBASE_PROJECT_ID || '<project>') + '/authentication/providers\n' +
        '「メール/パスワード」プロバイダを有効化してから再実行してください。'
      );
    } else {
      const safeMsg = (err.message || '').replace(password || '', '[REDACTED]');
      throw new Error('Firebase user operation failed [' + (err.code || 'unknown') + ']: ' + safeMsg);
    }
  }
  return result;
}

module.exports = { createOrUpdateUser };
