# PTCG Battle Viewer for iPhone

`ptcg-battle-log/v1` のJSONログをiPhone上で読み込み、初期盤面から最終イベントまで移動できる
SwiftUIアプリです。iOS 17以降に対応します。

## Simulator / 実機で起動

1. macOSで `PTCGBattleViewer.xcodeproj` をXcode 16以降で開きます。
2. Scheme `PTCGBattleViewer` とiPhone Simulator（または接続済みiPhone）を選択します。
3. 実機の場合は Target → Signing & Capabilities で自分のTeamと一意なBundle Identifierを設定します。
4. Run（⌘R）し、右上の「ログを開く」から `ptcg-battle-log/v1` JSONを選択します。
5. 先頭・前・次・末尾ボタンまたはスライダーで時点を移動します。

標準のiPhone 14縦向きでは、タイムライン、対戦相手、自分の盤面を縦スクロールせず一画面に
収めるコンパクト表示になります。時点移動ボタンはアイコン表示ですが、VoiceOverでは
「先頭」「前」「次」「末尾」と読み上げます。ベンチが多い場合のみ、各プレイヤーの
ベンチ欄を横へスクロールできます。

盤面は対戦相手を上、自分を下に固定して表示します。中央のバトル場とベンチではカード名、
技とその必要エネルギー、残りHP、ダメージ、付与エネルギーを確認でき、左右に山札・トラッシュ、各プレイヤー欄に
サイドと手札枚数を表示します。黄色の「行動中」が現在の手番です。ログにカード画像が
含まれない場合も、カード名と状態を読み取れるカード表示で盤面を確認できます。

動作確認用ログにはリポジトリの
`src/__tests__/fixtures/battle-log.valid.json` を利用できます。AirDrop、iCloud Drive、または
Filesアプリ経由でiPhoneへ渡してください。

レビュー用の具体的なカード名・技を含む表示例は
`src/__tests__/fixtures/battle-log.snapshot.json` と
`docs/screenshots/sot-1907-concrete-cards.png` で確認できます。

## テスト

Xcodeで Product → Test（⌘U）、またはmacOSのターミナルで次を実行します。

```bash
swift test --package-path ios/PTCGBattleViewer

xcodebuild test \
  -project ios/PTCGBattleViewer/PTCGBattleViewer.xcodeproj \
  -scheme PTCGBattleViewer \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
```

## TestFlight配信直前まで

1. Release設定のTeam、Bundle Identifier、Version、Buildを確認します。
2. Generic iOS Deviceを選び、Product → Archiveを実行します。
3. OrganizerのValidate Appが成功することを確認します。

依頼者が行う配信作業は、OrganizerのDistribute AppからApp Store Connectへアップロードし、
App Store ConnectでTestFlightビルドを選んでテスターへ公開する工程です。証明書、Provisioning
Profile、App Store Connect上のアプリ登録や法務情報はApple Developerアカウントに紐づくため、
リポジトリには保存しません。
