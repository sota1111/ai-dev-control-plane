# 共通Firebase認証管理

ai-dev-control-plane に共通認証スクリプトが含まれています。
Firebase Authentication ユーザー管理と、Cloud Run への認証環境変数同期を一元管理します。

## ⚠️ セキュリティポリシー

- **パスワードは Linear Issue、README、.env.example、ログ、Git 履歴に残さないこと**
- パスワードはターミナルでのみ対話入力し、入力時は非表示（マスク）になります
- Firebase ユーザー作成後、パスワードは保存されず Firebase Auth にのみ反映されます

## Firebase Console での初回作業（人間が1度だけ実施）

以下は自動化できないため、人間が Firebase Console で直接作業してください：

1. **Firebase プロジェクトを確認または作成**
   - https://console.firebase.google.com/
   - project name:sota-app-hub

2. **Email/Password プロバイダを有効化**
   - Firebase Console > Authentication > Sign-in method
   - 「メール/パスワード」を有効化

3. **Web アプリの設定値を取得**
   - Firebase Console > プロジェクトの設定 > マイアプリ
   - 以下の値を控える:
     - `NEXT_PUBLIC_FIREBASE_API_KEY`
     - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
     - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
     - `NEXT_PUBLIC_FIREBASE_APP_ID`

4. **Authentication ユーザーを作成**
   - Email/Password でログインするユーザーを作成する
   - **方法A（推奨）**: `npm run auth:setup` → メニュー `1` を選択してターミナルから作成
   - **方法B（手動）**: Firebase Console > Authentication > Users > ユーザーを追加
   - 作成したユーザーのメールアドレスを `ALLOWED_USER_EMAILS` に追加すること

## セットアップ手順

```bash
# 1. Firebase プロジェクト ID を設定
export FIREBASE_PROJECT_ID=your-firebase-project-id

# 2. gcloud 認証（Cloud Run 更新に必要）
gcloud auth application-default login --no-launch-browser

# 3. 対話型セットアップを起動
npm run auth:setup
```

セットアップメニュー:

- `1` — Firebase ユーザー作成/更新（ターミナルでパスワードを入力）
- `2` — Cloud Run 認証環境変数を同期（ALLOWED_USER_EMAILS + Firebase 設定）
- `3` — 両方実行
- `4` — 設定状況確認
- `0` — 終了

## アプリ設定ファイル

`config/auth/apps.json` に全アプリの Cloud Run サービス名・リージョン・認証設定が記載されています。

Firebase Auth 移行済みかつ Cloud Run sync 設定が完了したアプリのみ `"cloudRunSyncEnabled": true` になっています。
移行完了後に `cloudRunSyncEnabled` を `true` に変更し、`npm run auth:setup` を実行してください。

## 移行状況

各アプリの詳細な認証移行手順は [`auth/migration-plan.md`](auth/migration-plan.md) を参照してください。

| アプリ                    | 現在の認証方式                    | Firebase Auth 移行         | Cloud Run sync | 備考                                           |
| ------------------------- | --------------------------------- | :------------------------: | :------------: | ---------------------------------------------- |
| english-phrase-trainer    | Firebase Auth + Cookie            |       ✅ 移行済み          |       ✅       | 基準実装                                       |
| stock-signal-research     | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       | Cloud Run サービス名: `stock-signal-service`   |
| state-machine-simulator   | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       |                                                |
| shrine-stair-trainer      | Firebase Auth（フロントのみ）     | ✅ 移行済み（フロントのみ） |       ❌       | 静的フロント。サーバー側検証なし。AUTH_SECRET不要 |
| kindle-sale-monitor       | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       | /run は Cloud Scheduler 専用（OIDC）           |
| booking-monitor           | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       | /run は Cloud Scheduler 専用（OIDC）           |
| toddler-nas-photo-indexer | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       |                                                |
| toddler-private-rag       | Firebase Auth（部分実装）         |       ✅ 移行済み          |       ❌       |                                                |
