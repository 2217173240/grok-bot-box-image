#!/bin/bash
# 共享常量与工具。端口公式来自 docs/grok_bot/确定-计算环境-契约.md §2，不要改。

CDP_BASE=9222              # 调试口 = 9222+N，只听 127.0.0.1
VNC_PRIMARY=5900           # 主屏画面固定 5900（不是 5901）
EXEC_FORK_BASE=14000       # 副屏执行 = 14000+N
ROUTER_PORT=1339
NOVNC_PRIMARY=6080
NOVNC_FORKS=6081
PRIMARY_DISPLAY=1
SCREEN_GEOM=1280x800x24

TOKEN_DIR=/tmp/sand-window-tokens.d
NOVNC_TOKEN_DIR=/tmp/sand-novnc-tokens.d
SUPERVISE_DIR=/tmp/sand-desktop
PRIMARY_PROFILE=/home/box/chrome-profile
SESSION_STORE="$PRIMARY_PROFILE/Default"

# 壁纸。镜像构建时生成的纯色 PNG（见 Dockerfile）。
# 必须是文件而不是 xsetroot -solid 的颜色：合成器画根窗口时只认 _XROOTPMAP_ID，
# 而 xsetroot 只改根窗口背景像素、不建根 pixmap。详见 start-desktop.sh 里那一步。
WALLPAPER=/usr/local/share/box-wallpaper.png

# 每屏的运行时目录：会话总线、坞的每屏状态都放这儿，随屏生死。
run_dir()        { echo "/tmp/sand-run-$1"; }
plank_conf_dir() { echo "/tmp/plank-conf-$1"; }
plank_data_dir() { echo "/tmp/plank-data-$1"; }

# 主屏走 5900，副屏走 5900+N。机上没有 5901。
vnc_port() { [ "$1" -eq 1 ] && echo $VNC_PRIMARY || echo $((VNC_PRIMARY + $1)); }
cdp_port()  { echo $((CDP_BASE + $1)); }
exec_port() { echo $((EXEC_FORK_BASE + $1)); }
profile_dir() { [ "$1" -eq 1 ] && echo "$PRIMARY_PROFILE" || echo "$PRIMARY_PROFILE-$1"; }

log() { echo "[$(date +%H:%M:%S)] $*" >&2; }

# 按监听端口找 PID。关屏必须按端口精确杀，不能按进程名。
pid_on_port() {
  ss -tlnp 2>/dev/null | grep -oP "(?<=:)$1\s.*pid=\K[0-9]+" | head -1
}

wait_for() {  # wait_for <秒> <命令...>
  local n=$1; shift
  for _ in $(seq 1 "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
