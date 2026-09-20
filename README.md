# grok-bot-box-image

Grok Bot 0.18 全本地重建（[grok-bot-0.18-reconstructed](https://github.com/2217173240/grok-bot-0.18-reconstructed)）
所需 **base 镜像 `grok-box-base:arm64` 的全部构建输入**。

内容为 2026-08 对 Grok Bot 0.18 沙箱计算机的黑盒观察仿写（端口公式、桌面进程、
浏览器启动器的观察记录见主仓库 `docs/ARCHIVE-ASSETS.md` 的对齐表）：

- `box-image/Dockerfile` —— debian:trixie / arm64 全套桌面（Xvfb、xfwm4、x11vnc、noVNC、
  Chromium、CJK 字体）+ 开发试验场工具链（Go、Rust、Python、bun、uv、gh…），
  bun / uv / playwright 版本与 SHA-256 固定；约 31 个构建步骤。
- `box-image/bin/` —— 容器内治理脚本：`box-init`（入口）、`start-desktop.sh`（每屏进程监督表）、
  `start-window` / `stop-window`（副屏生命周期与 owner token）、`box-chrome`（浏览器启动器，
  CDP 9222+N）、`sand-window-router.mjs`（1339 显示路由）、`session-sync.mjs`（登录态同步守护）。
- `box-service/` —— 容器内窗口服务（base 镜像的 `box-init` 依赖它存在）。
- `.dockerignore` —— 构建上下文排除项（须位于上下文根）。

## 构建方法

```sh
git clone https://github.com/2217173240/grok-bot-box-image.git
cd grok-bot-box-image
docker build --platform linux/arm64 -f box-image/Dockerfile -t grok-box-base:arm64 .
```

要求 arm64 主机（Apple Silicon 原生，无模拟）；构建从公网拉取 debian apt、
github release（bun/uv，SHA 校验）、npm registry（playwright/ws，版本固定），
约 20-40 分钟。成功判据：31 步全部通过。

## 与主仓库的衔接

base 镜像就位后，到主仓库执行 `docker/build-arm64-box.sh` 构建薄层
`grok-bot-exec-box:arm64`（Node 22 固定版本 + 仓库依赖），随后按主仓库
`docs/DEPLOY-HANDBOOK.md` §3/§4/§6 完成部署。完整部署手册见主仓库。
