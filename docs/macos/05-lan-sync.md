# Windows / Mac / Android 局域网同步协议 V1

> 同步是 V1 必做范围，但本工程目前**只有 Bonjour 浏览服务与 schema 草案**，尚未实现任何真实同步。必须由开发 AI 在三个客户端分别完成、互通测试。

## 1. 用户体验

- 每个设备生成随机设备 ID、公私钥对并稳定保存在系统安全存储。
- 设置 > 数据 > 局域网同步：开关、显示本机设备名、已配对设备列表和最后同步时间。
- 在同一 Wi-Fi 下自动发现同协议设备，但**首次配对必须双向确认**：显示短码/二维码、设备名、公钥指纹。配对成功后自动增量同步。
- 不在同一个网络时离线编辑，重连后同步；用户可一键暂停、移除设备；显示数据冲突/剩余附件进度。

## 2. 网络层

- DNS-SD / mDNS 服务类型 `_deepseekchat._tcp`，TXT 提供协议主版本、产品代号、非敏感设备信息，不公布用户 ID、聊天标题、API Key。
- `NWListener/NWBrowser/NWConnection` (Mac)，Windows 使用等价 mDNS + TLS / Android 使用 NsdManager 或 DNS-SD。
- 配对时使用临时 ECDH 建立共享密钥及经认证的 SAS 短码；两端独立点确认，签发长期设备身份。后续 TLS 1.3 双向认证或经认可的 Noise 安全通道，公钥 pinning。纯 HTTP/明文 WebSocket 禁用。
- 每次连接随机 session nonce、防重放计数与过期时间；协议协商版本、最大负载大小与 capabilities。
- Wi-Fi 隔离/VPN/子网不同可能导致发现失败；必须提供手动地址+确认设备指纹的配对兜底。

## 3. 内容实体

建议所有客户端共享以下稳定字段：

```text
sessions(session_id UUID, title, created_at, updated_at, deleted_at?, version, current_message_id)
messages(message_id UUID, session_id, parent_message_id?, role, content_json, status, created_at, updated_at)
attachments(sha256, size, mime, filename, local_path, downloaded)
message_attachments(message_id, sha256, metadata_json)
drafts(session_id, device_id, body, updated_at)
operations(op_id UUID, device_id, logical_clock, entity_type, entity_id, action, payload_json, created_at)
tombstones(entity_type, entity_id, removed_at, retention_until)
sync_cursors(peer_device_id, latest_seen_op, last_full_reconcile_at)
paired_devices(device_id, display_name, public_key_fingerprint, paired_at, revoked_at?)
```

不要仅依据时间戳合并真实消息内容。推荐消息节点 append-only，编辑原提问/重新回答表现为新的消息树节点或显式修订操作；字段标题可采用 `logical_clock + device_id` 顺序的 LWW，避免时间偏差；删除保持 tombstone 直到配对设备都确认接收/到达明确保留期限。

## 4. 增量协议

Wire envelope 见 `contracts/sync-v1.schema.json`：

```json
{
  "protocol": "deepseek-lan-sync",
  "version": 1,
  "deviceId": "example-device-id-uuid",
  "requestId": "example-request-id",
  "type": "manifest",
  "payload": { "cursor": 0, "schema": 1, "features": ["sessions", "blobs"] }
}
```

步骤：hello/capabilities -> 验证已配对 identity -> 互换 manifest+cursor -> 分页同步 operations -> ack -> 校验缺失的 sha256 blobs -> 分块下载/恢复 -> 完成双向 manifest 对账。

- `operations` 唯一键 `op_id` 实现重传幂等。
- 同步双方持续按 SHA-256 校验附件；断线可以按 chunk index 继续，写入后原子提交。
- 每个操作带 schema 版本；高版本设备遇低版本能力不足必须保留本地数据并提示不可同步，不能静默丢字段。
- 会话删除传播 tombstone；导入其他设备的旧 ZIP 不自动复活 tombstone。
- 同步不包括 API Key、Keychain 密钥、设置中任何本地隐私字段；允许同步独立可选择的聊天外观偏好，但默认不跨设备复制全局设置。

## 5. 冲突策略

- 不同会话/不同消息节点：合并。
- 同一消息 ID 内容不一致：对比 hash，禁止静默覆盖；产生冲突副本并提示。
- 同一会话标题并发改名：逻辑时钟大者胜，平局按 deviceId，写入冲突审计。
- 当前显示的消息分支：建议作为**设备本地**视图状态，不互相抢焦点。
- 草稿：按设备本地保留；显式同步草稿时冲突另存副本。
- 删除与新增冲突：保留 tombstone 优先，若新消息属于已删除会话，提示恢复/归档而非自动复活。

## 6. 三端验收

M↔W, M↔A, W↔A 三对都要测试：初始配对/重复配对/撤销/离线 24h 修改/同一会话并发分支/删除/重命名/大附件/故障重试/跨版本与恶意设备拒绝。

**注意**：仅 Mac 端的 Bonjour 扫描无法让 Windows/Android 自动支持该协议，需同时修改对应客户端。
