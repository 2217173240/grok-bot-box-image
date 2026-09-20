#!/bin/bash
# 计算环境门禁 G1-G7（来自「确定」）+ G8 坞 + G9 桌面栈 + G10 试验场
# + G11 open_url 目的地闸门（后四组是本项目自加）+ 安全 S1-S4。
# 照《确定-计算环境-测试门禁》。
#
# **跑法只有一种：`./tests/run-gates.sh`**，它会新建一只冷容器。
# 别对日常那只 `mac-bot` 直接 `docker exec … gates.sh` —— G9 的桌面像素断言要求
# 屏上除了壁纸和坞什么都没有，而日常容器里多半已经有一只开着页面的 Chromium 盖在采样点上，
# 于是门禁报一堆红，而东西是好的。**假红和假绿一样有害**：它教人忽略门禁。
#
# 这七条 + 四条过了，才有资格写 box-service 和 mcp-server。没过就不要往上做。
set -u
source /usr/local/bin/box-common.sh

PASS=0; FAIL=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

TOKA="tokA-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
TOKB="tokB-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"

echo "=== G1 冷启动：主屏活、画面可连、无浏览器 ==="
check ":1 的 xdpyinfo 通"        "DISPLAY=:1 xdpyinfo"
check "6080 在听"                 "ss -tln | grep -q ':6080'"
if pgrep -f "chromium.*--user-data-dir" >/dev/null 2>&1; then
  bad "此时不应有 Chromium 进程"
else
  ok "此时没有 Chromium 进程"
fi

echo "=== G9 桌面栈真的起来了（不只是登记了）==="
# 这一整节是补账。原来 G1 只查「X 通 + 画面口在听」，于是 xfwm4 和 picom
# 双双起不来、桌面裸奔了整个项目周期都没人发现：登记表里两个 json 好端端躺着，
# 进程早死了。断言一律打**效果**，不打「进程名在不在」——
# 这就是本项目「探活必须打端口，owner 文件靠不住」那条纪律搬到桌面栈上。
check ":1 会话总线可用" \
  "DBUS_SESSION_BUS_ADDRESS=unix:path=$(run_dir 1)/bus dbus-send --session \
   --dest=org.freedesktop.DBus --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames"
# WM：查 EWMH 根属性，不查进程。没有它窗口就没有标题栏、拖不动、关不掉。
check ":1 窗口管理器在管窗口（_NET_SUPPORTING_WM_CHECK）" \
  "DISPLAY=:1 xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'"
# 合成器**必须没有在跑**（规格 §4.4 的取舍）。跑起来的话 plank 会切到 ARGB 模式，
# 而这套无 GPU 虚拟显示上没有合成器混得动它 —— 结果是每张截图底部 140px 全黑。
check ":1 没有合成器在跑（规格 §4.4）" "! pgrep -x picom >/dev/null"
check ":1 xfwm4 自带合成也是关的" \
  "tr '\\0' ' ' < /proc/\$(pgrep -x xfwm4 | head -1)/cmdline 2>/dev/null | grep -q -- '--compositor=off'"
# 壁纸：xwallpaper 设的根 pixmap。
check ":1 根窗口有 _XROOTPMAP_ID" \
  "DISPLAY=:1 xprop -root _XROOTPMAP_ID | grep -q 'pixmap id'"
# 端到端那两条：直接采样桌面像素。
# **必须跑在 G2 开浏览器之前** —— Chromium 的窗口会盖住采样点，之后再采就是白的。
# 别把 G9 挪到后面去。
ROOTPX=$(DISPLAY=:1 xwd -root 2>/dev/null \
  | convert xwd:- -crop 4x4+1000+300 +repage -format '%[hex:p{0,0}]' info: 2>/dev/null)
[ "$ROOTPX" = "2E3436" ] && ok ":1 桌面底色是壁纸色 2E3436" \
                         || bad ":1 桌面底色是 ${ROOTPX:-取不到}，应为 2E3436"
# 坞那条带（y≈660-800 是**有合成器时** plank 那扇 1280x140 窗口所在）。
# 这一条只是「合成器回归」的探针：一旦谁把合成器加回来，这里立刻变 000000。
DOCKPX=$(DISPLAY=:1 xwd -root 2>/dev/null \
  | convert xwd:- -crop 4x4+20+700 +repage -format '%[hex:p{0,0}]' info: 2>/dev/null)
