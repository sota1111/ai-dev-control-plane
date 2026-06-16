# Linear Issue Template

## Title

```text
<機能>を追加する
```

Note: Generated child Issues DO NOT use process prefixes like `[IMPLEMENT]`.

## Description

```markdown
## 目的
<このIssueで達成する機能変更>

## 変更範囲
<対象ファイル / コンポーネント>

## 実装内容
<実装する内容>

## 検証内容
<このIssue内で行う検証。Debug / Test はここに含める（独立Issueにしない）>

## 想定commit
<このIssueが対応する意味あるcommit（1つ以上）>

## 受け入れ条件
- [ ] <このIssue単独で確認できる完了条件>

## 関連する親Issue
<親Issue ID と Title>
```

## Example

```markdown
## 目的
宅配ボックス一覧画面を作成する。

## 変更範囲
- `src/components/DeliveryBoxList.tsx`
- `src/api/deliveryBoxes.ts`

## 実装内容
- 宅配ボックス一覧を表示するコンポーネントの実装
- APIエンドポイントとの繋ぎ込み
- 空き / 使用中 / 異常 のステータス表示

## 検証内容
- npm run lint / typecheck
- npm test
- 手動での表示確認（空き/使用中/異常が正しく色分けされるか）

## 想定commit
- feat: 宅配ボックス一覧画面コンポーネントを追加
- feat: ボックス状態取得APIクライアントを実装

## 受け入れ条件
- [ ] 一覧画面が表示される
- [ ] 各ボックスの状態が正しく表示される
- [ ] 最終更新時刻が表示される

## 関連する親Issue
LC-100 宅配ボックス画面作成
```
