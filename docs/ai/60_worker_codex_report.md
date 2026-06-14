# Worker Report — SOT-547 Plan

## Summary

Investigated gcloud projects, Cloud Run services, per-repository `.env.example` files, deployment scripts, branch status, and auth implementation references for all 8 target apps.

Only `state-machine-simulator` was directly confirmed as an existing Cloud Run service in the active project `gen-lang-client-0243034020` / `asia-northeast1`. The other 7 Cloud Run service names and regions are inferred from local repository config and deployment scripts.

## Acceptance Criteria

- [x] 各アプリのCloud Run service nameが判明している
- [x] 各アプリのCloud Run regionが判明している
- [x] 各アプリの現在の認証方式が一覧化されている
- [x] booking-monitorのmainブランチ状況が確認されている
- [x] toddler-private-ragの認証実装が確認されている
- [x] docs/ai/20_design.md に調査結果が記録されている

## Risks

- Cloud Runで直接確認できたのは `state-machine-simulator` のみ。他7件は repo 設定からの推定。
- Secret Manager API が active project で無効またはアクセス不可のため、GCP上の既存 secret 実体は確認できていない。
- `booking-monitor` の GitHub default branch は `feat/SOT-274-booking-monitor` で、`main` 前提の自動化は危険。
- `shrine-stair-trainer` は `VITE_AUTH_PASSWORD` を build-time に静的 bundle へ埋め込むため、Firebase移行時の扱いが他アプリと異なる。

## Next Action
READY_FOR_REVIEW
