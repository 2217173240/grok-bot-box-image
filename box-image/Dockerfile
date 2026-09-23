# mac-bot 计算环境
# 规格见 docs/grok_bot/规格-MVP-v1.md，实测依据见 规格-MVP-v1-可行性实测.md
FROM debian:trixie@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      # 桌面栈。**没有合成器**：as-built §3 那一步跑 picom，我们实测后砍掉了，
      # 理由见规格 §4.4（坞的 ARGB 窗口在这套无 GPU 虚拟显示上混不动，整条渲染成黑）。
      # 不留在镜像里，是为了让「装了什么」和「跑了什么」始终对得上。
      xvfb x11vnc xfwm4 \
      x11-utils x11-xserver-utils x11-apps imagemagick \
      # 会话总线。xfwm4 要 Xfconf、plank 要 dconf，两者都只走 D-Bus；没有它
      # xfwm4 起不来，桌面就没有窗口管理器。作为直接依赖显式装，别靠别的包捎带。
      # 不装 dbus-x11（dbus-launch）：那会让每个进程各起一条总线，
      # start-desktop.sh 是每屏显式起一条并把地址传下去。
      dbus-daemon dbus-bin \
      # 壁纸。合成器画根窗口只认 _XROOTPMAP_ID，而 xsetroot -solid 不建根 pixmap，
      # 于是 picom 一开桌面全黑（实测）。xwallpaper 会设这个属性。
      xwallpaper \
      # 浏览器。arm64 上没有 Google Chrome 的 Linux 包，用 Chromium。
      # 实测 trixie/arm64 是 151.0.7922.137，与观察环境的 Chrome 151.0.7922.71 同一条构建线。
      chromium chromium-sandbox \
      # 画面入口
      novnc websockify \
      # 坞与桌面应用（规格 §4.3）。观察值有一个 plank 坞，图标是 Chrome / 文件管理 / 终端。
      # 只有坞随桌面自动起，另两个是坞上的图标，点了才开 —— 自动起会让门禁 G1
      # 「冷启动不应有 Chromium 进程」那条纪律名存实亡。
      # **终端的安全代价见规格 §9.4**：它把「能看到屏」抬成了「容器内任意代码执行」。
      plank thunar xfce4-terminal \
      # 字体。基础镜像只有 fonts-dejavu-*（共 8 个字体，零 CJK），中文站点全渲染成豆腐块。
      # 对本项目这不是外观问题：screenshot 是给有视觉的 client 当眼睛用的，
      # 字都认不出等于眼睛瞎一半。见《可行性实测》坑 8。
      #   - noto-cjk：中日韩
      #   - liberation：Arial / Times / Courier 的度量兼容替代。网页大量指名这三个，
      #     没有它时 fontconfig 会回落到 DejaVu，行宽对不上 —— 表现为排版错位、文字重叠。
      #   - noto-color-emoji：**同一条「眼睛」的理由**。现代页面到处是 emoji，
      #     缺了就是一格格豆腐块，agent 读截图时会把它们当成缺失的内容。
      #     观察值那台这两样都有（用户截图），我们此前只装了 CJK 那一样。
      fonts-noto-cjk fonts-liberation fonts-noto-color-emoji \
      # 运行时与排查
      procps psmisc curl ca-certificates sqlite3 iproute2 \
      nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# 开发试验场的工具链（规格 §4.5）。**单独一层**，别并进上面那个 apt 块：
