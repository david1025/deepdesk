# AI 开发代理须遵循的规则

1. **目标是 V1 一次性实现 docs/macos/02-feature-scope.md 内全部 P0 验收项**。可按任务分批实现，但不能把未完成的功能写成已交付，也不能假定后续版本补全。
2. 核心前端以用户已有 Windows 自定义 `chat-demo` 为准，不允许用官方原版覆盖其定制业务；如无源代码就标记等待移入，而不是臆造已有功能。
3. 迁移中所有真实聊天数据、消息树、附件、导入导出必须有一致性测试；禁止通过清库方式解决升级问题。
4. API Key **仅 Keychain 持久化**，Native HTTP 客户端从 Keychain 读取，前端不得长期存储明文 Key。禁止在日志、异常报告、导出 ZIP、同步协议中写入密钥。
5. WKWebView 只加载可信的内置 UI，外部 HTTPS 链接走默认浏览器；Bridge 必须校验主 frame、来源、请求参数与固定命令白名单。不得提供执行 Shell/任意路径读写能力。
6. 优先通过 adapter 封装存储和 API，不要在 React 组件中散落 `window.webkit` 调用。保持 Windows 与 Mac 共用同一份聊天 UI。
7. 变更 API/存储/同步协议时更新 `contracts/`、相应 `docs/macos/` 与测试；任何 wire 格式变更都要增加版本号、说明升级路径。
8. 不得使用未经验证的跨设备配对方案；必须有双向确认、认证、加密、防重放，明确删除冲突策略。
9. 完成一项任务需汇报：修改文件、构建结果、测试证据、未通过项、剩余风险。只在真实 Mac/Xcode 运行过时报告“Mac 已通过编译”。
10. 保持 DeepSeek 上游 MIT LICENSE；禁止擅自提交 Apple 开发者证书、Sparkle 私钥、Token 或 API Key。

任务清单与验收详见 docs/macos/07-ai-work-orders.md 与 docs/macos/06-v1-acceptance.md。
