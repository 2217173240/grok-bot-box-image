# grok-bot-box-image

Grok Bot 0.18 全本地重建（[grok-bot-0.18-reconstructed](https://github.com/2217173240/grok-bot-0.18-reconstructed)）
所需 base 镜像 `grok-box-base:arm64` 的源码与构建配方。

内容为 2026-08 对 Grok Bot 0.18 沙箱计算机的黑盒观察仿写（端口公式、桌面进程、
浏览器启动器的观察记录见主仓库 `docs/ARCHIVE-ASSETS.md` 的对齐表）：

- `box-image/Dockerfile` —— debian:trixie / arm64 全套桌面（Xvfb、xfwm4、x11vnc、noVNC、
  Chromium、CJK 字体）+ 开发试验场工具链（Go、Rust、Python、bun、uv、gh…），
  bun / uv 版本与 SHA-256 固定，Playwright 固定版本；约 31 个构建步骤。
- `box-image/bin/` —— 容器内治理脚本：`box-init`（入口）、`start-desktop.sh`（每屏进程监督表）、
  `start-window` / `stop-window`（副屏生命周期与 owner token）、`box-chrome`（浏览器启动器，
  CDP 9222+N）、`sand-window-router.mjs`（1339 显示路由）、`session-sync.mjs`（登录态同步守护）。
- `box-service/` —— 容器内窗口服务（base 镜像的 `box-init` 依赖它存在）。
- `.dockerignore` —— 构建上下文排除项（须位于上下文根）。

主仓库默认使用项目专用的 Colima `grokbot` profile；运行时可通过
`GROKBOT_COLIMA_PROFILE` 选择其他名称，显式设置 `DOCKER_HOST` 时以它为准。
基础镜像把主屏 Chromium profile 链接到 `/home/box/sand-data/chrome-profile`。
主仓库在父目录 `/home/box/sand-data` 挂载持久数据卷，登录状态随容器替换保留；启动入口在空卷上建立目录，
并清理前一次 Chromium 遗留的 Singleton 锁。副屏继续从主屏共享登录所需文件。

## 获取主仓库使用的固定构件

本仓库的 `artifacts/manifest.json` 统一登记基础镜像和原版 0.18.0 安装包的获取地址、大小与 SHA-256。
基础镜像的完整归档保存在 [GitHub Release](https://github.com/2217173240/grok-bot-box-image/releases/tag/base-d12224a-arm64)，无需从某台开发机器复制。
原版安装包使用清单中的官方地址下载，仍受原发布者条款约束。

获取脚本需要 Node.js 22 或更新版本和 curl；继续构建主仓库时使用其要求的 Node.js 26.5.0。
默认采用 Colima；使用其他 Docker 服务时显式配置 `DOCKER_HOST`。

```sh
git clone https://github.com/2217173240/grok-bot-box-image.git
cd grok-bot-box-image
colima start --profile grokbot --cpu 4 --memory 6 --disk 30 --arch aarch64
export DOCKER_HOST="unix://$HOME/.colima/grokbot/docker.sock"
node scripts/fetch-artifact.mjs base-arm64 --load
```

脚本先验证下载归档的大小与 SHA-256，随后导入 Docker，并核对 manifest digest、平台与源码 label。
归档只包含镜像层，不包含容器状态、数据卷、浏览器会话或宿主机凭据。
省略 `--load` 时只下载并校验；重复执行会校验并复用已有文件，损坏文件明确报错。
导入不会启动或替换正在运行的容器。
归档保留 OCI manifest，需要支持该格式并保留 RepoDigest 的 Docker 镜像存储；已在 Colima 的 Docker 29 containerd 镜像存储中从空镜像库验证。
如果导入后的 digest 无法解析，脚本会报错，不能用改写主仓库 pin 的方式跳过校验。

原版应用输入也可以通过同一入口取得：

```sh
node scripts/fetch-artifact.mjs upstream-macos-0.18.0
node scripts/fetch-artifact.mjs upstream-windows-0.18.0
```

文件保存在 `.cache/artifacts/`。主仓库 `npm run bootstrap` 本身支持从相同官方地址获取 macOS 构件；
已下载 DMG 可复制到主仓库 `.cache/downloads/Grok_Bot_0.18.0.dmg`，bootstrap 会再次校验。
Windows 安装包供研究保留，当前主仓库不生成 Windows 应用。

## 从源码构建新基础镜像

```sh
git clone https://github.com/2217173240/grok-bot-box-image.git
cd grok-bot-box-image
colima start --profile grokbot --cpu 4 --memory 6 --disk 30 --arch aarch64
export DOCKER_HOST="unix://$HOME/.colima/grokbot/docker.sock"
docker build --platform linux/arm64 --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -f box-image/Dockerfile -t grok-box-base:arm64 .
```

要求 arm64 主机（Apple Silicon 原生，无模拟）；构建从公网拉取 Debian 软件包、
GitHub release（bun/uv，SHA 校验）、npm registry（Playwright 指定版本，ws 使用 `8.x` 范围）。
Debian 基础镜像使用固定 digest；APT 软件包来源会更新，同一份源码重新构建可能生成不同的镜像身份。
约 20-40 分钟。已有 `grokbot` profile 时直接使用它；构建不会自动修改主仓库固定的
基础镜像身份。更新主仓库的 `docker/base-image.json` 前，需核对新镜像内容与平台，
重新构建执行镜像，并完成主仓库的容器门禁和桌面验收。

## 与主仓库的衔接

base 镜像就位后，到主仓库执行 `docker/build-arm64-box.sh` 构建薄层
`grok-bot-exec-box:arm64`（Node 22 固定版本 + 仓库依赖），随后按主仓库
`docs/DEPLOY-HANDBOOK.md` §3/§4/§6 完成部署。完整部署手册见主仓库。
主屏 profile 链接由基础镜像维护。主仓库以 `box-init-exec` 启动本地模式，基础镜像的
`box-init` 与 `box-service` 仍服务于独立运行基础镜像的路径。

本地模式通过 `SAND_SESSION_SYNC_STATE_FILE` 读取 host 发布的忙态。状态超过十五秒、格式损坏、文件缺失或存在人工接管文件时暂停同步写入；全部 agent 空闲后再补齐数据。独立基础镜像继续从 `box-service` 查询状态。同步轮次串行执行，页内写入复查 origin，空页初始化每个浏览器实例与 origin 最多触发两次刷新。

镜像 label 记录源仓库及 `SOURCE_REVISION`。用于主仓库的正式构建需要干净的 Git 工作区，主仓库的基础镜像清单同时记录镜像 digest 与源码提交。真实双屏同步验收使用 `box-image/bin/sync-probe.mjs`，必须在没有生产数据、没有其他同步守护的隔离容器运行。

## 发布更新

基础镜像通过真实容器验收后，设置 `SOURCE_REVISION` 为已审查的 40 位源码提交、
`IMAGE_MANIFEST_DIGEST` 为已审查的 `sha256:…` manifest digest，使用 `bash scripts/export-base.sh IMAGE OUTPUT.tar.gz` 导出。
脚本在导出前核对 digest、平台与来源 label；
核对归档中的 OCI manifest、平台、源码 label 和文件 SHA-256，再建立对应源码提交的 Release。
每个版本使用独立 tag 和文件名，发布后保留原资产。更新 `artifacts/manifest.json` 和 `artifacts/SHA256SUMS`，
并同步主仓库的基础镜像身份及验收结果。源码重新构建的镜像必须作为新身份评审，不能覆盖已发布版本。
