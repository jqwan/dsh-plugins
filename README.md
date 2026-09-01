# Personal DSH plugins

[中文说明](README.zh.md)

This repository contains personal DSH plugins that can be maintained in one place and installed from source on both a home computer and a work computer.

The repository currently provides:

- `@deepseek-ai/dsh-authorization-web`: the Host authorization bridge.
- `@deepseek-ai/dsh-client-ui-authorization`: the Web Models-page sign-in UI.

The packages are kept in one source repository, but each package retains its own DSH bundle manifest. The installer builds both packages and adds them to a selected DSH profile in Host-then-Client order.

## Requirements

- A compatible DSH installation with a working Web profile.
- Node.js 22.19 or newer.
- pnpm 11.
- Git.

The DSH installation must provide the authorization, credentials, Typert, Web, and Client UI services expected by these packages. Use the same DSH release line on both computers.

## Install from source

Clone the public repository on the computer where DSH is installed:

```sh
git clone https://github.com/jqwan/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

`pnpm run install:profile` removes the two previous local entries from the selected profile and installs the freshly built packages. It does not modify the DSH installation or the shipped Web profile bundle.

Start the profile after installation:

```sh
dsh --profile web
```

Open the Models page. Provider cards with an authorization flow show the sign-in action supplied by these plugins.

Use another profile name by replacing `web`:

```sh
pnpm run install:profile -- --profile company-web
```

The profile must already be a Web-capable profile. A headless profile cannot render the Client UI package.

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

Changes to browser code require `pnpm run build` before `install:profile`. Changes to Host Remote methods also require refreshed Typert artifacts under `packages/credentials/authorization-web/generated/`; those files are the wire contract consumed by the browser.

## Local checks

```sh
pnpm run build
pnpm run check
```

The build runs TypeScript declaration generation, Host bundling, Typert artifact installation, and the DSH browser closure build. The browser artifact is emitted as `lib/client.js` with the `window.__ModuleLoader__.load(...)` wrapper required by the DSH Web loader.

## Repository releases

Source installation does not require npm. To distribute a known revision, push a commit and create a Git tag, then install that revision after cloning:

```sh
git checkout v0.1.0
pnpm install
pnpm run build
pnpm run install:profile -- --profile web
```

Pinning a tag or commit makes home and work installations reproducible. Public GitHub access exposes the source and build scripts; never put credentials in this repository.
