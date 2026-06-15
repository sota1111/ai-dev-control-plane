# 共通Firebase認証移行計画

## 概要

ai-dev-control-plane を共通認証の操作盤とし、全個人用アプリを Firebase Authentication へ統一する。
管理スクリプト: `scripts/auth/auth-setup.js` (`npm run auth:setup`)

## 移行状況一覧

| アプリ | リポジトリ | Cloud Run サービス | 現在の認証方式 | 移行状況 | sync有効 |
|--------|-----------|-------------------|---------------|---------|---------|
| english-phrase-trainer | sota1111/english-phrase-trainer | english-phrase-trainer | Firebase Auth + Cookie | ✅ 移行済み | ✅ |
| stock-signal-research | sota1111/stock-signal-research | stock-signal-service | FastAPI OAuth2 + AUTH_USERNAME/PASSWORD/AUTH_SECRET_KEY | ⬜ 未移行 | ❌ |
| state-machine-simulator | sota1111/state-machine-simulator | state-machine-simulator | FastAPI password + AUTH_PASSWORD/JWT_SECRET | ⬜ 未移行 | ❌ |
| shrine-stair-trainer | sota1111/shrine-stair-trainer | shrine-stair-trainer | Vite build-time VITE_AUTH_PASSWORD (client-side) | ⬜ 未移行 | ❌ |
| kindle-sale-monitor | sota1111/kindle-sale-monitor | kindle-sale-monitor | Starlette session + AUTH_USERNAME/PASSWORD/AUTH_SECRET_KEY | ⬜ 未移行 | ❌ |
| booking-monitor | sota1111/booking-monitor | booking-monitor | Flask session + AUTH_USERNAME/PASSWORD/AUTH_SECRET_KEY | ⬜ 未移行 | ❌ |
| toddler-nas-photo-indexer | sota1111/toddler-nas-photo-indexer | toddler-nas-photo-indexer-backend | FastAPI OAuth2 + AUTH_USERNAME/PASSWORD/AUTH_SECRET_KEY | ⬜ 未移行 | ❌ |
| toddler-private-rag | sota1111/toddler-private-rag | toddler-private-rag-backend | FastAPI OAuth2 + AUTH_USERNAME/PASSWORD/AUTH_SECRET_KEY | ⬜ 未移行 | ❌ |

## アプリ別詳細

### english-phrase-trainer ✅ 移行済み（基準実装）

