# CPA CX Panel

CPA CX Panel 是 CLIProxyAPI 的原生 Codex / Claude 额度面板插件，直接集成到 CPA 原生管理前端。

插件按账号展示：

- Codex 主额度、Code Review 额度和动态附加额度窗口；
- Claude 5 小时、7 天、模型专属、云端会话额度及已启用的额外用量窗口；
- Codex 套餐到期时间、相对时间和主动重置次数；
- CPA 记录的账号状态及错误信息；
- 单账号主动刷新得到的最新额度。

账号列表支持分页和凭证启停。页面每 30 秒读取 CPA 已有的被动额度快照，只有用户点击账号刷新按钮时才查询上游额度。Codex 和 Claude 的有效被动额度及主动刷新结果均保存在浏览器本地；较新的有效被动快照更新缓存，仅含状态、重试信息或 CPA 重启后暂缺快照时保留上次有效额度及其采集时间。Claude 按窗口更新，本次未返回或用量无效的窗口保留已有有效数据并标注“缓存”，悬停可查看其原始采集时间。通用周额度、Fable 专属周额度与云端会话额度分别显示。网络或响应格式异常会明确报错并保留已显示的数据。插件不负责凭证编辑、删除或 OAuth 刷新。

刷新请求设置支持分别保存 Codex 和 Claude 的 User-Agent。Codex 留空时继承 CPA 设置，再使用内置默认值；Claude 留空时使用内置默认值 `claude-cli/2.1.280 (external, cli)`。设置只影响插件额度刷新。

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
4. 从管理菜单打开 **Codex / Claude 额度**。

安装程序会根据 CPA 的运行平台下载、校验并启用插件。升级和卸载同样通过 CPA 原生插件管理页面完成。

使用插件页面前，请在 CPA 管理登录页选择记住管理密钥。
