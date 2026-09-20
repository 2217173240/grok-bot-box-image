// 常量。端口公式与路径必须和 box-image/bin/box-common.sh 一致，
// 那份是《确定-计算环境-契约》§2 的落地，这里只是镜像一份给 Node 用，不要各自演化。
//
// 允许用环境变量覆盖，只为了能在 Mac 上不起容器地跑单测；容器里一律用默认值。

// 容器内绑 0.0.0.0。看着比 127.0.0.1 松，其实不是：隔离边界是容器的网络命名空间，
// 而 18765 在宿主机上只 publish 到 `127.0.0.1:18765`（规格 §3.1）。
// 反过来若在容器里绑回环，docker-proxy 是从容器 eth0 进来的，Mac 侧永远连不上 —— 实测过。
export const HOST = process.env.BOX_SERVICE_HOST ?? '0.0.0.0';
export const PORT = Number(process.env.BOX_SERVICE_PORT ?? 18765);

export const CDP_BASE = 9222;
// 原始 VNC 口 5900+N。**一律不 publish**（规格 §3.1），这里只用于容器内探活：
// 端口可连是判断一块屏是否真活着的唯一可靠依据（规格 §5.4、《可行性实测》坑 10）。
export const VNC_BASE = 5900;
export const PRIMARY_DISPLAY = 1; // :1 是共享主屏，不分配给调用方
export const MAX_DISPLAY = Number(process.env.BOX_MAX_DISPLAY ?? 9);

/**
 * 同时开着的屏数上限（规格 §4.6）。
 *
 * **和 MAX_DISPLAY 不是一回事**：那个是端口公式（9222+N / 5900+N）的上限，说的是
 * 「显示号能编到几」；这个说的是「内存撑得住几块」。实测：容器空载约 200MB，
 * 每只 Chromium 约 800MB，OrbStack 默认给 8GB —— 4 块已经吃紧，真开到 9 块会先 OOM。
 *
 * 为什么必须有第二道闸：屏是无鉴权的全局命名空间（§9.4），一个跑飞的 agent 循环
 * create_screen 就能把容器开到 OOM，而 OOM 是**整只容器一起死** —— 连别人那几块
 * 正在用的屏一起带走。这不是安全边界（挡不住蓄意的），是防手滑和防跑飞。
 */
export const MAX_SCREENS = Number(process.env.BOX_MAX_SCREENS ?? 4);

export const NOVNC_PRIMARY = 6080;
export const NOVNC_FORKS = 6081;
// 窗口路由器。副屏的 owner token 在它那儿消费（照观察值那台的 1339）。
export const ROUTER_PORT = 1339;
// 副屏执行口 14000+N。**我们没有执行守护**（规格 §7.3 砍掉了 exec），没有东西在听；
// 常量留着是因为契约 §2 有它，而 url-guard 宁可多挡一段没人用的口。
export const EXEC_FORK_BASE = 14000;

/**
 * 工作区（规格 §4.6）。**每块屏一格**：`<根>/<屏名>`。
 *
 * 为什么用屏名当隔离单位，而不是另发一个 session id：屏名本来就是这套东西里的持久身份
 * —— 登录态、reattach（E10）全挂在它上面。文件也挂上去，一块屏 = 一个浏览器 + 一份登录态
 * + 一个目录，是同一个故事；再发一个 id 反而要和 stdio 的 reattach 模型打架。
 */
export const WORKSPACE_ROOT = process.env.BOX_WORKSPACE_ROOT ?? '/home/box/workspace';

/**
 * 工作区在 **Mac 上**的根，由 `mac-bot up` 用 `-e` 烧进来（容器自己无从知道）。
 *
 * 这条是「文件怎么进出」的关键：调用方 agent 跑在 Mac 上，用的是它自己的读写工具，
 * 只认 Mac 路径；容器内路径对它没用。两个都给出来，agent 才知道
 * 「我往哪儿写」和「待会儿在容器里 cd 到哪儿」是同一个地方。
 */
export const WORKSPACE_HOST_ROOT = process.env.MAC_BOT_WORKSPACE_HOST?.trim() || null;

export const DB_PATH = process.env.BOX_DB ?? '/home/box/sand-data/box.sqlite';
export const BIN_DIR = process.env.BOX_BIN_DIR ?? '/usr/local/bin';

// 规格 §6.5：默认 30s，create_screen 60s
export const TIMEOUT_MS = 30_000;
export const CREATE_TIMEOUT_MS = 60_000;

// 规格 §8：服务端 15 分钟超时，不依赖任何 UI，也不依赖调用方老实。
// 可用 BOX_AWAITING_HUMAN_SEC 覆盖 —— 只为验收能真跑一遍超时路径（E8），
// 不然这条要么等 15 分钟，要么只能靠读代码"确认"。生产不要设这个变量。
export const AWAITING_HUMAN_MS = Number(process.env.BOX_AWAITING_HUMAN_SEC ?? 15 * 60) * 1000;
export const AWAITING_HUMAN_SEC = AWAITING_HUMAN_MS / 1000;

export const cdpPort = (n) => CDP_BASE + n;

// 规格 §8。**不要退回成 `?token=${n}`** —— 那是被观察系统的写法，对我们装的
// noVNC 1.6.0 是静默失败：客户端压根不解析 token 参数（app/ core/ vnc.html 里零处），
// 只认 path（默认 `websockify`），WebSocket 地址由它拼出。token 不进 path 就到不了
// websockify 的 TokenFile 插件，页面能打开、连不上，还不报错。见《可行性实测》坑 6。
//
// autoconnect=1 同样是必需的：缺了会停在 Connect 面板等人点，而这个 URL 是自动弹给
// 人接管用的，多一步点击就少一分接得住。
// novncUrl 搬到 lib/novnc-auth.mjs：token 必须是签发的凭证，不能再是显示号。
