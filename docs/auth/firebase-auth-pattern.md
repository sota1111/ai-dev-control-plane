# Firebase Auth 共通認証パターン

## 概要

このドキュメントは、english-phrase-trainer を基準実装として、全アプリで採用する共通 Firebase 認証パターンを明文化したものです。

AI ワーカーが作業する際には、このドキュメントを参照し、古い認証方式に戻したり、リポジトリごとに別方式を増やしたりしないよう注意してください。

## 基準実装

**リポジトリ**: `sota1111/english-phrase-trainer`
**ローカルパス**: `/workspaces/english-phrase-trainer`

english-phrase-trainer の以下のファイルが共通認証の基準実装です:
- `src/lib/firebase-admin.ts` — Firebase Admin SDK 初期化
- `src/lib/firebase-client.ts` — Firebase Client SDK 初期化
- `src/app/api/auth/` — 認証 API ルート

## 共通認証ルール

### 1. 認証方式

- **Firebase Authentication** の Email/Password ログインを使用する
- Firebase Console でユーザーを手動作成する
- **アプリ内のユーザー新規登録機能は作らない**
- **複数ユーザー管理画面は作らない**

### 2. メールアドレス制限

- 環境変数 `ALLOWED_USER_EMAILS` でログイン許可メールアドレスを制限する
- カンマ区切りで複数アドレスを指定可能（例: `user1@example.com,user2@example.com`）
- サーバー側でトークン検証時に `ALLOWED_USER_EMAILS` と照合すること

### 3. セッション管理（サーバーがあるアプリ）

- Firebase ID token をサーバー側で検証する（Firebase Admin SDK）
- **HTTP-only Cookie** でセッションを管理する
- `AUTH_SECRET` でセッション署名する
- セッション Cookie は `secure: true`, `httpOnly: true`, `sameSite: strict` を設定する

### 4. 静的フロントエンドアプリの例外（shrine-stair-trainer）

- サーバーがない静的フロントエンドアプリはサーバー側 ID token 検証の対象外
- Firebase Client SDK のみでログイン状態を管理する
- `AUTH_SECRET` は不要
- Firebase Console の手動ユーザー作成でアクセス制限する
- Cloud Run を `--allow-unauthenticated` で公開する場合、アプリ内 Firebase Auth で画面保護する前提を README に明記する

### 5. 環境変数の命名規則

#### Next.js アプリ（english-phrase-trainer）
```
NEXT_PUBLIC_FIREBASE_API_KEY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
NEXT_PUBLIC_FIREBASE_PROJECT_ID
NEXT_PUBLIC_FIREBASE_APP_ID
ALLOWED_USER_EMAILS
AUTH_SECRET
```

#### Vite React アプリ（stock-signal-research, state-machine-simulator, toddler-nas-photo-indexer, toddler-private-rag, shrine-stair-trainer）
```
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_APP_ID
ALLOWED_USER_EMAILS  (サーバーがある場合)
AUTH_SECRET          (サーバーがある場合)
GOOGLE_CLOUD_PROJECT (サーバーがある場合)
```

#### Python サーバーサイドアプリ（kindle-sale-monitor, booking-monitor）
```
FIREBASE_API_KEY
FIREBASE_AUTH_DOMAIN
FIREBASE_PROJECT_ID
FIREBASE_APP_ID
ALLOWED_USER_EMAILS
AUTH_SECRET
GOOGLE_CLOUD_PROJECT
```

### 6. 廃止した旧認証変数（使用禁止）

以下の変数は旧認証方式のものです。新規実装では使用しないこと。

```
AUTH_USERNAME        # 廃止
AUTH_PASSWORD        # 廃止
AUTH_SECRET_KEY      # 廃止（AUTH_SECRET を使用すること）
JWT_SECRET           # 廃止（AUTH_SECRET を使用すること）
VITE_AUTH_PASSWORD   # 廃止（クライアントサイドパスワードは非推奨）
```

### 7. Cloud Run デプロイ手順への必須記載事項

各アプリの README の Cloud Run デプロイ手順には以下を明記すること:
- Cloud Run Service の公開範囲（`--allow-unauthenticated` か否か）
- 必要な環境変数の設定方法（Secret Manager または Cloud Run 環境変数）
- `AUTH_SECRET` の Secret Manager 登録方法
- `ALLOWED_USER_EMAILS` の設定方法

### 8. Cloud Scheduler 用エンドポイントの認証分離

`/run` や `/batch` のような定期実行エンドポイントは、人間のログイン認証とは別系統で保護すること:
- **Cloud Scheduler + OIDC**: サービスアカウントに `roles/run.invoker` を付与し、OIDC トークンで保護
- Cloud Scheduler の設定で `Authorization: Bearer <OIDC token>` を指定する
- README に以下を明記する:
  - Cloud Scheduler 用サービスアカウント名
  - `roles/run.invoker` の付与コマンド
  - OIDC audience（通常は Cloud Run サービスの URL）
  - Cloud Scheduler のジョブ設定例

## Secret Manager の推奨事項

本番環境では `AUTH_SECRET` を Secret Manager に登録することを推奨:

```bash
echo -n "your-secret-value" | gcloud secrets create <secret-name> --data-file=-
gcloud secrets add-iam-policy-binding <secret-name> \
  --member="serviceAccount:<sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

Cloud Run でのマウント方法:
```bash
gcloud run deploy <service> \
  --set-secrets=AUTH_SECRET=<secret-name>:latest
```

## ローカル開発

`.env.example` の変数名と README の説明を常に一致させること。
ローカル開発では `.env` ファイルに実際の値を設定する（`.gitignore` に追加済みであること）。

## 認証実装チェックリスト

新規リポジトリまたは認証移行時に以下を確認すること:

- [ ] Firebase Client SDK でログイン画面を実装している
- [ ] サーバー側で Firebase ID token を検証している（静的フロントを除く）
- [ ] ALLOWED_USER_EMAILS でメール制限している
- [ ] AUTH_SECRET でセッション署名している（静的フロントを除く）
- [ ] HTTP-only Cookie でセッションを管理している（静的フロントを除く）
- [ ] .env.example に必要な Firebase 変数が記載されている
- [ ] README に認証方式、環境変数、Cloud Run デプロイ手順が明記されている
- [ ] 旧認証変数 (AUTH_USERNAME/AUTH_PASSWORD/AUTH_SECRET_KEY/JWT_SECRET/VITE_AUTH_PASSWORD) が残っていない
- [ ] Cloud Scheduler 用エンドポイントがある場合、OIDC で保護されている
- [ ] 未ログイン状態で API に直接アクセスできない（healthcheck を除く）