[ "$DOCKPX" = "2E3436" ] && ok ":1 坞那条带没被涂黑（没有合成器）" \
                         || bad ":1 坞那条带是 ${DOCKPX:-取不到}，应为 2E3436（纯黑=有合成器在跑，见 §4.4）"
# **上面那条证明不了坞活着** —— 采样点 (20,700) 在 shape 模式的坞窗口**外面**，
# plank 崩了那儿照样是壁纸色，照样绿。而 G8 的坞断言全都只打 :2，主屏的坞
# 一条都没有；start-desktop.sh 起 plank 也只 register、不做就绪检查。
# 也就是说主屏的坞死了，整套门禁没有一条会红 —— 又是「组件死了没人知道」那个模式。
# 补两条，都打效果：
#   1) 坞窗口真的映射到 :1 上，且宽度是 184 = 3 个图标 × 60px + 边距（实测 184x66+548+734）。
#      宽度就是图标数：2 个图标时是 124x66（上一轮 plank 读错目录时实测过）。
#   2) 图标区里的像素**不是**壁纸色 —— 窗口在、但 plank 没画出东西时，(1) 会绿而这条会红。
check ":1 上 plank 连着 X（窗口表里有它）" \
  "DISPLAY=:1 xwininfo -root -children | grep -q '\"plank\"'"
# **必须按位置筛，不能 head -1。** 根窗口下有两扇 184x66：一扇在 `+0+0`，是 xfwm4 的
# 残留框，**plank 死了它照样在**；真正的坞是底部居中那扇（实测 184x66+548+734）。
# 第一版写的 head -1 正好抓到残留那扇，负向验证时坞都杀了断言还是绿的。
DOCKGEO=$(DISPLAY=:1 xwininfo -root -children 2>/dev/null \
  | grep -oE '184x66\+[0-9]+\+[0-9]+' | awk -F'+' '$3 >= 700 {print; exit}')
[ -n "$DOCKGEO" ] && ok ":1 坞窗口在屏底（$DOCKGEO，184 宽 = 三个图标 × 60px）" \
                  || bad ":1 屏底没有 184x66 的坞窗口（plank 没起来，或图标数不对）"
# 曾经还有第三条：采坞窗口中心的像素，断言「不是壁纸色」= 图标真画出来了。**撤掉了。**
# 它测不准：坞窗口的 y 会在 734（完全展开）和 799（收起，只露 1px）之间变，
# 采到收起状态时那个点取到的是 `00000000`（透明），而 `00000000 != 2E3436` 成立 ——
# 断言绿着，却什么都没证明。上面两条（plank 连着 X、屏底有 184x66 的窗口）在
# plank 死掉时都会红（逐条负向验证过），够用了；再加一条测不准的只会制造噪声。

echo "=== G10 开发试验场：工具链与工作区（规格 §4.5 / §4.6）==="
# 断言「跑得起来」，不是「文件在不在」：装了但缺共享库、装了但不在 PATH 上，
# 用 which 都查不出来。每个都真的执行一次版本命令。
for t in \
  "bash --version" "sudo --version" "curl --version" "wget --version" \
  "git --version" "gcc --version" "make --version" "perl -V:version" \
  "python3 --version" "pip3 --version" "node --version" "npm --version" \
  "go version" "rustc --version" "cargo --version" "bun --version" "uv --version" \
  "gh --version" "rg --version" "jq --version" "ffmpeg -version" "tmux -V" \
  "vim --version" "nano --version" \
  "less --version" "unzip -v" "python3 -m venv --help" "playwright --version" \
  "pkg-config --version" "zip -v" "rsync --version" "file --version" "tree --version" \
  "lsof -v" "strace -V" "nc -h" "shellcheck --version" "ssh -V"
do
  # 标签取前两个词，不是只取第一个：`python3 --version` 和 `python3 -m venv --help`
  # 只取第一个词会印成同一行，看着像重复断言，实际测的是两件事。
  check "工具 $(echo "$t" | cut -d' ' -f1,2) 跑得起来" "$t"
