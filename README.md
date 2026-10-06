# Personal DSH plugins

[中文说明](README.zh.md)

This repository contains personal DSH plugins that can be maintained in one place and installed from source on both a home computer and a work computer.

The repository currently provides:

- `@deepseek-ai/dsh-pi-agent`: runs [pi](https://github.com/earendil-works/pi-coding-agent) as the dsh agent kernel. The plugin resolves the machine's global pi install, spawns it in RPC mode, and translates its event stream into native dsh session events — UI, tools presentation, history, and change visualization stay native. An optional tool bridge (on by default; `DSH_PI_TOOL_BRIDGE=0` opts out) exposes dsh's kernel tools (subagent, goal, bash, …) to pi through pi's built-in MCP client. Design and history: `docs/pi-agent-plugin-plan.md`.

## Requirements

- A compatible DSH installation with a working Web profile.
- Node.js 22.19 or newer.
- pnpm 11.
- Git.
- A global pi install: `npm i -g @earendil-works/pi-coding-agent` (the plugin follows whatever the running node's global prefix holds; set the plugin's `piCliEntry` config to override).

## Install from source

Clone the public repository on the computer where DSH is installed:

```sh
git clone https://github.com/jqwan/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

Stop any running `dsh web` instance first — reinstalling plugins while the live patch reload watches the profile can crash it.

`pnpm run install:profile` installs the freshly built package into the selected profile (absolute paths, so any `DSH_BIN` wrapper works). It does not modify the DSH installation or the shipped Web profile bundle.

Start the profile after installation:

```sh
dsh --profile web
```

Use another profile name by replacing `web`:

```sh
pnpm run install:profile -- --profile company-web
```

## Update on another computer

Run this from the cloned repository:

```sh
git pull --ff-only
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

Restart the DSH process after updating a profile. The profile keeps the package links under its own DSH home directory, so each computer can update independently from the same GitHub repository.

## Add or change plugins

Put each new plugin under `packages/<group>/<name>/`. Give it a `package.json`, a `cordis.patch.yml` when it is installed as a DSH bundle, a source entry, and a package-local build entry in `scripts/build.mjs`. Keep runtime service identities as peer dependencies of the DSH version that provides them; do not bundle a second copy of Cordis or DSH services.

Changes require `pnpm run build` before `install:profile`.

## Local checks

```sh
pnpm run build
pnpm run check
```

`scripts/smoke-pi-chat.mjs` exercises a real pi RPC session (add `--model` for one benign model turn; `PI_SMOKE_PROVIDER` / `PI_SMOKE_MODEL` / `PI_SMOKE_CLI` select the route or binary).

## Repository releases

Source installation does not require npm. To distribute a known revision, push a commit and create a Git tag, then install that revision after cloning:

```sh
git checkout v0.1.0
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

Pinning a tag or commit makes home and work installations reproducible. Public GitHub access exposes the source and build scripts; never put credentials in this repository.
