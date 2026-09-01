# CPA CX Panel

CLIProxyAPI 原生 Codex 额度面板。页面读取 CPA 已有的被动额度快照，并允许按账号手动查询一次当前额度。

## 功能边界

- 页面加载及每 10 秒自动更新只读取 `GET /v0/management/auth-files`，不会请求 ChatGPT。
- 只有点击账号右上角的刷新图标，才会由 CPA 代发一次 `GET /backend-api/wham/usage`。
- 展示主额度、Code Review 和动态附加额度窗口，以及 CPA 返回的账号错误状态。
- 不提供凭证启停、编辑、下载、删除、模型查询或 OAuth 凭证刷新。
- 主动刷新结果只保存在当前页面；UA 设置保存在 CPA 配置的插件专属命名空间。

## 要求

- 支持原生插件 ABI v1、插件资源页面、`auth-files`、`api-call` 和插件配置接口的 CLIProxyAPI 版本。
- Go 1.26、CGO 和目标平台 C 编译器仅用于构建。
- Node.js 仅用于运行浏览器逻辑测试，CPA 运行时不需要 Node.js。
- 插件页与原生管理前端同源，并且登录时选择记住管理密钥。

## 测试与构建

```bash
go test ./...
node --test web-test/*.test.mjs
mkdir -p build
go build -buildvcs=false -buildmode=c-shared -o build/cpa-plugin-cx-panel.dll .
```

Linux 构建时把输出名改为 `build/cpa-plugin-cx-panel.so`。安装了 `make` 的环境也可使用 `make test` 和 `make build`。

构建产物位于 `build/`：Windows amd64 为 `cpa-plugin-cx-panel.dll`，Linux 为 `cpa-plugin-cx-panel.so`。Go 同时生成的 `.h` 文件不需要部署。

动态库必须在对应操作系统和 CPU 架构上构建。Windows DLL 只用于本地测试；Zeabur 和 Docker 中的 Linux CPA 必须使用匹配架构、匹配 libc 环境的 Linux `.so`。当前仓库暂未加入 GitHub Actions 发布工作流。

## CPA 配置

```yaml
plugins:
  enabled: true
  dir: /data/plugins
  store-sources:
    - https://raw.githubusercontent.com/BlackCatCmx/cpa-plugin-cx-panel/main/registry.json
  configs:
    cpa-plugin-cx-panel:
      enabled: true
      refresh_user_agent: ""
```

`refresh_user_agent` 为空时，先继承 CPA 的 `codex-header-defaults.user-agent`，再回退到插件内置的 CPA Codex 默认 UA。页面通过 CPA 插件配置接口保存该字段，因此会随现有 `config.yaml` 持久化，不创建插件私有配置文件。

## 手工安装

将匹配平台的动态库放入 CPA 插件目录：

```text
/data/plugins/linux/amd64/cpa-plugin-cx-panel.so
/data/plugins/linux/arm64/cpa-plugin-cx-panel.so
plugins/windows/amd64/cpa-plugin-cx-panel.dll
```

启用上述配置并重启 CPA，随后在原生管理前端打开“Codex 额度”。Zeabur 可直接复用现有 `/data` 持久卷，在其中增加 `/data/plugins`；VPS Docker 应把宿主机插件目录挂载到配置中 `plugins.dir` 指向的容器路径。

仓库公开并产生符合 CPA 命名约定的 GitHub Release 后，可使用根目录的自用 `registry.json` 从插件商店安装。该注册表不是官方商店收录项，只有显式加入 `store-sources` 的 CPA 实例才能看到。

## 已知限制

- CPA 重启后，被动额度内存快照需要等待下一次真实业务请求重新填充。
- 主动刷新不会写回 CPA 的被动快照，重新加载页面后恢复显示 CPA 当前快照。
- 原生前端目前没有向插件 iframe 传递临时内存会话；没有记住管理密钥时插件页无法读取受保护接口。
- CPA 更改插件 ABI、管理会话存储格式或额度接口字段后，插件需要同步适配。