done
# 上面那行末尾四个是补账：规格 §11.1 说的是「§4.5 的每个工具都真跑一次版本命令」，
# 而 playwright / less / unzip / venv 四个在表里有、在断言里没有。
# playwright 尤其要紧：它有自己一层 `npm install -g`，装挂了或 NODE_PATH 失效时
# 门禁照样全绿。**注意它不是 box-service 里那个 playwright-core**，两个包不同。
check "免密 sudo 可用"          "sudo -n true"
# 字体：断言**渲染时真的选得到**，不是「包装了」。fc-match 走的正是 Chromium 那条
# fontconfig 路径，装了但没进缓存、或被别的规则顶掉，dpkg -l 都查不出来。
# 三样各有各的失效样子：CJK 缺 → 中文豆腐；Liberation 缺 → 回落 DejaVu，行宽对不上、
# 排版重叠；emoji 缺 → 一格格方框。三样都直接影响 screenshot 这只「眼睛」。
check "字体 中文选得到 Noto CJK"  "fc-match -f '%{family}' ':lang=zh-cn' | grep -qi 'noto.*cjk'"
check "字体 Arial 映射到 Liberation" "fc-match -f '%{family}' 'Arial' | grep -qi liberation"
check "字体 emoji 选得到彩色字体"  "fc-match -f '%{family}' ':lang=und-zsye' | grep -qi emoji"
# locale：不设 LANG 就是 C locale，而屏名鼓励取中文、屏名又直接变成目录名（§4.6）。
# 断言打**真造一个中文名的文件再 ls 一遍**，不是只看 `locale charmap`：
# 后者只说环境变量对，前者才是这条决定真正影响到的那个行为（C locale 下
# coreutils 会把非 ASCII 名按八进制转义印出来，agent 读 ls / tree 的输出就全是乱码）。
#
# **`--quoting-style=shell-escape` 不能省。** 第一版写的是裸 `ls … | grep`，那条断言
# 是装饰品：coreutils 只在输出到**终端**时才按 locale 决定要不要转义，进管道一律走
# literal —— 于是设不设 LANG 都印 `验收屏`，无论实现对错都绿（负向验证时抓到的）。
# 显式指定引用风格才把 locale 那一维暴露出来：C locale 下得到
# `''$'\351\252\214...'`，UTF-8 下得到 `验收屏`（两边都实测过）。
LOCPROBE=$(mktemp -d)
touch "$LOCPROBE/验收屏"
check "locale 的字符集是 UTF-8"     "locale charmap | grep -q UTF-8"
check "中文文件名不被转义成八进制"   "ls --quoting-style=shell-escape '$LOCPROBE' | grep -q '^验收屏$'"
rm -rf "$LOCPROBE"
# 原生扩展真的编得动。装了 gcc/pkg-config/libssl-dev 不等于串得起来 ——
# 这一条编一个真的链 openssl 的小程序，把三者连在一起测。
#
# **check 的命令串里绝对不许出现 `exit`**：check 是 `eval "$2"`，跑在 gates.sh 自己的
# shell 里，一个 exit 就把整份门禁从这儿掐断 —— 而且带着那条命令的退出码。
# 这条断言的第一版正是这么写的：`exit $rc` 里 rc=0，于是 G11、G2–G8、S1–S4 一条没跑，
# 脚本报「全绿、退出码 0」。清理写在断言外面。
printf '#include <openssl/ssl.h>\nint main(){return OPENSSL_init_ssl(0,0)>=0?0:1;}\n' > /tmp/g10-ssl.c
check "能编译并链接 openssl（pkg-config + libssl-dev + gcc 串得起来）" \
  "gcc /tmp/g10-ssl.c -o /tmp/g10-ssl \$(pkg-config --cflags --libs openssl) && /tmp/g10-ssl"
rm -f /tmp/g10-ssl.c /tmp/g10-ssl
# python3-dev 同理：`python3 --version` / `pip3 --version` / `venv --help` 三条
# 一条都不碰 Python.h —— 从 Dockerfile 的 apt 行里删掉 python3-dev，门禁全绿。
# 而它正是 §4.5「原生扩展构建前提」那一条：pip 装带 C 扩展的包全靠它。
# 断言同样打真编译真链接真跑，`--embed` 是 3.8+ 嵌入解释器必须的。
printf '#include <Python.h>\nint main(){Py_Initialize();Py_Finalize();return 0;}\n' > /tmp/g10-py.c
check "能编译并链接 Python 扩展（python3-dev + gcc）" \
  "gcc /tmp/g10-py.c -o /tmp/g10-py \$(python3-config --cflags --ldflags --embed) && /tmp/g10-py"
