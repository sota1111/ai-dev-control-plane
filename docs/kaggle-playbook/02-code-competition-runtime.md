# 2. Code コンペのランタイム

Code コンペ（提出＝ノートブック/カーネルが**隠しテストで再実行**される形式）特有の落とし穴。
ROGII・ARC・PTCG・rogii 等はこの形式。

## C1. 提出は「隠しテストでの再実行」で採点される
- 提出した submission.csv の**値**ではなく、**カーネルを hidden test 上で再実行した結果**が採点される。
- ローカル/可視で作った submission.csv をそのまま出しても、**汎化する層しかスコアに効かない**。
- ROGII の症状: submission を変えても public が同じ 44.456 → 「可視だけに効く層(contact-override)」が
  hidden 再実行では発火せず、汎化層(PF)だけが効いていた。**可視の値を見て判断してはいけない。**

## C2. 可視テスト vs 隠しテスト
- 可視テストのエンティティは**プレースホルダ**で、しばしば**同一IDの train コピー**を持つ
  （ROGII: 3坑井 000d7d20/00bbac68/00e12e8b）。hidden にはコピーが無い。
- 「同一IDコピーで可視を完璧に合わせる」較正は **hidden で無力 or 有害**。可視 RMSE 0.008ft でも
  hidden では効かない。→ [検証は可視でなくエンティティ単位 CV で](01-validation-and-selection.md)。

## C3. 可視 submission.csv の byte 比較は無情報になりうる
- 可視エンティティを全上書きする層（contact-override 等）があると、**内部パラメータを変えても
  可視 submission.csv は byte 同一**になる。ROGII cycle11 はこれで「blend lever は効かない」と
  2度誤結論した（実際は hidden で w0.50→6.403 / w0.55→6.497 と効いていた）。
- **レバーの生死は hidden LB スコア差でのみ判定する。** 可視 fingerprint/byte 比較を根拠にレバーを
  CLOSE しない。

## C4. データのマウントパスは複数ありうる
- Kaggle カーネルセッションによってコンペデータのマウント先が違う:
  - `/kaggle/input/competitions/<comp>/`
  - `/kaggle/input/<comp>/`（`competitions/` プレフィックス無し）
- **ハードコードすると片方の個体で train glob が空 → 空DataFrame → `KeyError`** で死ぬ
  （ROGII final50 が v1-v3 で3連続 ERROR）。
- 対策: 候補パスを `(p / 'train').exists()` で **probe して動的解決**する。
```python
import pathlib as _p
DATA_ROOT = next((c for c in (
    '/kaggle/input/competitions/<comp>',
    '/kaggle/input/<comp>',
) if (_p.Path(c) / 'train').exists()), '/kaggle/input/competitions/<comp>')
```

## C5. exec 互換ゲート（提出前必須）
memory `kaggle-exec-runtime-gate` の恒久ルール。カーネルは Kaggle 上で:
- `__file__` が**無い**（`exec()` 実行）
- **cwd が不定**（絶対パス前提にしない）
- ネット遮断（offline データセットに wheel/モデルを同梱）
- GPU/CPU/RAM 制限、実行時間上限あり

提出前に**ローカルで exec 互換シミュ**（`exec(source, {})`、`__file__` 無し、cwd 変更）を走らせ、
`importlib` で動的 import する場合は `sys.modules[spec.name]=module` を exec_module 前に登録する。

## C6. GPU セッション枠
- `kaggle kernels push` の同時 GPU セッションは **2枠**まで（`Maximum batch GPU session count of 2 reached`）。
  複数バリアントを回すときは 2 本ずつ、完了を待って次を push する。
- 実行完了(`COMPLETE`)はスコア付き提出とは別。提出枠（日次上限、ROGII は5/日）を別途消費する。

## チェックリスト
- [ ] エンティティ単位 CV で判断（可視 submission の値を信じない）
- [ ] マウントパスは動的 probe
- [ ] exec 互換シミュを通した（`__file__` 無し / cwd 不定 / offline）
- [ ] レバーの生死は hidden LB スコア差で確認（可視 byte 比較禁止）
- [ ] GPU 2枠制約と日次提出上限を考慮したスケジュール
