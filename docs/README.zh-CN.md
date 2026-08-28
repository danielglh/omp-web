# omp-web

[![CI](https://github.com/danielglh/omp-web/actions/workflows/ci.yml/badge.svg)](https://github.com/danielglh/omp-web/actions/workflows/ci.yml)

[English](../README.md) | 简体中文

在浏览器里使用 [omp](https://omp.sh/)——一个跑在终端里的编码 agent：开 session、发 prompt、看流式输出、批工具调用、改 omp 配置。电脑和手机都好用。

## 为什么做这个

纯个人需求。我的 omp agent 跑在远程开发服务器上，但我不总坐在终端前——用手机 SSH + tmux 的体验谁用谁知道。我想在工位上发起任务，在沙发上瞄一眼进度，在路上用手机批一个工具调用。

所以这就是个遥控器：omp 原封不动跑在服务器上（agent 和工具都在服务器侧执行，浏览器里什么都不跑），网页负责驱动它。整个项目就是一个 Bun 进程，前面挂个 TLS 就能放心暴露，token 认证是内置的。

## 它能做什么

**会话。** 左边的列表按工作目录给 session 分组，每个目录有自己的 `+`。session 可以从 omp 自己的历史里恢复，服务器重启后还在，每个 session 单独设审批级别（`always-ask` / `write` / `yolo`）。

**真正的聊天界面。** 流式输出，thinking 块可折叠，工具调用是卡片（参数、实时输出、耗时）。输入框支持 `/` 命令补全、`@` 引用文件、贴图，还有模型 / thinking 档位切换。agent 在跑的时候可以排队追加消息，也可以随时打断。

![会话与聊天](screenshots/chat.png)

agent 要动东西时，审批直接以对话框的形式出现在聊天里——手机上也一样：

![工具审批](screenshots/approval.png)

**聊天之外的信息。** 侧栏有子 agent 实时状态、上下文用量、token/费用统计，会话可以导出 HTML。还能浏览 session 的工作目录、预览文件——markdown、图片、HTML——agent 的产物不用下载就能看。

![文件浏览与预览](screenshots/files.png)

**手机是一等公民。** 窄屏下列表和侧栏自动变成抽屉：

| |
| --- |
| ![手机端聊天](screenshots/mobile-chat.png) ![手机端会话列表](screenshots/mobile-home.png) |

## omp assistant：动动嘴配置 omp

我最在意的一个设计。

omp 有几百个配置项——模型角色、provider、审批、compaction、各种工具开关。常规做法是为它们做一层设置界面：一个键一个表单，而且界面永远比 omp 本体慢一拍。我不想维护这个东西，也不想用。

所以 omp-web 基本没有配置界面，它有个 agent。侧栏底部常驻一个 **omp assistant**：一个跑在独立 workspace 里的 omp 会话，预先种好了一份描述 omp 配置体系的上下文文件。你直接说：

- 「默认模型换成 claude-opus-4-5」
- 「commit 消息用个便宜点的模型」
- 「把那两个 provider 关掉」

它执行的是真的 `omp config` 命令行——和你在终端里手敲完全一样，校验、语义都一致——改完会回报结果。一个细节：assistant 自己跑在 `default` 模型角色上，改了默认模型之后按一下 ↺ 重启它才生效。

它还能管 omp-web 自己：列出、创建（可指定审批级别和模型）、启动、停止、改名、删除会话，全在对话里完成。「在这个仓库开个 yolo 会话搞 X」是一句话的事，不是填表。

![omp assistant](screenshots/assistant.png)

传统的设置页也还在——modelRoles 编辑器加上全部配置键的可搜索目录——偶尔想精确看或改某个键的时候用：

![设置](screenshots/settings.png)

## 安装使用

需要 [Bun](https://bun.sh) ≥ 1.3.14，服务器上有 [omp](https://omp.sh/install) 并配好 provider 的 API key。

```sh
git clone https://github.com/danielglh/omp-web.git
cd omp-web
bun install
bun run build
bun run start        # 监听 :7367
```

打开 `http://<server>:7367`。

暴露到网络之前先配 token，推荐放数据目录：

```sh
mkdir -p ~/.omp-web
echo '{ "authToken": "换成足够长的随机串" }' > ~/.omp-web/config.json
chmod 600 ~/.omp-web/config.json
```

`OMP_WEB_TOKEN` 环境变量也行，优先级更高。不配 token 就没有认证，只适合 localhost 自己玩。登录时 token 换成 HttpOnly cookie（30 天），logout 或换 token 会让所有已登录会话失效；在 HTTPS 反代后面 cookie 会自动加上 `Secure`。

丑话说在前面：跑着的 agent 是能在服务器上执行工具的。把这个 UI 当远程 shell 对待，token 别外传。

前面有 nginx/Caddy 的话，把 `/api` 和 `/ws`（含 WebSocket upgrade）转给服务就行。其余配置都有默认值：

| 变量                | 默认值       | 说明                              |
| ------------------- | ------------ | --------------------------------- |
| `OMP_WEB_TOKEN`     | —            | 访问 token（覆盖 config.json）    |
| `OMP_WEB_PORT`      | `7367`       | HTTP/WS 端口                      |
| `OMP_WEB_HOST`      | `0.0.0.0`    | 监听地址                          |
| `OMP_WEB_DATA_DIR`  | `~/.omp-web` | 状态目录（会话表、认证、assistant） |
| `OMP_WEB_OMP_BIN`   | `omp`        | omp 可执行文件路径                |
| `OMP_WEB_CWD`       | `$HOME`      | 新会话默认工作目录                |
| `OMP_WEB_MOCK`      | —            | `1` 时用脚本假 agent 代替 omp     |

## 本地开发

```sh
bun install
bun run dev          # Bun server (:7367) + vite (:5173)，带 HMR
```

开发 UI 不需要装 omp：`OMP_WEB_MOCK=1 bun run dev:server` 会用一个脚本假 agent 代替（流式假回复、弹审批、跑子 agent），测试套件用的也是它。

```sh
bun run check        # biome（lint + format）+ typecheck
bun run test         # server E2E + web 单测，不需要 omp
```

仓库三个包：`server/`（Bun——认证、会话管理、omp 子进程桥）、`web/`（React 19 + Vite + Tailwind v4）、`shared/`（前后端共享类型）。原理一句话：服务器给每个会话 spawn 一个 `omp --mode rpc` 子进程，把 stdin/stdout 上的 JSON 协议桥接成 WebSocket，客户端零安装，一切都跑在服务器上。

## License

[MIT](../LICENSE)