rm -f /tmp/g10-py.c /tmp/g10-py
# PATH 要两处都有（规格 §4.5、实测坑 16）：ENV 管非登录进程，profile.d 管登录 shell。
# **两边都得测。** 以前只测了 bash -l 那半边，于是 ENV 那行被删掉也没人会红 ——
# 而桌面上那只 xfce4-terminal 起的是交互式**非登录** bash，靠的正是 ENV。
# 「缺一不可」写在规格里，断言就不能只覆盖一半。
for d in /home/box/.local/bin /home/box/go/bin /home/box/.cargo/bin; do
  check "登录 shell 的 PATH 含 $d" "bash -lc 'case \":\$PATH:\" in *\":$d:\"*) exit 0;; *) exit 1;; esac'"
  # 非登录：不带 -l 的 bash 既不读 /etc/profile 也不读 profile.d，PATH 只能是继承来的；
  # 而 gates.sh 自己是 docker exec 进来的，继承的正是镜像 ENV 那份。
  check "非登录 shell 的 PATH 含 $d（ENV 那半边）" \
    "bash -c 'case \":\$PATH:\" in *\":$d:\"*) exit 0;; *) exit 1;; esac'"
done
# 工作区：容器这一侧必须存在且可写。**能不能和 Mac 互通在容器里测不出来**，
# 那半边归 tests/run-gates.sh 的往返断言（门禁跑在容器内，看不见宿主机）。
check "工作区目录存在"          "[ -d /home/box/workspace ]"
check "工作区可写"              "touch /home/box/workspace/.g10-probe && rm -f /home/box/workspace/.g10-probe"

echo "=== G11 open_url 目的地闸门（规格 §7.2）==="
# 闸门是 box-service 里的一个模块，这里把它 import 进来直接问，不经 HTTP ——
# 要测的是判据本身，绕开屏、token、状态机那一整套才不会测串。
#
# 断言分两半：
#   正向：系统自己的口，从「容器自身」的各种写法打过去都得挡住（含十进制/十六进制 IP、
#         IPv6 回环、v4-mapped、localhost、0.0.0.0、eth0 地址）；且**试验场自己起的
#         dev server 必须放行** —— 闸门收窄到系统端口就是为了不废掉 §4.5 那个能力。
#   反向：**容器里当下每一个在听的端口都必须被挡住**。这一条是防清单过期的：
#         哪天加个新服务开个新口忘了登记，它立刻红。1339 当初差点就是这么漏掉的。
#
# 端口列表从 ss 里现取，不写死。IPv6 的 `[::1]:5900` 也要能切出 5900。
G11_LISTEN_PORTS=$(ss -tln 2>/dev/null | awk 'NR>1 {print $4}' | sed 's/.*://' \
  | grep -E '^[0-9]+$' | sort -un | tr '\n' ' ')
