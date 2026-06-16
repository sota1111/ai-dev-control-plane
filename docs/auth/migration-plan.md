# 共通Firebase認証移行計画

## 概要

ai-dev-control-plane を共通認証の操作盤とし、全個人用アプリを Firebase Authentication へ統一する。
管理スクリプト: `scripts/auth/auth-setup.js` (`npm run auth:setup`)

共通認証パターンのリファレンス実装は [`docs/auth/firebase-auth-pattern.md`](firebase-auth-pattern.md) を参照。

## 移行状況一覧

| アプリ | リポジトリ | Cloud Run サービス | 現在の認証方式 | 移行状況 | sync有効 |
|--------|-----------|-------------------|---------------|---------|---------|
| english-phrase-trainer | sota1111/english-phrase-trainer | english-phrase-trainer | Firebase Auth + Cookie | ✅ 移行済み | ✅ |
| stock-signal-research | sota1111/stock-signal-research | stock-signal-service | Firebase Auth + Cookie | ✅ 移行済み | ❌ |
| state-machine-simulator | sota1111/state-machine-simulator | state-machine-simulator | Firebase Auth + Cookie | ✅ 移行済み | ❌ |
| shrine-stair-trainer | sota1111/shrine-stair-trainer | shrine-stair-trainer | Firebase Auth (フロントのみ) | ✅ 移行済み（フロントのみ） | ❌ |
| kindle-sale-monitor | sota1111/kindle-sale-monitor | kindle-sale-monitor | Firebase Auth + Cookie | ✅ 移行済み | ❌ |
| booking-monitor | sota1111/booking-monitor | booking-monitor | Flask session + パスワード | ⬜ 未移行 | ❌ |
| toddler-nas-photo-indexer | sota1111/toddler-nas-photo-indexer | toddler-nas-photo-indexer-backend | Firebase Auth + Cookie | ✅ 移行済み | ❌ |
| toddler-private-rag | sota1111/toddler-private-rag | toddler-private-rag-backend | Firebase Auth (部分実装) | 🔶 部分移行 | ❌ |

## アプリ別詳細

### english-phrase-trainer ✅ 移行済み（基準実装）

- **フレームワーク**: Next.js
- **現在の認証**: Firebase Authentication (Email/Password) + Firebase Admin SDK + HTTP-only Cookie セッション
- **環境変数**: `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `ALLOWED_USER_EMAILS`, `AUTH_SECRET`
- **Cloud Run sync**: 有効（`cloudRunSyncEnabled: true`）
- **注意**: 他アプリの移行基準実装として参照すること。詳細は [`docs/auth/firebase-auth-pattern.md`](firebase-auth-pattern.md) を参照

### stock-signal-research ✅ 移行済み

- **フレームワーク**: React/Vite + FastAPI
- **現在の認証**: Firebase Authentication (Email/Password) + Firebase Admin SDK + HTTP-only Cookie セッション
- **環境変数**: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `ALLOWED_USER_EMAILS`, `AUTH_SECRET`, `GOOGLE_CLOUD_PROJECT`
- **旧変数**: `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY` は削除済み

### state-machine-simulator ✅ 移行済み

- **フレームワーク**: React + FastAPI
- **現在の認証**: Firebase Authentication (Email/Password) + Firebase Admin SDK + HTTP-only Cookie セッション
- **環境変数**: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `ALLOWED_USER_EMAILS`, `AUTH_SECRET`, `GOOGLE_CLOUD_PROJECT`
- **残課題**: READMEに旧認証変数 (`AUTH_PASSWORD`, `JWT_SECRET`) の記述が残存（SOT-581で修正予定）

### shrine-stair-trainer ✅ 移行済み（静的フロントのみ）

- **フレームワーク**: React/Vite 静的フロント
- **現在の認証**: Firebase Authentication (Email/Password) — フロントエンドのみ
- **環境変数**: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`
- **AUTH_SECRET**: 不要（サーバーなし）
- **ALLOWED_USER_EMAILS**: Firebase Console の手動ユーザー作成で制限
- **例外事項**: 静的フロントのためサーバー側 Firebase ID token 検証は対象外. Cloud Run --allow-unauthenticated でデプロイし、アプリ内 Firebase Auth で画面保護する
- **旧変数**: `VITE_AUTH_PASSWORD` は削除済み（ただしREADMEに記述残存。SOT-581で修正予定）

