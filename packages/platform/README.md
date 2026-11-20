# 平台类型层（开发脚手架）

- `MacPlatformAdapter` 目前只封装已实现的基础 Bridge 命令。
- 实现原生 `network.request/stream`、`StorageAdapter` 和同步后扩展接口；**不能直接用它替代现有可运行的 api/client.ts**，否则会丢掉业务 API。
- Windows Adapter 必须按用户现有 Windows 原生端 API 适配，不能凭空猜已有 WebView2/Electron 的实现。
- 当前包有 TS 类型，没有与 `apps/web` 做成 pnpm workspace；集成 T01/T03 时由接手 AI 统一仓库构建。
