FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# ---------------------------------------------------------------------------
# Version pins — bump these in one place
# ---------------------------------------------------------------------------
ARG NODE_MAJOR=20
ARG FLUTTER_VERSION=3.44.4

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
# ---------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux ruby \
    && rm -rf /var/lib/apt/lists/* \
    && gem install --no-document tmuxinator \
    && su vscode -c "mkdir -p ~/.config/tmuxinator \
        && ln -sf /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-auth.yml ~/.config/tmuxinator/ai-auth.yml \
        && ln -sf /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-dev.yml  ~/.config/tmuxinator/ai-dev.yml" \
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
