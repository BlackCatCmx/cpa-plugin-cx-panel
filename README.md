# CPA CX Panel

CPA CX Panel 是 CLIProxyAPI 的原生 Codex 额度面板插件，直接集成到 CPA 原生管理前端。

插件按账号展示：

- Codex 主额度、Code Review 额度和动态附加额度窗口；
- 套餐到期时间、相对时间和主动重置次数；
- CPA 记录的账号状态及错误信息；
- 单账号主动刷新得到的最新额度。

账号列表支持分页。页面定期读取 CPA 已有的额度快照，只有用户点击账号刷新按钮时才会查询一次上游额度。插件不负责凭证启停、编辑、删除或 OAuth 刷新。

## 安装要求

- 支持原生插件 ABI v1 和插件商店的 CLIProxyAPI 版本；
- CPA 原生管理前端与插件页面同源；
- 当前发布包支持 Linux amd64；
- CPA 的配置文件和插件目录可写并已持久化。

## 从 CPA 插件商店安装

在 CPA 的 `config.yaml` 中启用插件，并追加本项目的商店源：

```yaml
plugins:
  enabled: true
  store-sources:
    - https://raw.githubusercontent.com/BlackCatCmx/cpa-plugin-cx-panel/main/registry.json
```

如果已有 `plugins` 配置，请合并字段，不要重复创建配置块。`store-sources` 只会追加本项目商店，不会替换 CPA 官方商店。

保存配置并重启 CPA，然后：

1. 打开 CPA 原生管理前端的插件商店；
2. 刷新商店列表并找到 **CPA CX Panel**；
3. 点击安装；
4. 从管理菜单打开 **Codex 额度**。

安装程序会根据 CPA 的运行平台下载、校验并启用插件。升级和卸载同样通过 CPA 原生插件管理页面完成。

使用插件页面前，请在 CPA 管理登录页选择记住管理密钥。
