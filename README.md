# 非遗跨境展演知识边界与授权包服务

本项目用于整理非遗跨境展演知识边界领域中的事件名称、交换字段与脱敏样例，并在其上实现**授权包服务**：每个知识单元分别记录权利人、公开层级、地域、用途和有效期；译文钉住确定原文版本；发包只包含接收机构当前获准的最小集合。资料只包含领域约定，不包含真实个人信息、生产连接或外部账号。

## 目录

- `src/heritage_exchange_boundary.js`：事件种类、载荷字段、枚举（公开层级、权利人立场、单元状态）与最小字段校验。
- `src/authorization_package_service.js`：事件溯源的授权包服务（零外部依赖）。
- `data/sample.json`：用于核对资料格式的虚构事件。
- `tests/`：保证样例、领域约定与服务规则保持一致。

## 授权包服务的规则

所有状态均由不可变事件流折出（event sourcing），历史展演事实永不删除。

- **单元登记**（`KNOWLEDGE_REGISTERED`）：权利人、公开层级（`PUBLIC` < `RESTRICTED` < `INTERNAL`）、地域、用途、有效期逐单元记录；权利人全部同意才 `ACTIVE`。
- **译文钉版**（`TRANSLATION_REVIEWED`）：译文必须引用确定存在的原文版本，发包时随包携带引用当前版本的最新审订译文。
- **最小集合发包**（`PACKAGE_ISSUED`）：只纳入机构当前获准的单元（状态、层级、地域、用途、有效期逐项核对），不获准的单元进入 `exclusions` 并给出原因；首次发包交付一次能力（`GRANT_DELIVERED`），之后不再重复签发。
- **同包异内容冲突**：同一稳定 `package_code` 重放时若定格条目发生版本/译审变化，抛 `PACKAGE_CONTENT_CONFLICT`；包标识跨机构使用抛 `PACKAGE_CODE_CONFLICT`；事后撤回或退出不改变历史定格内容。
- **分歧冻结**（`HOLDER_DECISION` / `HOLDER_DISAGREEMENT`）：多个权利人立场不一致时只冻结相关单元，其他内容不受影响。
- **紧急停用**（`EMERGENCY_STOP`）：单元立即停用，并向实际持有该单元的活跃机构签发带版本号（v1、v2…）的撤回通知（`WITHDRAWAL_NOTICE_ISSUED`）；历史包和使用回执继续留痕。
- **离线归并**：下载（`DOWNLOAD_RECORDED`）、使用回执（`USE_ACKNOWLEDGED`）、撤回确认（`WITHDRAWAL_ACK`）、转授权申请（`SUBGRANT_REQUESTED`）按稳定标识（`dedup_key`/`withdrawal_id`/`request_id`）幂等归并，重复到达只累计 `repeats`。
- **转授权**：批准前重新核对申请机构在目标地域/用途上的当前资格；冻结、撤回、过期、机构退出一律不得批准；决定不可翻转。
- **机构退出**（`RECIPIENT_EXITED`）：立即停止新发包与新下载，就手上单元补发撤回通知；旧包同码重放与已发生下载的离线重复回执仍归并留痕。
- **系统恢复**：用事件流重建后，`pendingWithdrawalRedelivery()` 只列出未确认撤回，`capabilities_reissued` 恒为 0。
- **一次使用反查**：`traceUse(dedup_key)` 从实际使用回执反查使用时定格的原文版本、译审钉版、各权利人决定、紧急停用、撤回通知与接收回执、能力交付事件。

## 本地核对

```bash
npm test
```

## 本地运行

测试命令：

```bash
npm test
```

编译或构建命令：

```bash
npm run build
```

所有测试和构建均在单个 Linux 应用容器内完成，不需要另行启动数据库或外部服务。
