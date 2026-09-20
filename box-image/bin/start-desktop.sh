#!/bin/bash
# 起一路桌面。顺序照《确定-计算环境-as-built》§3 与《规格-MVP-v1》§4.3：
#   0 虚拟显示 → 1 窗口管理器 → 2 合成器 → 3 画面服务 → 4 画面入口 → 5 坞
# 浏览器不在这个序列里，按需另起（门禁 G1 查的就是这件事）。
set -u
source /usr/local/bin/box-common.sh

N=${1:?用法: start-desktop.sh <显示号>}
GROUP="d$N"
GDIR="$SUPERVISE_DIR/$GROUP"
RUNDIR=$(run_dir "$N")
mkdir -p "$GDIR" "$RUNDIR"

# 监督登记。字段对齐观察值：name group order logFile pid
# 关屏时整组摘掉（rm -rf 该组目录），避免组件被拉起来。
register() {
  local name=$1 order=$2 pid=$3
  cat > "$GDIR/$name.json" <<EOF
{"name":"$name","group":"$GROUP","order":$order,"logFile":"/tmp/$name:$N.log","pid":$pid}
EOF
}

# 0 虚拟显示。先起再刷壁纸，避免 x11vnc 把第一帧黑屏缓存住。
Xvfb ":$N" -screen 0 "$SCREEN_GEOM" +extension GLX +extension RENDER -noreset \
  >"/tmp/xvfb:$N.log" 2>&1 &
register xvfb 0 $!
wait_for 15 env "DISPLAY=:$N" xdpyinfo || { log ":$N Xvfb 起不来"; exit 1; }