# 桌面栈很少动，工具链会常动，合成一层等于每次加个工具就重装一遍桌面。
#
# 版本不用挑：Debian trixie 里现成的就正好对上被观察机器那台的清单 ——
# Go 1.24、Rust 1.85、gh 2.46、Python 3.13、gcc 14。不去 rustup / go.dev 拉 tarball，
# apt 版可复现、跟着安全更新走，也省掉一大堆构建期下载。
RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      # 基础：观察值那台自带的一套
      sudo wget git build-essential perl less unzip \
      # Python：镜像里的 python3 已是 3.13，补 pip 和 venv
      python3-pip python3-venv python3-dev \
      # Go / Rust
      golang-go rustc cargo \
      # 顺手的排查工具
      gh ripgrep jq ffmpeg tmux \
      # 编辑器。观察值那台没有，但一个没有编辑器的试验场不算试验场（§4.5 的显式偏离）
      vim nano \
      # 原生扩展的构建前提。cargo / pip 装带 C 扩展的包时，缺这两个的报错
      # （openssl-sys 那一篇、pkg-config not found）是新环境里最常见的一堵墙，
      # 而它离「gcc 装了就该能编」的直觉很远 —— 装上比让 agent 现去猜便宜得多。
      pkg-config libssl-dev \
      # 文件进出与打包：zip 配已有的 unzip，rsync 是跨目录同步的默认手段，
      # file 用来认没有扩展名的产物，tree 用来把目录结构一次性交给 agent 读。
      zip rsync file tree \
      # 排查：lsof 查端口占用（本项目「探活必须打端口」那条纪律的手工版），
      # strace 查卡住的进程，netcat 探连通性。
      lsof strace netcat-openbsd \
      # shell 脚本静态检查。这个仓库本身有一半是 bash，agent 改完能自己先过一遍。
      shellcheck \
      # git 走 ssh remote 要它；HTTPS + gh 那条路已经通了，但 ssh 是很多仓库的默认。
      openssh-client \
    && rm -rf /var/lib/apt/lists/*

# bun 与 uv：Debian 里没有，取官方 arm64 二进制。版本写死，要升就改这四个 ARG ——
# 用 `curl | bash` 那种安装脚本会装进 $HOME、且每次构建拉到的版本都不一样，镜像就不可复现了。
#
# **校验和是承重的，不是讲究。** 上面 apt 那两层之所以敢说「可复现」，靠的是仓库签名；
# 这条路径没有等价物，只有 TLS。而 GitHub 的 release 资产对同一个 tag 是可以被替换的，
# 光写死版本号锁住的是资产的**名字**，锁不住内容 —— 发布方被入侵重传一次，
# 下一次 build 就把换掉的二进制装进这台持有全机登录态、还有免密 sudo 的容器。
# 值取自官方清单（bun 的 SHASUMS256.txt、uv 的 .sha256），升版本时一并更新。
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b
ARG UV_VERSION=0.12.4
ARG UV_SHA256=49d881b3403187e1f1789720881e77e4251ad4259d86c4844862657d2a35d13f
RUN set -eux; \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip" -o /tmp/bun.zip; \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp; \
    install -m 0755 /tmp/bun-linux-aarch64/bun /usr/local/bin/bun; \
    # uv 不能像以前那样 `curl | tar`：管道里校验不了，得先落盘再核对再解包。
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz" -o /tmp/uv.tgz; \
    echo "${UV_SHA256}  /tmp/uv.tgz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tgz -C /tmp; \
    install -m 0755 /tmp/uv-aarch64-unknown-linux-gnu/uv /usr/local/bin/uv; \
    install -m 0755 /tmp/uv-aarch64-unknown-linux-gnu/uvx /usr/local/bin/uvx; \
    rm -rf /tmp/bun.zip /tmp/uv.tgz /tmp/bun-linux-aarch64 /tmp/uv-aarch64-unknown-linux-gnu; \
    bun --version; uv --version

# Playwright：只装库，不下载它自带的浏览器。镜像里已经有一只 Chromium，
# 再拉一份是几百 MB 的重复。用法：chromium.launch({ executablePath: '/usr/bin/chromium' })
#
# 版本写死，理由和上面 bun/uv 那层一样：不写死的话每次 build 拉到的都可能不同，
# 「镜像可复现」这句就不成立了。**这个 playwright 不是 box-service 里那个
# playwright-core**（那个由 box-service/package-lock.json 锁着），两个包各管各的。
ARG PLAYWRIGHT_VERSION=1.56.1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" --silent

RUN useradd -m -s /bin/bash box

# 免密 sudo。观察值那台就有 sudo，试验场里 apt-get install 是刚需。
# **代价见规格 §9.4**：桌面上有终端，noVNC 又还没有真鉴权，于是
# 「本机任何进程能连上 6081」= 容器内 root。这一条是知情接受的，不是没想到。
RUN echo 'box ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/box && chmod 0440 /etc/sudoers.d/box

# 壁纸：一张纯色 PNG，颜色沿用原来 xsetroot 的 #2e3436。
# 做成文件而不是运行时 convert 一次，是因为 xwallpaper 只吃文件、不吃颜色参数。
RUN convert -size 1280x800 xc:'#2e3436' /usr/local/share/box-wallpaper.png

# 镜像里的 node 是 20.x，全局 WebSocket 还不稳定，会话同步走 ws 包
RUN npm install -g ws@8 --silent
ENV NODE_PATH=/usr/local/lib/node_modules

COPY box-image/bin/ /usr/local/bin/
RUN chmod +x /usr/local/bin/*

# 窗口服务：唯一权威（窗口表、token mint、状态机、页面驱动）。
# 必须跑在容器内 —— 调试口 9222+N 不出容器，Playwright 得和浏览器同侧。
COPY box-service/package.json box-service/package-lock.json /opt/box-service/
RUN cd /opt/box-service && npm ci --omit=dev --silent
COPY box-service/ /opt/box-service/

USER box
WORKDIR /home/box

# 主屏 Chromium profile 住在数据卷中，容器替换后仍保留已完成的登录。
# box-common.sh 的固定路径保持不变；挂载空卷时由 box-init 建立链接目标。
# workspace 仍由调用方绑定宿主机目录，这里只提供无挂载时的初始目录。
RUN mkdir -p /home/box/sand-data/chrome-profile/Default /home/box/workspace \
    && ln -s /home/box/sand-data/chrome-profile /home/box/chrome-profile

# 用户自己 `go install` / `cargo install` / `pip install --user` 装的东西落在家目录里，
# 得在 PATH 上。
#
# **ENV 一个人不够**：登录 shell 会 source /etc/profile，那里把 PATH 无条件重设成
# /usr/local/bin:/usr/bin:/bin:… ，三个家目录 bin 全丢（实测；`mac-bot shell` 走的
# 正是 bash -l）。所以 ENV 管非登录进程，profile.d 管登录 shell，两边都要有。
#
# as-built §2 那条「用户自己装的工具目录只加在非特权用户的 PATH 上，别加到 root 的」
# **我们只做到了一半，这里说清楚**：`ENV` 是镜像全局的，Dockerfile 里没有按用户设的写法，
# 于是 `docker exec -u root` 拿到的 PATH 同样以 /home/box/.local/bin 打头（实测）。
# profile.d 这半边能守住，就按 uid 守住 —— `sudo -i` 之后 root 不该解析到 box 可写的目录。
# 剩下的那半边是知情接受：box 本来就有免密 sudo（§4.5），能往 /home/box 放文件的人
# 早就等于 root，安全增量为零。登记在规格 §9.4，不留成「注释说了、代码没做」。
ENV PATH=/home/box/.local/bin:/home/box/go/bin:/home/box/.cargo/bin:$PATH \
    GOPATH=/home/box/go

# 不设 LANG 的话整个容器跑在 C locale 上，而**屏名鼓励取中文、屏名又直接变成目录名**
# （§4.6：`/home/box/workspace/<屏名>`）。C locale 下 GNU coreutils 会把非 ASCII 文件名
# 按八进制转义印出来 —— `ls` 里那格工作区显示成 `\350\256\276...`，`tree` 交给 agent 读的
# 目录结构同理，桌面上那只 xfce4-terminal 也一样。这是「中文名是常态」那条决定的配套。
# trixie 的 glibc 自带 C.UTF-8，不必装 locales 包。
ENV LANG=C.UTF-8
USER root
RUN printf '%s\n' \
    '# mac-bot：把家目录里的 bin 追回 PATH（/etc/profile 会把它重设掉）。' \
    '# 只给非 root：root 的命令解析里不该出现 box 可写的目录（as-built §2）。' \
    'if [ "$(id -u)" != "0" ]; then' \
    '  case ":$PATH:" in' \
    '    *":/home/box/go/bin:"*) ;;' \
    '    *) PATH="/home/box/.local/bin:/home/box/go/bin:/home/box/.cargo/bin:$PATH" ;;' \
    '  esac' \
    '  export PATH' \
    '  export GOPATH=/home/box/go' \
    'fi' \
    > /etc/profile.d/10-box-path.sh
USER box

# 入口只把主屏拉起来，不开浏览器（门禁 G1）
CMD ["/usr/local/bin/box-init"]

ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/2217173240/grok-bot-box-image" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
