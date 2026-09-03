FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# ---------------------------------------------------------------------------
# Version pins — bump these in one place
# ---------------------------------------------------------------------------
ARG NODE_MAJOR=20
ARG FLUTTER_VERSION=3.44.4
# GPU/ML スタック（value net 学習など）。TORCH_INDEX_URL を PyPI の CUDA 同梱 wheel
# 配信元に向けることで、NVIDIA GPU 搭載ホストで起動すると torch.cuda.is_available()
# が True になる。GPU 非搭載ホストでは同じ wheel が CPU で動作する（ビルドは壊れない）。
# CPU 専用イメージにしたい場合は TORCH_INDEX_URL を https://download.pytorch.org/whl/cpu に。
ARG NUMPY_VERSION=2.5.1
ARG TORCH_VERSION=2.13.0
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu126

# ---------------------------------------------------------------------------
# Base build / runtime dependencies
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    pipx \
    ripgrep \
    jq \
    gpg \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Node.js (NodeSource)
# AI worker CLI（Codex CLI など）は Node.js 20 以上を要求するため、Ubuntu apt の
# nodejs だけに頼らず NodeSource を使う。
# ---------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# AI worker CLIs
#   - Codex CLI            : OpenAI、npm で配布。
#   - Antigravity CLI (agy): Google、公式インストーラで配布（npm パッケージではない）。
#     SOT-1334 で Gemini CLI → Antigravity CLI へ移行済みのため、廃止された
#     @google/gemini-cli ではなく agy を導入する。--dir /usr/local/bin で全ユーザー
#     （vscode 含む）の PATH 上に配置し、alias / PATH 編集を不要にする。
# ---------------------------------------------------------------------------
RUN npm install -g @openai/codex
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin

# ---------------------------------------------------------------------------
# uv / uvx (Astral)
#   MCP サーバ arxiv-mcp-server（.mcp.json、`uvx arxiv-mcp-server`）を起動できる
#   ようにする。uvx は uv に同梱されるため uv を導入すれば足りる。稼働コンテナを
#   再ビルドしても残るよう恒久化する。UV_INSTALL_DIR=/usr/local/bin で全ユーザー
#   （vscode 含む）の PATH 上に配置し、PATH 編集を不要にする。
# ---------------------------------------------------------------------------
RUN curl -LsSf https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uv --version && uvx --version

# ---------------------------------------------------------------------------
# uv managed CPython 3.11
#   epistemic-research-loop は mypy の python_version = "3.11"（pyproject.toml）と
#   CI の pin に合わせて venv を 3.11 で作る必要がある（3.12 で解決される numpy の
#   型スタブが 3.12 専用の `type` 文を使うため、typecheck が開始前に失敗する）。
#   本イメージの system Python は 3.12 なので、uv 管理の 3.11 をあらかじめ入れて
#   おき、コンテナ再ビルドのたびにインタプリタを再ダウンロードしなくて済むようにする。
#   UV_PYTHON_INSTALL_DIR を /opt/uv-python に固定し、remoteUser=vscode(uid 1000) が
#   後から別バージョンを追加導入できるよう所有権を付与する（/opt/flutter と同じ方式）。
#   UV_LINK_MODE=copy は、venv がバインドマウント越しに別ファイルシステムへ載って
#   hardlink できないときの警告を抑えるため。
# ---------------------------------------------------------------------------
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
ENV UV_LINK_MODE=copy
RUN uv python install 3.11 \
    && chown -R 1000:1000 /opt/uv-python \
    && uv python list --only-installed

# ---------------------------------------------------------------------------
# Kaggle CLI
#   epistemic-research-loop のコンペデータ取得（kaggle competitions download）と
#   late submission（scripts/submit_kaggle.py が `kaggle competitions submit` を
#   subprocess 起動する）に必要。CLI 2.x はアカウント設定で発行するアクセストークン
#   （KGAT... 形式）で認証し、旧来の KAGGLE_KEY / kaggle.json は受け付けない。
#   トークンは実行時に KAGGLE_API_TOKEN で与えるため、イメージには含めない。
#   Ubuntu 24.04 の system Python は externally-managed のため --break-system-packages
#   を付けてシステム全体に入れ、`kaggle` を全ユーザーの PATH 上に置く。
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# openssh-client
#   採点を Tailscale 越しの別マシンへ逃がすために ssh/scp を使う。ベースイメージに
#   入ってはいるが、依存として明示しておく(エージェントを 8 体並走させると 24 コアに
#   114 プロセスが乗り physics が CPU 2149% を占めるため、採点の外出しは前提の運用)。
# ---------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