export G11_LISTEN_PORTS
G11_OUT=$(node --input-type=module -e "$(cat <<'G11EOF'
import { checkDestination, systemPorts } from 'file:///opt/box-service/lib/url-guard.mjs';
import { networkInterfaces } from 'node:os';

const out = [];
const say = (good, desc) => out.push(`${good ? 'OK' : 'BAD'}|${desc}`);
const blocked = async (u) => !(await checkDestination(u)).ok;

// 容器自己的 eth0 地址。闸门挡的是「这台容器」，不是「字面量 127.0.0.1」——
// 18765/6080/6081 绑的是 0.0.0.0，eth0 地址一样打得通。
const self = Object.values(networkInterfaces()).flat()
  .filter((n) => n && !n.internal && n.family === 'IPv4').map((n) => n.address);

for (const [u, want, what] of [
  ['http://127.0.0.1:18765/v1/screens', true, '窗口服务 18765'],
  ['http://127.0.0.1:1339/', true, '窗口路由器 1339'],
  ['http://127.0.0.1:9223/json/version', true, 'CDP 主屏 9223'],
  ['http://127.0.0.1:9224/json/list', true, 'CDP 副屏 9224'],
  ['http://127.0.0.1:5900/', true, '原始 VNC 5900'],
  ['http://127.0.0.1:6080/', true, 'noVNC 主屏 6080'],
  ['http://127.0.0.1:6081/vnc.html', true, 'noVNC 副屏 6081'],
  ['http://127.0.0.2:18765/', true, '回环整段 127.0.0.2'],
  ['http://2130706433:18765/', true, '十进制写法的回环'],
  ['http://0x7f000001:1339/', true, '十六进制写法的回环'],
  ['http://[::1]:9224/', true, 'IPv6 回环'],
  ['http://[::ffff:127.0.0.1]:18765/', true, 'v4-mapped 的 IPv6 回环'],
  ['http://localhost:18765/', true, 'localhost'],
  ['http://LocalHost.:6081/', true, '带尾点、大小写混写的 localhost'],
  ['http://0.0.0.0:18765/', true, '0.0.0.0'],
  ['http://127.0.0.1:3000/', false, '试验场 dev server 3000 放行（§4.5）'],
  ['https://example.com/', false, '普通 https 放行'],
  ['http://example.com:18765/', false, '别人机器上的 18765 放行'],
]) {
  say((await blocked(u)) === want, `${want ? '挡住' : '放行'} ${what}`);
}

for (const ip of self) {
  say(await blocked(`http://${ip}:18765/`), `挡住容器自己的 eth0 地址 ${ip}:18765`);
}
if (self.length === 0) say(false, '取不到容器自己的 eth0 地址（闸门那一维没被测到）');

// 反向：在听的每一个口都必须挡得住
const listening = (process.env.G11_LISTEN_PORTS || '').trim().split(/\s+/).filter(Boolean).map(Number);
if (listening.length === 0) {
  say(false, '拿不到监听端口清单（反向断言没跑成）');
} else {
  const leaked = [];
  for (const p of listening) {
    if (!(await blocked(`http://127.0.0.1:${p}/`))) leaked.push(p);
  }
  say(leaked.length === 0,
    leaked.length === 0
      ? `在听的 ${listening.length} 个端口闸门全挡得住（${listening.join(' ')}）`
      : `端口 ${leaked.join(' ')} 在听但闸门不挡 —— 新服务要登记进 url-guard 的清单（systemPorts 现有 ${systemPorts().length} 个）`);
}
console.log(out.join('\n'));
G11EOF
)" 2>&1)
# node 自己崩了的话上面是空的 / 是一篇栈。不检查的话这一节会「零条断言全绿」——
# 那正是本仓库栽过三次的那种假绿。
if ! echo "$G11_OUT" | grep -qE '^(OK|BAD)\|'; then
  bad "G11 闸门自测没跑起来：$(echo "$G11_OUT" | head -3 | tr '\n' ' ')"
else
  while IFS='|' read -r verdict desc; do
    case "$verdict" in
      OK)  ok "$desc" ;;
      BAD) bad "$desc" ;;
    esac
  done <<< "$G11_OUT"
fi

echo "=== G2 按需开浏览器：9223 通、窗口在 :1 ==="
DISPLAY=:1 box-chrome >/dev/null 2>&1
check "127.0.0.1:9223/json/version 200" "curl -sf http://127.0.0.1:9223/json/version"
check "窗口在 :1 上"                     "DISPLAY=:1 xwininfo -root -children | grep -qi chromium"

echo "=== G3 start-window 2 tokA ==="
stop-window 2 >/dev/null 2>&1
start-window 2 "$TOKA" >/dev/null 2>&1
check ":2 活着"                    "DISPLAY=:2 xdpyinfo"
DISPLAY=:2 box-chrome >/dev/null 2>&1   # start-window 不起浏览器，按需另起
check "9224 通"                    "curl -sf http://127.0.0.1:9224/json/version"
check "start-window 不把显示号写成 noVNC token" "! grep -qx '2: localhost:5902' $NOVNC_TOKEN_DIR/2 2>/dev/null"
check "owner 是 tokA"              "[ \"\$(cat $TOKEN_DIR/2)\" = \"$TOKA\" ]"

