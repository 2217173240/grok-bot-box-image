# box-service —— 容器内窗口服务 :18765

系统的**唯一权威**（《规格-MVP-v1》§3）。窗口表、owner token 的 mint 与消费、屏状态机、
页面驱动、桌面截图，全在这一层；Mac 侧的 `mcp-server/` 只是搬 JSON 的薄代理。

纪律（§7）在这里强制，不在调用方：连上来的可能是任意第三方 client，可能被提示注入。

## 文件

| 文件 | 干什么 |
| --- | --- |
| `server.mjs` | HTTP 面、路由、闸门顺序、九个工具对应的九个端点 |
| `lib/screens.mjs` | 窗口表、token mint、状态机、退出码 75 处理、15 分钟接管超时 |
| `lib/snapshot.mjs` | **快照剥离**（整个服务最不能出错的一块） |
| `lib/browser.mjs` | `connectOverCDP` 连该屏的 Chromium、选页、按需拉起 |
| `lib/screenshot.mjs` | `xwd -root` + `convert` |
| `lib/db.mjs` | SQLite（走 `sqlite3` 命令行，理由写在文件头） |
| `lib/run.mjs` | 调 `start-window` / `stop-window` / `box-chrome` |
| `lib/errors.mjs` | 规格 §6.5 的错误码 |

## 怎么起

依赖只有 `playwright-core`，且**必须装在本目录**：ESM 下 `NODE_PATH` 无效
（《可行性实测》坑 5）。

```bash
# 容器内
cd /home/box/box-service && npm install --omit=dev
node server.mjs
```

开发时把仓库里的目录塞进已在跑的容器最快（`node_modules` 是纯 JS，Mac 上装的可以直接用）：

```bash
docker cp box-service mac-bot-gates:/home/box/box-service
docker exec -d mac-bot-gates bash -c 'cd /home/box/box-service && node server.mjs >>/tmp/box-service.log 2>&1'
docker exec mac-bot-gates cat /tmp/box-service.log
```

容器起法见 `tests/run-gates.sh`（`--security-opt seccomp=unconfined`，只 publish
`127.0.0.1` 的 6080 / 6081 / 18765）。

**绑的是容器内 `0.0.0.0`，不是 `127.0.0.1`**：隔离边界是容器的网络命名空间，宿主机那侧只
publish 到 `127.0.0.1:18765`。绑回环的话 docker-proxy 从 eth0 进来，Mac 侧永远连不上。

可用环境变量（都只为脱离容器自测，容器里用默认值）：
`BOX_SERVICE_HOST` `BOX_SERVICE_PORT` `BOX_DB` `BOX_BIN_DIR` `BOX_MAX_DISPLAY`。

## HTTP 面

对应规格 §6 的九个工具。屏名走 URL 段，要 percent-encode。

| 方法 | 路径 | 工具 | awaiting_human 时 |
| --- | --- | --- | --- |
| POST | `/v1/screens` `{screen}` | create_screen | — |
| GET | `/v1/screens` | list_screens | 放行 |
| DELETE | `/v1/screens/:name` | destroy_screen | 放行 |
| POST | `/v1/screens/:name/open` `{url}` | open_url | **WINDOW_BUSY** |
| POST | `/v1/screens/:name/snapshot` | snapshot | **WINDOW_BUSY** |
| POST | `/v1/screens/:name/act` `{action,ref,text?,key?}` | act | **WINDOW_BUSY** |
| GET | `/v1/screens/:name/screenshot` | screenshot | **WINDOW_BUSY** |
| POST | `/v1/screens/:name/ask-human` `{reason,message}` | ask_human | 幂等返回 |
| POST | `/v1/screens/:name/release` | human_release | 放行 |

另有 `GET /healthz`（不是工具，给 `mac-bot doctor` 探活用）。

**所有屏级响应都带 `state`；`awaiting_human` 时一并带 `novncUrl`**（规格 §6）——
MCP server 靠这两个字段决定弹不弹浏览器。

错误信封：`{"error":{"code":"...","message":"..."}}`，HTTP 状态
403 `WINDOW_FORBIDDEN` / `ACTION_BLOCKED`、409 `WINDOW_BUSY`、404 `WINDOW_GONE`、
502 `SNAPSHOT_EMPTY`、504 `TIMEOUT`、400 `BAD_REQUEST`、500 `INTERNAL`。

`open` / `act` / `snapshot` 的返回体：

```json
{ "screen": "研究", "url": "...", "title": "...", "needsHuman": true,
  "reason": "password", "state": "awaiting_human",
  "novncUrl": "http://127.0.0.1:6081/vnc.html?autoconnect=1&path=websockify%3Ftoken%3D2", "expiresInSec": 900,
  "snapshot": "- textbox \"密码\" [ref=e7] [password]\n- button \"登录\" [ref=e10]" }
```

`snapshot` 是**剥离后的 YAML 文本**，不是 JSON 数组：层级正是「这个按钮属于哪个表单」的依据。

## 怎么手测

下面这套在真容器里跑通过（镜像 `mac-bot`）。先按上面把服务起起来。