# 0.5 会话总线。每路一条，地址落在该路的运行时目录里
# （《确定-计算环境-as-built》§3「每路有自己的运行时目录和会话总线」）。
#
# 这不是装饰：xfwm4 要 Xfconf、plank 要 dconf，两者都只走 D-Bus。没有总线时
# xfwm4 直接以 "Xfconf could not be initialized" 退出，桌面就没有窗口管理器 ——
# 窗口没标题栏、拖不动、关不掉。镜像里也没有 dbus-launch 可供 GLib 自动兜底
# （dbus-x11 包没装，装了也不该装：那会给每个进程各起一条总线）。
#
# --fork 之后 $! 不是守护进程本身，必须用 --print-pid 拿真 pid，否则监督表登记的是
# 一个转瞬即逝的壳，stop-window 杀了个寂寞。
export DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNDIR/bus"
rm -f "$RUNDIR/bus"
DBUS_PID=$(dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" \
  --nopidfile --fork --print-pid 2>/dev/null)
[ -n "${DBUS_PID:-}" ] || { log ":$N 会话总线起不来"; exit 1; }
register dbus 0 "$DBUS_PID"

# 0.6 壁纸。必须赶在 x11vnc 之前（否则第一帧黑屏被缓存住），而且必须用能设
# _XROOTPMAP_ID 的工具。合成器画根窗口时只认这个属性：xsetroot -solid 只改根窗口
# 的背景像素、不建根 pixmap，于是 picom 一开整个桌面就是纯黑（实测；ImageMagick 的
# display -window root 同样不设这个属性，也不行）。
DISPLAY=":$N" xwallpaper --stretch "$WALLPAPER" >/dev/null 2>&1 \
  || log ":$N 壁纸没刷上（继续）"

# 1 窗口管理器：自带合成关掉，交给下一步。
# 就绪判据是 EWMH 的 _NET_SUPPORTING_WM_CHECK 真的出现，不是「进程还在」——
# xfwm4 挂掉的那次进程立刻就没了，但当时没人查，桌面裸奔了整个项目周期。
DISPLAY=":$N" xfwm4 --compositor=off >"/tmp/xfwm4:$N.log" 2>&1 &
register xfwm4 1 $!
wait_for 15 bash -c "DISPLAY=:$N xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'" \
  || { log ":$N 窗口管理器没接管，日志 /tmp/xfwm4:$N.log"; exit 1; }

# 2 合成器 —— **本项目故意不跑**（规格 §4.4）。序号留着空位，好和 as-built §3 对得上。
#
# as-built 要求这一步跑 picom，理由是「损伤在这套虚拟显示上会漏，表现为壁纸盖住页面」。
# 实测下来这是个二选一，不是可以两全的：
#
#   - plank 的坞是一扇 1280x140 的 **Depth 32 (ARGB) 窗口**。没有合成器时它走 shape 模式，
#     只有图标那一小块存在，壁纸从旁边透出来；一旦检测到合成器，它改用整条 RGBA 窗口，
#     把透明区交给合成器去混。
#   - 而这套无 GPU 的虚拟显示上，**没有一个合成器混得动它**：picom 的 xrender 和 glx
#     两个后端、以及 xfwm4 自带的合成器，三种都把那 140px 渲染成纯黑（逐一实测）。
#   - 代价是每张截图底部 140px 永久黑掉 = agent 视野的 17.5%。而 screenshot 正是
#     「给有视觉的 client 当眼睛」的那个工具，这不是难看，是眼睛瞎了一块。
#   - 换来的那个好处则从未兑现：整个项目周期都没有合成器，实测开真页面渲染正常，
#     as-built 警告的「壁纸盖住页面」一次都没出现过。
#
# 所以：**保坞，不要合成器**。xfwm4 的 --compositor=off 照旧（照 as-built），
# 只是不再把接力棒交给谁。G9 里有一条像素断言守着这件事：坞那条带必须是壁纸色。

# 3 画面服务：只听本机、无密码、可共享、不退出、关 XDamage 整帧轮询。
# -rfbportv6 必须显式给同一个口。实测：只给 -rfbport 时 x11vnc 仍会在 [::1]:5900
# 上开 IPv6 监听，正好撞主屏画面口。见《规格-MVP-v1-可行性实测》坑 1。
VP=$(vnc_port "$N")
x11vnc -display ":$N" -rfbport "$VP" -rfbportv6 "$VP" \
  -localhost -nopw -shared -forever -noxdamage \
  >"/tmp/x11vnc:$N.log" 2>&1 &
register x11vnc 3 $!
wait_for 15 bash -c "ss -tln | grep -q '127.0.0.1:$VP'" || { log ":$N x11vnc 起不来"; exit 1; }

# 4 画面入口。主屏 6080、副屏 6081 都走 TokenFile，凭证由窗口服务签发。
# 直连后端等于没鉴权：本机任何进程都能看屏。
mkdir -p "$NOVNC_TOKEN_DIR"
if [ "$N" -eq "$PRIMARY_DISPLAY" ]; then
  websockify --web=/usr/share/novnc/ \
    --token-plugin=TokenFile --token-source="$NOVNC_TOKEN_DIR" \
    "$NOVNC_PRIMARY" >"/tmp/novnc:$N.log" 2>&1 &
  register websockify 4 $!
  wait_for 15 bash -c "ss -tln | grep -q ':$NOVNC_PRIMARY'" \
    || { log ":$N 画面入口 $NOVNC_PRIMARY 起不来"; exit 1; }
fi

# 5 坞（规格 §4.3）。观察值用 plank，实例名 dock1，日志 /tmp/plank:N-dock1.log。
#
# 只起坞本身；文件管理器和终端是坞上的图标，点了才开 —— 这一点对门禁 G1 很要紧：
# 「冷启动时不应有 Chromium 进程」的语义是桌面栈不自动拉应用，坞跟着自动开的话
# 那条纪律就名存实亡了。坞是画面的一部分，不是应用。
#
# **plank 从 $XDG_CONFIG_HOME/plank/<实例名>/launchers 读 dockitem，不是 XDG_DATA_HOME。**
# 这里以前只设了 XDG_DATA_HOME，于是 seed-dock 铺的三个图标 plank 一眼都没看过：
# 它回落到 ~/.config/plank/dock1/，那目录是空的，plank 就自己生成一套默认项
# （实测长出来的是 Chromium + ImageMagick 的魔法师）。屏上只有两个图标，
# 而 G8 断言的又恰好是没人读的那三个文件 —— 门禁全绿、桌面却是错的。
# 两个变量都设成每屏独立：多屏共用会互相覆盖图标顺序。
export XDG_CONFIG_HOME=$(plank_conf_dir "$N")
export XDG_DATA_HOME=$(plank_data_dir "$N")
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
seed-dock "$N"
DISPLAY=":$N" plank -n dock1 >"/tmp/plank:$N-dock1.log" 2>&1 &
register plank 5 $!

log ":$N 桌面就绪（画面 $VP，坞 dock1）"