ARG KAGGLE_CLI_VERSION=2.2.4
RUN pip3 install --no-cache-dir --break-system-packages "kaggle==${KAGGLE_CLI_VERSION}" \
    && kaggle --version

# ---------------------------------------------------------------------------
# tmux + tmuxinator
#   認証・常駐起動用の tmux セッション構成（.config/tmuxinator/ai-auth.yml /
#   ai-dev.yml）を一括起動するために使う。稼働コンテナを再ビルドしても残るよう
#   恒久化する。tmuxinator は Ruby gem（thor / erubi の純 Ruby 依存のみ、ネイティブ
#   拡張なし）なので ruby だけで足りる。
#   設定ファイルはリポジトリ（/workspaces/ai-dev-control-plane/.config/tmuxinator/）
#   に置かれ、実行時に bind-mount される。tmuxinator はデフォルトで
#   ~/.config/tmuxinator/ を読むため、ここへシンボリックリンクを張る。~/.config/
#   tmuxinator はボリュームマウント対象外なのでイメージに残り、リンク先はビルド時
#   点では dangling だが、起動時の bind-mount で解決される。remoteUser=vscode(uid
#   1000) の HOME に作成する。
#   併せて tmux 本体の設定（.config/tmux/tmux.conf、マウス操作有効化）を ~/.tmux.conf
#   へシンボリックリンクし、マウスクリックでの window / pane 選択を有効にする。
# ---------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux ruby \
    && rm -rf /var/lib/apt/lists/* \
    && gem install --no-document tmuxinator \
    && su vscode -c "mkdir -p ~/.config/tmuxinator \
        && ln -sf /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-auth.yml ~/.config/tmuxinator/ai-auth.yml \
        && ln -sf /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-dev.yml  ~/.config/tmuxinator/ai-dev.yml \
        && ln -sf /workspaces/ai-dev-control-plane/.config/tmux/tmux.conf ~/.tmux.conf" \
    && printf '%s\n' 'export EDITOR=vi' > /etc/profile.d/editor.sh \
    && chmod +x /etc/profile.d/editor.sh

# ---------------------------------------------------------------------------
# GitHub CLI
# ---------------------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Google Cloud CLI (gcloud)
#   ai-auth tmuxinator セッション（.config/tmuxinator/ai-auth.yml）の
#   `gcloud auth login` / `gcloud auth application-default login` を実行できる
#   ようにする。稼働コンテナを再ビルドしても残るよう恒久化する。公式 apt リポジトリ
#   から google-cloud-cli を導入する（gh / Azure CLI と同じ keyring 方式）。
# ---------------------------------------------------------------------------
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && chmod go+r /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# ngrok
#   ai-dev tmuxinator セッション（.config/tmuxinator/ai-dev.yml）の webhook pane が
#   `ngrok http 3000`（`npm run start:ngrok` / `NGROK_COMMAND`）を実行して Linear /
#   Discord の Webhook をローカル公開できるようにする。稼働コンテナを再ビルドしても
#   残るよう恒久化する。公式 apt リポジトリから ngrok を導入する（gh / gcloud と同じ
#   keyring 方式）。
# ---------------------------------------------------------------------------
RUN curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
      | gpg --dearmor -o /usr/share/keyrings/ngrok.gpg \
    && chmod go+r /usr/share/keyrings/ngrok.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/ngrok.gpg] https://ngrok-agent.s3.amazonaws.com buster main" \
      > /etc/apt/sources.list.d/ngrok.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends ngrok \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Azure CLI
# ---------------------------------------------------------------------------
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
      | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
    && chmod go+r /etc/apt/keyrings/microsoft.gpg \
    && . /etc/os-release \
    && printf "Types: deb\nURIs: https://packages.microsoft.com/repos/azure-cli/\nSuites: %s\nComponents: main\nArchitectures: %s\nSigned-by: /etc/apt/keyrings/microsoft.gpg\n" "$VERSION_CODENAME" "$(dpkg --print-architecture)" \
      > /etc/apt/sources.list.d/azure-cli.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends azure-cli \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Flutter SDK (SOT-1362)
#   稼働コンテナを再ビルドしても Flutter 環境が残るよう恒久化する。
#   用途は analyze / test / web のみ（このコンテナは headless のため、
#   Android SDK / Chrome / Linux desktop toolchain は意図的に導入しない）。
#   全ユーザーの PATH に通し、remoteUser=vscode(uid 1000) が SDK キャッシュ
#   （/opt/flutter/bin/cache）に書き込めるよう所有権を付与する。
#   PATH は profile.d（ログインシェル用）に加えて ENV でも設定し、CI やスクリプト
#   などの非対話シェルでも `flutter analyze` / `flutter test` を実行できるようにする
#   （Android SDK ブロックと同じ ENV 方式に揃える / SOT-1362）。
# ---------------------------------------------------------------------------
ENV PATH="/opt/flutter/bin:${PATH}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth 1 -b ${FLUTTER_VERSION} https://github.com/flutter/flutter.git /opt/flutter \
    && git config --system --add safe.directory /opt/flutter \
    && echo 'export PATH="/opt/flutter/bin:$PATH"' > /etc/profile.d/flutter.sh \
    && chmod +x /etc/profile.d/flutter.sh \
    && chown -R 1000:1000 /opt/flutter \
    && su vscode -c "/opt/flutter/bin/flutter --version && /opt/flutter/bin/flutter --disable-analytics"

# ---------------------------------------------------------------------------
# Android SDK + JDK (SOT-1362)
#   SOT-1360 の meal-planner Android ビルド検証時に稼働コンテナへ一時導入した
#   JDK / Android SDK を、再ビルド後も残るよう恒久化する。用途は Flutter の
#   Android ビルド（flutter build apk）。検証済みの稼働コンテナと同一バージョンを
#   pin する。SDK は /opt/android-sdk に置き、remoteUser=vscode(uid 1000) が
#   ライセンス更新やパッケージ追加を行えるよう所有権を付与する。
# ---------------------------------------------------------------------------
ARG ANDROID_CMDLINE_TOOLS=12266719
ARG ANDROID_PLATFORM_PRIMARY=36
ARG ANDROID_PLATFORM_SECONDARY=35
ARG ANDROID_BUILD_TOOLS_PRIMARY=36.0.0
ARG ANDROID_BUILD_TOOLS_SECONDARY=35.0.0
ARG ANDROID_NDK_VERSION=28.2.13676358
ARG ANDROID_CMAKE_VERSION=3.22.1

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/android-sdk/cmdline-tools \
    && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" -o /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools \
    && mv /tmp/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
    && rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools \
    && yes | /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
    && /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager \
        "platform-tools" \
        "platforms;android-${ANDROID_PLATFORM_PRIMARY}" \
        "platforms;android-${ANDROID_PLATFORM_SECONDARY}" \
        "build-tools;${ANDROID_BUILD_TOOLS_PRIMARY}" \
        "build-tools;${ANDROID_BUILD_TOOLS_SECONDARY}" \
        "ndk;${ANDROID_NDK_VERSION}" \
        "cmake;${ANDROID_CMAKE_VERSION}" > /dev/null \
    && printf '%s\n' \
        'export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64' \
        'export ANDROID_HOME=/opt/android-sdk' \
        'export ANDROID_SDK_ROOT=/opt/android-sdk' \
        'export PATH="/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:$PATH"' \
        > /etc/profile.d/android-sdk.sh \
    && chmod +x /etc/profile.d/android-sdk.sh \
    && chown -R 1000:1000 /opt/android-sdk \
    && su vscode -c "/opt/flutter/bin/flutter config --android-sdk /opt/android-sdk --jdk-dir /usr/lib/jvm/java-17-openjdk-amd64"

# ---------------------------------------------------------------------------
# GPU / ML スタック: numpy + torch (SOT-1865)
#   本コンテナで value net（fable train_value.py --backend torch）などの GPU 学習を
#   可能にする。torch は CUDA 同梱 wheel（TORCH_INDEX_URL=cu126）を導入するため、
#   NVIDIA GPU + nvidia-container-toolkit を持つホストで起動すると GPU を使い、
#   GPU 非搭載ホストでは同じ wheel が CPU で動作する（どちらでもビルドは成功する）。
#   Ubuntu 24.04 の system Python は externally-managed のため --break-system-packages
#   を付けてシステム全体に入れ、リポジトリの `python3` 直呼びスクリプトから import 可能に。
#   --no-cache-dir で pip キャッシュを残さずイメージ肥大を抑える。numpy は torch の
#   依存でもあるが、GPU index には無いため PyPI から別途 pin する。
#   GPU パススルーは .devcontainer/devcontainer.json の hostRequirements.gpu=optional で
#   有効化（GPU が無いホストでは自動でスキップされ起動は壊れない）。
# ---------------------------------------------------------------------------
RUN pip3 install --no-cache-dir --break-system-packages "numpy==${NUMPY_VERSION}" \
    && pip3 install --no-cache-dir --break-system-packages \
        --index-url "${TORCH_INDEX_URL}" \
        --extra-index-url https://pypi.org/simple \
        "torch==${TORCH_VERSION}" \
    && python3 -c "import numpy, torch; print('numpy', numpy.__version__, '| torch', torch.__version__, '| cuda-build', torch.version.cuda)"