echo "=== G8 坞（规格 §4.3）==="
# 断言 plank 进程真的绑在这一路 DISPLAY 上，而不是「有个叫 plank 的进程」——
# 后者在多屏下会被别的屏的坞蒙混过关。用监督表登记的 pid 反查，那是准的。
DOCK_PID=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$SUPERVISE_DIR/d2/plank.json" 2>/dev/null)
check "坞已登记进监督组 d2"        "[ -n '$DOCK_PID' ]"
check "坞进程活着（pid $DOCK_PID）" "kill -0 '$DOCK_PID' 2>/dev/null"
check "坞实例名是 dock1（照观察值）" "tr '\\0' ' ' < /proc/$DOCK_PID/cmdline 2>/dev/null | grep -q -- '-n dock1'"
check "坞的 DISPLAY 是 :2"          "tr '\\0' '\\n' < /proc/$DOCK_PID/environ 2>/dev/null | grep -qx 'DISPLAY=:2'"
# 三个图标：Chrome、文件管理、终端（《确定-客户端界面路径》）
#
# **断言必须打在 plank 真正读的目录上**：它读 $XDG_CONFIG_HOME/plank/dock1/launchers，
# 不是 XDG_DATA_HOME。这条以前查的是 /tmp/plank-data-2/…，那个目录 plank 一眼都没看过 ——
# 文件确实躺在那里，门禁于是全绿，而屏上画的是 plank 自己生成的默认项。
# 先确认 plank 进程的 XDG_CONFIG_HOME 就是我们铺的那个目录，再查目录里的文件，
# 两条连起来才构成「铺的图标 = 画出来的图标」。
DOCK_DIR=$(plank_conf_dir 2)/plank/dock1/launchers
check "坞的 XDG_CONFIG_HOME 指向本屏目录" \
  "tr '\\0' '\\n' < /proc/$DOCK_PID/environ 2>/dev/null | grep -qx 'XDG_CONFIG_HOME=$(plank_conf_dir 2)'"
for it in 01-browser 02-files 03-terminal; do
  check "坞图标 $it 已铺进 plank 真正读的目录" "[ -e '$DOCK_DIR/$it.dockitem' ]"
done
# plank 找不到 launchers 时会自己生成一套默认项（实测是 Chromium + ImageMagick 的
# 魔法师）。这条就是那次事故的签名：一旦目录又铺错，多出来的文件会在这里露头。
EXTRA=$(ls "$DOCK_DIR" 2>/dev/null | grep -vE '^0[123]-(browser|files|terminal)\.dockitem$' || true)
[ -z "$EXTRA" ] && ok "坞里没有 plank 自动生成的默认项" \
                || bad "坞里混进了非我们铺的项：$(echo "$EXTRA" | tr '\n' ' ')"
# 应用装了但**不该自动跑** —— 坞是画面的一部分，应用是点了才开（G1 那条纪律的延伸）
check "文件管理器已安装"            "[ -f /usr/share/applications/thunar.desktop ]"
check "终端已安装"                  "[ -f /usr/share/applications/xfce4-terminal.desktop ]"
check "文件管理器没有自动跑"        "! pgrep -x thunar >/dev/null"
check "终端没有自动跑"              "! pgrep -x xfce4-terminal >/dev/null"

echo "=== G4 对活着的 :2 再 start-window 2 tokB → 75，owner 不变 ==="
start-window 2 "$TOKB" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 75 ] && ok "退出码 75" || bad "退出码是 $rc，应为 75"
check "owner 仍是 tokA"            "[ \"\$(cat $TOKEN_DIR/2)\" = \"$TOKA\" ]"

echo "=== G5 :1 登录后新开 :2，Cookies 是指向主库的符号链接 ==="
stop-window 2 >/dev/null 2>&1
sqlite3 "$SESSION_STORE/Cookies" "create table if not exists gate_probe(k);" 2>/dev/null
start-window 2 "$TOKA" >/dev/null 2>&1
DISPLAY=:2 box-chrome >/dev/null 2>&1
FORK_COOKIES="$(profile_dir 2)/Default/Cookies"
check "副屏 Default 是真目录（不是链接）" "[ -d \"$(profile_dir 2)/Default\" ] && [ ! -L \"$(profile_dir 2)/Default\" ]"
check "Cookies 是符号链接"          "[ -L \"$FORK_COOKIES\" ]"
check "与主库同一个 inode"          "[ \"\$(stat -L -c %i \"$FORK_COOKIES\")\" = \"\$(stat -L -c %i \"$SESSION_STORE/Cookies\")\" ]"