**0 造一个带密码框的页面**（容器内，别用外网站点做剥离验证）

```bash
docker exec mac-bot-gates bash -c 'cat > /tmp/login-server.mjs <<"EOF"
import http from "node:http";
const html = `<h1>登录</h1><form>
<input type="email" autocomplete="username" value="a@b.com">
<input type="password" value="hunter2">
<input type="text" autocomplete="one-time-code" value="123456">
<button type="button">登录</button></form>`;
http.createServer((q,s)=>{s.writeHead(200,{"content-type":"text/html; charset=utf-8"});s.end(html);}).listen(18999,"127.0.0.1");
EOF
nohup node /tmp/login-server.mjs >/tmp/login-server.log 2>&1 &'
```

**1 开屏 / 列屏**（E2）

```bash
B=http://127.0.0.1:18765
curl -s -X POST $B/v1/screens -d '{"screen":"yanjiu"}'
curl -s $B/v1/screens
docker exec mac-bot-gates ls /tmp/sand-window-tokens.d/     # 容器内 token 文件存在
```

**2 打开登录页 → 剥离 + 自动接管**（E3 / E5）

```bash
curl -s -X POST $B/v1/screens/yanjiu/open -d '{"url":"http://127.0.0.1:18999/"}'
```

要看到：密码与 OTP 节点是 `[ref=e7] [password]` 且**不带值**，全文搜不到 `hunter2` /
`123456`；`needsHuman:true`、`reason:"password"`、`state:"awaiting_human"`、带 `novncUrl`。

**3 接管期间四个动作全拒**（E6）

```bash
curl -s -X POST $B/v1/screens/yanjiu/snapshot     # WINDOW_BUSY
curl -s      $B/v1/screens/yanjiu/screenshot      # WINDOW_BUSY
curl -s -X POST $B/v1/screens/yanjiu/act -d '{"action":"click","ref":"e10"}'   # WINDOW_BUSY
curl -s      $B/v1/screens                        # 放行
```

**4 交还 + 对密码框 fill 被拒**（E7 / E4）

```bash
curl -s -X POST $B/v1/screens/yanjiu/release
curl -s -X POST $B/v1/screens/yanjiu/act -d '{"action":"fill","ref":"e7","text":"x"}'  # ACTION_BLOCKED
curl -s -X POST $B/v1/screens/yanjiu/act -d '{"action":"fill","ref":"e5","text":"z@z.com"}'  # 通过
```

注意：页面上还有密码框，所以每次动作后的新快照又会把屏翻回 `awaiting_human`。这是规格
§5.2 的语义，不是 bug —— 调用方要么 `release` 再动，要么把这页交给人。

**5 截图**（E11）

```bash
curl -s $B/v1/screens/yanjiu/screenshot | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);require("fs").writeFileSync("/tmp/shot.png",Buffer.from(j.base64,"base64"));console.log(j.bytes)})'
open /tmp/shot.png
```

**6 退出码 75**（E13）—— 把 owner 文件改坏，再 create 一次

```bash
docker exec mac-bot-gates bash -c 'printf bogus > /tmp/sand-window-tokens.d/2'
curl -s -X POST $B/v1/screens -d '{"screen":"yanjiu"}'      # 应正常返回
docker exec mac-bot-gates cat /tmp/box-service.log | tail -3 # 日志里能看到「退出 75，拆掉重开」
docker exec mac-bot-gates bash -c 'wc -c < /tmp/sand-window-tokens.d/2'  # 64 = 新 token
```

**7 token 不泄漏**（E9）

```bash
TOK=$(docker exec mac-bot-gates sqlite3 /home/box/sand-data/box.sqlite "select token from screens where status='active'")
curl -s $B/v1/screens | grep -c "$TOK"   # 必须是 0
```

**8 拆屏**（E12）

```bash
curl -s -X DELETE $B/v1/screens/yanjiu
docker exec mac-bot-gates ls /tmp/.X11-unix/    # 只剩 X1
docker exec mac-bot-gates sqlite3 /home/box/sand-data/box.sqlite "select name,state,status from screens"
```

**9 15 分钟接管超时**（E8）—— 干等太久，把 `lib/config.mjs` 的 `AWAITING_HUMAN_MS`
临时改成 5 秒验证行为，验完改回来。

## 已知边界

- 快照的 `ref` 每次重取都可能变；调用方必须「快照 → 立即 act」，别缓存 ref
- 同一块屏的动作串行排队，排队时间算进 30s 请求超时里
- 服务重启不拆屏（屏的生死只由 `destroy_screen` 决定）；仍在 `awaiting_human` 的屏
  会**重新**计满 15 分钟，因为规格 §10 的表里没有 `state_changed_at`，不擅自加列
- 绑 `0.0.0.0` 使 18765 对**同一 docker 网桥上的其他容器**也可达（对 Mac 侧仍只有
  `127.0.0.1`）。风险等级同规格 §9.4 那三条「本机任何进程都能连」，但范围是新的；
  真要收窄，得在容器网络那层做（自建网络 / `--network none` + 显式 publish），不在本服务里
