# 个人 DSH 插件仓库

[English](README.md)

这个公共仓库维护个人 DSH 插件源码，家里和公司电脑都可以从同一个 GitHub 仓库克隆、构建并安装。

当前包含：

- `@deepseek-ai/dsh-pi-agent`：以 [pi](https://github.com/earendil-works/pi-coding-agent) 作为 dsh 的 agent 内核。插件解析本机的全局 pi 安装，以 RPC 模式 spawn 子进程，并把 pi 的事件流翻译成原生 dsh 会话事件——UI、工具呈现、历史与变更可视化全部保持 dsh 原生。可选工具桥（默认开启，`DSH_PI_TOOL_BRIDGE=0` 关闭）经 pi 内置 MCP 客户端把 dsh 内核工具（subagent、goal、bash 等）暴露给 pi。设计与演进记录见 `docs/pi-agent-plugin-plan.md`。

## 前置条件

- 已安装 DSH，并且 Web profile 可以正常启动。
- Node.js 22.19 或更高版本。
- pnpm 11。
- Git。
- 全局安装 pi：`npm i -g @earendil-works/pi-coding-agent`（插件跟随当前 node 的全局前缀；可用插件配置 `piCliEntry` 覆盖）。

## 从源码安装

在目标电脑执行：

```sh
git clone https://github.com/jqwan/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

安装前先停掉运行中的 `dsh web`——live patch reload 观察期间重装插件可能导致其崩溃。

`pnpm run install:profile` 把构建好的插件装入指定 profile（绝对路径，任何 `DSH_BIN` 包装方式都可用），不会改动 DSH 安装本身或官方 Web profile bundle。

最后启动 Web profile：

```sh
dsh --profile web
```

如果使用其他 profile 名称，替换命令中的 `web`：

```sh
pnpm run install:profile -- --profile company-web
```

## 更新插件

在已克隆的仓库中执行：

```sh
git pull --ff-only
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

更新后重启 DSH 进程。家里和公司可以独立执行更新，profile 中的插件链接由各自的 DSH_HOME 管理。

## 扩展其他插件

新增插件放在 `packages/<group>/<name>/`，并提供自己的 `package.json`、源码入口和 `cordis.patch.yml`（如果插件通过 DSH bundle 安装）。同时在 `scripts/build.mjs` 中加入该插件的构建入口。运行时服务标识一律用 peerDependencies 锁定到提供它们的 DSH 版本，不要把 Cordis 或 DSH 服务再打一份进包里。

改动后需要 `pnpm run build` 再 `install:profile`。

## 本地检查

```sh
pnpm run build
pnpm run check
```

`scripts/smoke-pi-chat.mjs` 对真实 pi RPC 会话做冒烟（加 `--model` 跑一轮良性模型调用；`PI_SMOKE_PROVIDER` / `PI_SMOKE_MODEL` / `PI_SMOKE_CLI` 选择路由或二进制）。

## 版本固定

为了让两台电脑使用完全相同的源码，可以在克隆后固定到 Git tag 或 commit：

```sh
git checkout v0.1.0
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

这个仓库是公共仓库，不要提交 API key、Cookie、公司凭据或其他敏感信息。