echo "=== S1/S2 owner token 闸 ==="
R="http://127.0.0.1:$ROUTER_PORT/probe"
code() { curl -s -o /dev/null -w '%{http_code}' -H "x-sand-display: $1" ${2:+-H "x-sand-window-owner: $2"} "$R"; }
[ "$(code 2 "$TOKB")" = "403" ] && ok "S1 错 token 打 :2 → 403" || bad "S1 错 token 没被拒"
[ "$(code 2)" = "403" ]         && ok "S2 不带 token 打 :2 → 403" || bad "S2 无 token 没被拒"
mv "$TOKEN_DIR/2" "$TOKEN_DIR/.2.bak"
[ "$(code 2 "$TOKA")" = "403" ] && ok "S2 未绑定 → fail-closed" || bad "S2 未绑定时没有 fail-closed"
mv "$TOKEN_DIR/.2.bak" "$TOKEN_DIR/2"
CURTOK=$(cat "$TOKEN_DIR/2" 2>/dev/null || echo "")
# **正对照。上面全是负向断言，少了这一条，「路由器对什么都回 403」能让 S1/S2 整段全绿。**
# 期望 502 而不是 200：过了闸之后 1337 没有后端（§7.3 不做执行守护），502 就是「已过闸」。
[ "$(code 2 "$CURTOK")" = "502" ] && ok "S2 正确 token 打 :2 → 过闸（无后端 → 502）" \
                                  || bad "S2 正确 token 反而没过闸（得到 $(code 2 "$CURTOK")）"
# owner 文件为空 → fail-closed。打的是 sand-window-router.mjs 里
# `if (expected.length === 0) return false` 那个分支，此前零覆盖 —— 而 start-window
# 写 token 写到一半被打断，留下的正是这个残局。
#
# 上一版是 `: > $TOKEN_DIR/.empty-probe` 再 `code 2 ""`，两处都错：那个探针文件全仓库
# 没有读者（路由器读的是 $TOKEN_DIR/<显示号>），而 bash 的 `${2:+…}` 对**空串**同样
# 按 null 处理，于是 `code 2 ""` 展开后和上面那条「不带 token」逐字相同 —— 一条断言的复制品。
# 这一版送的是**本该正确的那个 token**：文件一空，连它也必须被拒。
cp "$TOKEN_DIR/2" "$TOKEN_DIR/.2.bak"
: > "$TOKEN_DIR/2"
[ "$(code 2 "$CURTOK")" = "403" ] && ok "S2 owner 文件为空 → 连正确 token 也拒（fail-closed）" \
                                  || bad "S2 owner 文件为空时没有 fail-closed"
mv "$TOKEN_DIR/.2.bak" "$TOKEN_DIR/2"
# :1 不验 token —— 后面没有 1337 后端，所以期望 502（已过闸）而不是 403
[ "$(code 1)" = "502" ] && ok "S1 :1 不验 token（过闸后无后端 → 502）" \
                        || bad "S1 :1 的免验语义不对（得到 $(code 1)）"

echo "=== S3 会话同步遇到已有键不覆盖 ==="
# 需要第二块带浏览器的屏。跑完就拆，不常驻。
start-window 3 "s3probe" >/dev/null 2>&1
DISPLAY=:3 box-chrome >/dev/null 2>&1
# 退出码两分：90 = 前置没满足、一条都没跑；其余 = 真跑了（0 全过 / 1 有红）。
# **「没跑」必须记成红**，不能记成过 —— 上一版探针在这里退 0，于是第三块屏起不来时
# 零条断言换两分绿，而 S3 是唯一用到 :3 的用例，别处一条都不会红，尾行护栏也照样放行。
#
# 90 这个数是挑过的：上一版用 3，而探针收尾是 `exit $fail` —— 断言加到 8 条之后，
# 恰好红 3 条时这儿就会把一次真实失败读成「没跑」（负向验证时真撞上了）。
#
# 条数**从探针自己印的 ✓/✗ 行数记**，不写死。写死那版是 `PASS+=2`：探针一扩断言，
# 账就和屏上印的对不上，而门禁的总数正是别人判断「有没有漏跑」的依据。
S3OUT=$(node /usr/local/bin/sync-probe.mjs 9224 9225 2>&1)
S3RC=$?
echo "$S3OUT"
if [ "$S3RC" -eq 90 ]; then
  bad "S3 一条断言都没跑（前置的第三块屏没起来）—— 记成红，不是跳过"
