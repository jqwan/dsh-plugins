# 个人 DSH 插件仓库

[English](README.md)

这个公共仓库维护个人 DSH 插件源码，家里和公司电脑都可以从同一个 GitHub 仓库克隆、构建并安装。

当前包含：

- `@deepseek-ai/dsh-authorization-web`：Host 端授权桥接插件。
- `@deepseek-ai/dsh-client-ui-authorization`：Models 页面 Provider 登录按钮和授权对话框。

## 前置条件

- 已安装 DSH，并且 Web profile 可以正常启动。
- Node.js 22.19 或更高版本。
- pnpm 11。
- Git。

公司和家里的 DSH 应使用兼容的同一版本系列。插件依赖 DSH 提供的 Cordis、credentials、authorization、Typert 和 Web Client 服务。

## 从源码安装

在目标电脑执行：

```sh
git clone https://github.com/jqwan/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

最后启动 Web profile：

```sh
dsh --profile web
```

进入 Models 页面后，支持授权流程的 Provider 卡片会显示登录入口。

如果使用其他 profile 名称，替换命令中的 `web`：

```sh
pnpm run install:profile -- --profile company-web
```

该 profile 必须具备 Web 能力；headless profile 无法显示 Client UI。

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

新增插件放在 `packages/<group>/<name>/`，并提供自己的 `package.json`、源码入口和 `cordis.patch.yml`（如果插件通过 DSH bundle 安装）。同时在 `scripts/build.mjs` 中加入该插件的构建入口。

修改浏览器代码后必须重新执行 `pnpm run build`。如果修改 Host Remote 方法，还必须刷新 `packages/credentials/authorization-web/generated/` 中的 Typert 生成物：先构建匹配版本的 DSH checkout，再执行 `node scripts/update-generated.mjs /path/to/deepseek-harness`。这些文件是浏览器使用的 wire contract。

## 本地检查

```sh
pnpm run check
```

该命令会生成类型声明、构建 Host 入口、准备 Typert 文件并生成 DSH Web 所需的 `lib/client.js` 浏览器闭包。

## 版本固定

为了让两台电脑使用完全相同的源码，可以在克隆后固定到 Git tag 或 commit：

```sh
git checkout v0.1.0
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

这个仓库是公共仓库，不要提交 API key、Cookie、公司凭据或其他敏感信息。