### kindle-sale-monitor ✅ 移行済み

- **フレームワーク**: Python/Starlette（サーバーサイドレンダリング）
- **現在の認証**: Firebase Authentication (Email/Password) + Firebase Admin SDK + HTTP-only Cookie セッション（管理画面）
- **環境変数**: `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `ALLOWED_USER_EMAILS`, `AUTH_SECRET`, `GOOGLE_CLOUD_PROJECT`
- **Cloud Scheduler /run エンドポイント**: OIDC（roles/run.invoker）で保護。管理画面認証とは別系統
- **残課題**: テストファイル (`tests/test_api_books.py`) に旧認証変数 (`AUTH_USERNAME`, `AUTH_PASSWORD`) の参照が残存（SOT-581で修正予定）

### booking-monitor ✅ 移行済み

- **フレームワーク**: Flask
- **現在の認証**: Flask session + `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY`
- **移行方針**: Flask に Firebase Admin SDK を追加し、Firebase ID Token 検証 → HTTP-only Cookie セッション
- **環境変数**: `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `ALLOWED_USER_EMAILS`, `AUTH_SECRET`
- **/run エンドポイント**: Cloud Scheduler 専用（OIDC + roles/run.invoker）で保護
- **完了**: SOT-582 で実装済み

### toddler-nas-photo-indexer ✅ 移行済み

- **フレームワーク**: React + FastAPI
- **現在の認証**: Firebase Authentication (Email/Password) + Firebase Admin SDK + HTTP-only Cookie セッション
- **環境変数**: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `ALLOWED_USER_EMAILS`, `AUTH_SECRET`, `GOOGLE_CLOUD_PROJECT`
- **注意**: NASパスや接続情報がログに出ないよう秘匿情報扱いを維持すること

### toddler-private-rag 🔶 部分移行

- **フレームワーク**: React + FastAPI
- **現在の認証**: Firebase Auth コード/環境変数あり（部分実装）
- **環境変数**: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `ALLOWED_USER_EMAILS`, `AUTH_SECRET`, `GOOGLE_CLOUD_PROJECT`
- **残課題**: READMEに旧認証方式 (`AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET_KEY`) の記述が残存（SOT-581で修正予定）
- **重要**: 保育園情報を扱うため、未ログイン API アクセスを必ず拒否すること

## フレームワーク別移行パターン

詳細は [`docs/auth/firebase-auth-pattern.md`](firebase-auth-pattern.md) を参照。

### パターン1: Next.js（english-phrase-trainer が基準実装）

english-phrase-trainer の実装を参照すること:
- `src/lib/firebase-admin.ts` — Firebase Admin SDK 初期化
- `src/lib/firebase-client.ts` — Firebase Client SDK 初期化
- Cookie-based セッション管理

### パターン2: FastAPI + React/Vite

stock-signal-research, state-machine-simulator, toddler-nas-photo-indexer, toddler-private-rag が採用。

1. FastAPI に `firebase-admin` を追加（Python）
2. `/api/auth/session` エンドポイントを追加（Firebase ID Token 検証 → セッションCookie発行）
3. フロントに Firebase Client SDK を追加
4. ログイン画面を Firebase SDK に置き換え

### パターン3: Python サーバーサイドレンダリング（kindle-sale-monitor: Starlette, booking-monitor: Flask）

1. Firebase Admin SDK（Python）を追加
2. ログイン画面を Firebase JS SDK ベースに置き換え
3. セッション検証をFirebase Admin SDK に移行
4. Cloud Scheduler 用エンドポイントはユーザー認証とは別系統を維持

### パターン4: Vite 静的フロント（shrine-stair-trainer）

バックエンドなし。Firebase Client SDK のみ。
1. Firebase Client SDK でログイン画面を追加
2. ログイン状態による表示切り替えをフロントのみで実装
3. `VITE_AUTH_PASSWORD` は廃止

## 非対応理由・ブロッカー一覧

| アプリ | ブロッカー | 必要な人間対応 |
|--------|-----------|--------------|
（すべて対応済み）