else
  S3OK=$(echo "$S3OUT" | grep -c '✓' || true)
  S3BAD=$(echo "$S3OUT" | grep -c '✗' || true)
  PASS=$((PASS + S3OK)); FAIL=$((FAIL + S3BAD))
  # 探针崩在半路时既不是 90、也印不出几行 —— 这条兜住那种情形。
  [ "$S3OK" -gt 0 ] || bad "S3 一条 ✓ 都没有（探针没正常跑完？退出码 $S3RC）"
fi
stop-window 3 >/dev/null 2>&1

echo "=== S4 调试口与画面口不在 0.0.0.0 监听 ==="
LEAK=$(ss -tln | grep -E '0\.0\.0\.0:(922[0-9]|59[0-9][0-9])' || true)
[ -z "$LEAK" ] && ok "9222+N / 5900+N 只绑回环" || bad "泄漏：$LEAK"

echo "=== G6 stop-window 2 ==="
# **坞的 pid 必须在这儿重读一次。**
#
# G8 那次读到的是 G3 开屏起的那只 plank，而中间的 G5 做过一次 stop-window 2 +
# start-window 2 —— 那只 plank 早在两步之前就死了。拿它去断言「坞跟着屏死」恒真，
# 护栏护的是上一条命的进程：把 stop-window 里杀坞那段整个删掉，这条照样绿。
DOCK_PID6=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$SUPERVISE_DIR/d2/plank.json" 2>/dev/null)
# 先立基线：停屏**之前**它得是活的。少了这条，下面那条「没了」在坞压根没起来时也绿。
check ":2 的坞在停屏前活着（pid ${DOCK_PID6:-取不到}）" \
  "[ -n '$DOCK_PID6' ] && kill -0 '$DOCK_PID6' 2>/dev/null"
stop-window 2 >/dev/null 2>&1; sleep 1
check ":2 的 X 没了"    "! DISPLAY=:2 xdpyinfo"
check ":2 的画面口没了"  "! ss -tln | grep -q '127.0.0.1:5902'"
check ":2 的 token 文件没了" "[ ! -e $TOKEN_DIR/2 ]"
# 坞必须跟着屏一起死。加坞之前 stop-window 只按 pkill pattern 杀，任何没写进 pattern 的
# 组件都会变成孤儿；现在改成按监督表登记的 pid 杀，这条就是那个改动的护栏。
# 用刚重读的 DOCK_PID6，也不要 `[ -z … ] ||` 那个逃生口 —— 读空时它让这条自动绿，
# 而「读不到 pid」恰恰是上面那条基线该报的问题，不该在这里被吞掉。
check ":2 的坞进程没了"   "! kill -0 '$DOCK_PID6' 2>/dev/null"
check ":2 的坞状态目录没了" "[ ! -d '$(plank_conf_dir 2)' ] && [ ! -d '$(plank_data_dir 2)' ]"
# 会话总线也归这一屏。socket 文件留着的话，下次开同一块屏 dbus-daemon 会因为
# 地址被占而起不来，接着 xfwm4 也起不来 —— 一次没清干净就是下一次开屏失败。
check ":2 的会话总线没了" "[ ! -e '$(run_dir 2)/bus' ]"
check ":1 还在"          "DISPLAY=:1 xdpyinfo"

echo "=== G7 stop-window 1 是空操作 ==="
stop-window 1 >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "退出码 0" || bad "退出码是 $rc，应为 0"
check ":1 仍在"          "DISPLAY=:1 xdpyinfo"

echo
echo "================================"
echo "通过 $PASS  失败 $FAIL"
[ "$FAIL" -eq 0 ] && echo "门禁全绿 ✓" || echo "门禁未绿 ✗"
exit "$FAIL"