- **フレームワーク**: Next.js
- **現在の認証**: Firebase Authentication (Email/Password) + Firebase Admin SDK + HTTP-only Cookie セッション
- **参照する環境変数**: `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `ALLOWED_USER_EMAILS`, `AUTH_SECRET`
- **Cloud Run sync**: 有効（`cloudRunSyncEnabled: true`）
- **移行差分**: なし（基準実装として整理済み）
- **注意**: 他アプリの移行基準実装として参照すること

### stock-signal-research ⬜ 未移行

- **フレームワーク**: React/Vite + FastAPI
- **現在の認証**: FastAPI OAuth2PasswordRequestForm + JWT（`AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY`）
- **移行方針**: FastAPI に Firebase Admin SDK を追加し、Firebase ID Token を検証するエンドポイントを追加。フロント側は Firebase Client SDK でログインしてIDトークンを取得。
- **既存環境変数の扱い**: `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY` は非推奨化（移行完了後に削除）
- **注意**: Cloud Run サービス名は `stock-signal-service`（.env.example および deploy スクリプトから確認）
- **未完了理由**: 未着手

### state-machine-simulator ⬜ 未移行

- **フレームワーク**: React + FastAPI
- **現在の認証**: FastAPI password auth + JWT（`AUTH_PASSWORD`, `JWT_SECRET`）
- **移行方針**: stock-signal-research と同様、FastAPI + Firebase Admin SDK パターン
- **既存環境変数の扱い**: `AUTH_PASSWORD`, `JWT_SECRET` は非推奨化
- **注意**: Cloud Run サービス名は `state-machine-simulator`（gcloud で直接確認済み）
- **未完了理由**: 未着手

### shrine-stair-trainer ⬜ 未移行（要設計）

- **フレームワーク**: React/Vite 静的フロント
- **現在の認証**: `VITE_AUTH_PASSWORD` をビルド時に bundle へ埋め込み（クライアントサイドのみ）
- **移行方針**: Firebase Client SDK を組み込み、Firebase Authentication のログイン画面を追加。ログイン後に保護コンテンツを表示するルーティングを実装。バックエンドがないため Firebase ID Token の検証はフロントのみ。
- **既存環境変数の扱い**: `VITE_AUTH_PASSWORD` は廃止（build-time 埋め込みはセキュリティリスク）
- **注意**: 静的ホスティング + Firebase Auth の構成のため、他アプリとは異なる移行パターンが必要
- **未完了理由**: 未着手。設計が他アプリと異なるため優先度低め

### kindle-sale-monitor ⬜ 未移行

- **フレームワーク**: Python/Starlette（サーバーサイドレンダリング）
- **現在の認証**: Starlette session + `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY`
- **移行方針**: Cloud Scheduler 用の `/run` エンドポイントはジョブ認証（別途）を維持。管理画面は Firebase Auth へ移行。
- **既存環境変数の扱い**: `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY` は非推奨化
- **注意**: ジョブ実行エンドポイント（Cloud Scheduler）の認証は Firebase Auth とは分離すること
- **未完了理由**: 未着手

### booking-monitor ⬜ 未移行

- **フレームワーク**: Flask
- **現在の認証**: Flask session + `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY`
- **移行方針**: Flask に Firebase Admin SDK を追加し、Firebase ID Token を検証するエンドポイントを追加。
- **既存環境変数の扱い**: `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY` は非推奨化
- **注意**: 定期監視エンドポイントの認証はユーザー認証と分離すること。
- **未完了理由**: 未着手

### toddler-nas-photo-indexer ⬜ 未移行

- **フレームワーク**: React + FastAPI
- **現在の認証**: FastAPI OAuth2 + JWT（`AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY`）
- **移行方針**: stock-signal-research と同様のパターン
- **既存環境変数の扱い**: `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY` は非推奨化
- **注意**: NAS ファイルアクセス範囲を誤って公開しないこと
- **未完了理由**: 未着手

### toddler-private-rag ⬜ 未移行

- **フレームワーク**: React + FastAPI
- **現在の認証**: FastAPI OAuth2PasswordBearer + JWT（`AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY`）
  - バックエンド: `backend/app/routers/auth.py`
  - フロントエンド: `frontend/src/contexts/AuthContext.tsx` が `/api/auth/login` を呼び出す
- **移行方針**: stock-signal-research と同様のパターン
- **既存環境変数の扱い**: `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY` は非推奨化
- **アクセス確認**: GitHub CLI (`gh repo view sota1111/toddler-private-rag`) でアクセス可能を確認済み
- **未完了理由**: 未着手（Firebase Auth 未実装）

## フレームワーク別移行パターン

### パターン1: Next.js（english-phrase-trainer が基準実装）

english-phrase-trainer の実装を参照すること:
- `src/lib/firebase-admin.ts` — Firebase Admin SDK 初期化
- `src/lib/firebase-client.ts` — Firebase Client SDK 初期化
- Cookie-based セッション管理

### パターン2: FastAPI + React/Vite（stock-signal-research, state-machine-simulator, toddler-nas-photo-indexer, toddler-private-rag）

1. FastAPI に `firebase-admin` を追加（Python）
2. `/api/auth/session` エンドポイントを追加（Firebase ID Token 検証 → セッションCookie発行）
3. フロントに Firebase Client SDK を追加
4. ログイン画面を Firebase SDK に置き換え
5. 既存の `/api/auth/login` は非推奨化

### パターン3: Python サーバーサイドレンダリング（kindle-sale-monitor: Starlette, booking-monitor: Flask）

1. Firebase Admin SDK（Python）を追加
2. ログイン画面を Firebase JS SDK ベースに置き換え
3. セッション検証をFirebase Admin SDK に移行
4. Cloud Scheduler 用エンドポイントはユーザー認証とは別系統を維持

### パターン4: Vite 静的フロント（shrine-stair-trainer）

1. Firebase Client SDK を組み込み
2. ログイン画面を追加（build-time パスワードを廃止）
3. ログイン状態による表示切り替えをフロントのみで実装
4. `VITE_AUTH_PASSWORD` を廃止

## 非対応理由・ブロッカー一覧

| アプリ | ブロッカー | 必要な人間対応 |
|--------|-----------|--------------|
| shrine-stair-trainer | 静的フロントのみのため、バックエンドなし。設計が異なる | Firebase Auth 移行設計の承認 |
| toddler-private-rag | Firebase Auth 未実装（確認済み）。アクセスは可能 | 移行タスクの優先度決定 |
