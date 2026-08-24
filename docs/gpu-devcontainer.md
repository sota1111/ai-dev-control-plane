# GPU / torch / numpy 対応 devcontainer (SOT-1865)

この devcontainer は `numpy` と CUDA 同梱の `torch` を同梱し、**GPU 学習可能**な状態で
ビルドされる。対象リポジトリのGPU対応テストや学習スクリプトなどの
学習をコンテナ内で完結できるようにするのが目的。

## 何が入っているか

- `numpy`（`ARG NUMPY_VERSION`、既定 `2.5.1`）
- `torch`（`ARG TORCH_VERSION`、既定 `2.13.0`）— `ARG TORCH_INDEX_URL` の既定
  `https://download.pytorch.org/whl/cu126` から **CUDA 12.6 ランタイム同梱の wheel** を導入。
  CUDA ライブラリは wheel に同梱されるため、ホストに CUDA Toolkit を別途入れる必要はなく、
  **NVIDIA ドライバ（GPU パススルー）だけ**あればよい。

いずれも `.devcontainer/Dockerfile` 末尾の `pip3 install --break-system-packages` ブロックで
system Python へ導入され、リポジトリの `python3` 直呼びスクリプトからそのまま `import` できる。

## GPU が有効になる条件

`torch.cuda.is_available()` が `True` になるのは、次を **すべて** 満たすホストで本コンテナを
起動したとき:

1. ホストに NVIDIA GPU がある（例: 人間の RTX 3080 Ti マシン）。
2. ホストに NVIDIA ドライバが入っている。
3. ホストに `nvidia-container-toolkit` が入っており、Docker に GPU を渡せる。

`.devcontainer/devcontainer.json` の `"hostRequirements": { "gpu": "optional" }` により、
上記が揃うホストでは自動的に `--gpus all` 相当が付与され、**揃わないホスト（GPU 無し）では
自動でスキップ**されてビルド/起動は壊れない。GPU 非搭載ホストでは同じ torch wheel が **CPU**
で動作する。

> 注意: この control-plane を現在動かしているホストには GPU が無いため、そのホスト上では
> `torch.cuda.is_available()` は `False`（CPU 動作）になる。GPU 計算を実際に使うには、
> GPU 搭載ホスト（RTX 3080 Ti マシン等）でこのコンテナを起動すること。

## GPU ホストでのビルドと検証

```bash
# 1. GPU ホスト（RTX 3080 Ti マシン）に nvidia-container-toolkit が入っていることを確認
nvidia-smi
docker info | grep -i runtimes   # nvidia が出ること

# 2. devcontainer をビルド/起動（VS Code Dev Containers か devcontainer CLI）
devcontainer up --workspace-folder .

# 3. コンテナ内で GPU を確認（postCreateCommand でも自動表示される）
python3 -c "import torch; print('cuda', torch.cuda.is_available(), '| device', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu')"
# 期待: cuda True | device NVIDIA GeForce RTX 3080 Ti
```

素の docker で確認する場合:

```bash
docker build -t ai-devcontainer .devcontainer
docker run --rm --gpus all ai-devcontainer \
  python3 -c "import torch; print(torch.cuda.is_available(), torch.version.cuda)"
```

## value net の GPU 学習（fable, SOT-1865 / SOT-1837）

GPU対応プロジェクトを本コンテナ内にcloneすれば、GPU処理を実行できる:

```bash
git clone https://github.com/example/gpu-project.git /workspaces/gpu-project
cd /workspaces/gpu-project

# on-policy（champion 自己対戦）データ生成 → torch で本格学習
python3 train/gen_selfplay.py --agent mcts --config '{...champion...}' --shards 8
python3 train/merge_selfplay.py
python3 train/train_value.py --backend torch --hidden 64 --epochs 300   # GPU があれば自動で使用

# 学習済みモデルは JSON へエクスポートされ、純 Python 推論（gap≤1e-9）で agent に統合
```

`SOT-1865` の完全再現ジョブ（コマンド・データ・期待成果物）は fable リポジトリの
`docs/value_net_v2_report.md` を参照。本コンテナが GPU-ready になったことで、その GPU ジョブを
人間マシン上の本コンテナ内でそのまま実行できる。

## バージョンの変更 / CPU 専用イメージ

- torch / numpy / CUDA 版を変えるには `.devcontainer/Dockerfile` の
  `ARG TORCH_VERSION` / `ARG NUMPY_VERSION` / `ARG TORCH_INDEX_URL` を編集する。
  例: CUDA 12.8 wheel なら `TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128`。
- **CPU 専用**の軽量イメージが欲しい場合は
  `TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu` にする（イメージが数 GB 小さくなる）。

## トレードオフ

CUDA 同梱 wheel は数 GB あり、イメージサイズとビルド時間が増える。GPU 学習を可能にするための
不可避なコスト。GPU を使わない用途しかないホストでは上記の CPU index に切り替えるとよい。
