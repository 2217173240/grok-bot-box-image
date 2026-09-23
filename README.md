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

## 构建方法

```sh
git clone https://github.com/2217173240/grok-bot-box-image.git
cd grok-bot-box-image
colima start --profile grokbot --cpu 4 --memory 6 --disk 30 --arch aarch64
export DOCKER_HOST="unix://$HOME/.colima/grokbot/docker.sock"
docker build --platform linux/arm64 -f box-image/Dockerfile -t grok-box-base:arm64 .
```

要求 arm64 主机（Apple Silicon 原生，无模拟）；构建从公网拉取 Debian 软件包、
GitHub release（bun/uv，SHA 校验）、npm registry（Playwright 指定版本，ws 使用 `8.x` 范围）。
Debian 基础标签与软件包来源会更新，同一份源码重新构建可能生成不同的镜像身份。
约 20-40 分钟。已有 `grokbot` profile 时直接使用它；构建不会自动修改主仓库固定的
基础镜像身份。更新主仓库的 `docker/base-image.json` 前，需核对新镜像内容与平台，
重新构建执行镜像，并完成主仓库的容器门禁和桌面验收。

## 与主仓库的衔接

base 镜像就位后，到主仓库执行 `docker/build-arm64-box.sh` 构建薄层
`grok-bot-exec-box:arm64`（Node 22 固定版本 + 仓库依赖），随后按主仓库
`docs/DEPLOY-HANDBOOK.md` §3/§4/§6 完成部署。完整部署手册见主仓库。
当前主仓库的薄层也会建立相同的主屏 profile 链接；新基础镜像进入主仓库固定镜像清单前，
正在使用的执行镜像保持原状。主仓库以 `box-init-exec` 启动本地模式，基础镜像的
`box-init` 与 `box-service` 仍服务于独立运行基础镜像的路径。
