// heritage_exchange_boundary 领域资料的基础结构。
//
// 授权包服务建立在四类既有事件之上：
//   KNOWLEDGE_REGISTERED   知识单元登记（权利人、公开层级、地域、用途、有效期）
//   TRANSLATION_REVIEWED   译文审订（必须引用确定的原文版本）
//   PACKAGE_ISSUED         发包（只包含接收机构当前获准的最小集合）
//   USE_ACKNOWLEDGED       使用回执（合作方离线回执，按稳定标识归并）
// 并补充授权包服务所需的决定、交付、撤回、退出等事件。

export const EVENT_KINDS = Object.freeze([
  "KNOWLEDGE_REGISTERED", // 知识单元登记
  "KNOWLEDGE_REVISED", // 知识单元出新版
  "HOLDER_DECISION", // 权利人对单元的授权决定（授权/拒绝/停用）
  "HOLDER_DISAGREEMENT", // 多权利人意见不一致，单元冻结
  "EMERGENCY_STOP", // 协调员紧急停用单元（触发新版撤回通知）
  "TRANSLATION_REVIEWED", // 译文审订通过，钉住确定原文版本
  "RECIPIENT_REGISTERED", // 接收机构登记
  "RECIPIENT_EXITED", // 机构退出，立即停止新取用
  "PACKAGE_ISSUED", // 授权包签发（稳定 package_code，同包异内容必须冲突）
  "GRANT_DELIVERED", // 授权能力交付（机构、授权范围、版本清单）
  "WITHDRAWAL_NOTICE_ISSUED", // 撤回通知（紧急停用产生新版）
  "WITHDRAWAL_ACK", // 撤回确认（离线回执按稳定标识归并）
  "DOWNLOAD_RECORDED", // 下载记录（重复下载归并，不重复签发能力）
  "USE_ACKNOWLEDGED", // 展演使用回执（一次实际使用）
  "SUBGRANT_REQUESTED", // 转授权申请
  "SUBGRANT_DECIDED", // 转授权决定
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 公开层级：数值越大越敏感。发包时单元层级必须 <= 机构获准接触的最高层级。
export const PUBLIC_TIERS = Object.freeze({
  PUBLIC: 0, // 可公开
  RESTRICTED: 1, // 受限公开（签署承诺的机构）
  INTERNAL: 2, // 内部资料
});

// 权利人决定类型。
export const HOLDER_STANCES = Object.freeze(["GRANT", "DENY", "REVOKE"]);

// 知识单元状态。
export const UNIT_STATUSES = Object.freeze(["ACTIVE", "PENDING", "FROZEN", "REVOKED", "DENIED", "EXPIRED"]);

// 机构状态。
export const RECIPIENT_STATUSES = Object.freeze(["ACTIVE", "EXITED"]);

// 转授权决定。
export const SUBGRANT_DECISIONS = Object.freeze(["APPROVED", "REJECTED"]);

// 每类事件 payload 的必备字段（subject_id 为聚合主体：单元、译文、机构或授权包）。
export const PAYLOAD_FIELDS = Object.freeze({
  KNOWLEDGE_REGISTERED: ["unit_code", "title", "holders", "tier", "regions", "purposes", "valid_from", "valid_until", "version"],
  KNOWLEDGE_REVISED: ["unit_code", "version"],
  HOLDER_DECISION: ["unit_code", "holder_id", "stance"],
  HOLDER_DISAGREEMENT: ["unit_code", "holder_ids"],
  EMERGENCY_STOP: ["unit_code", "reason"],
  TRANSLATION_REVIEWED: ["translation_code", "unit_code", "source_version", "language", "version"],
  RECIPIENT_REGISTERED: ["recipient_id", "name", "max_tier", "regions", "purposes"],
  RECIPIENT_EXITED: ["recipient_id"],
  PACKAGE_ISSUED: ["package_code", "recipient_id", "manifest", "content_hash"],
  GRANT_DELIVERED: ["recipient_id", "grant_id", "regions", "purposes", "items", "capability_reissued"],
  WITHDRAWAL_NOTICE_ISSUED: ["withdrawal_id", "recipient_id", "unit_codes", "reason", "version"],
  WITHDRAWAL_ACK: ["withdrawal_id", "recipient_id", "received"],
  DOWNLOAD_RECORDED: ["recipient_id", "package_code", "content_hash", "dedup_key", "repeat"],
  USE_ACKNOWLEDGED: ["recipient_id", "package_code", "unit_codes", "venue", "used_at", "dedup_key"],
  SUBGRANT_REQUESTED: ["request_id", "recipient_id", "to_party", "unit_codes", "regions", "purposes"],
  SUBGRANT_DECIDED: ["request_id", "decision"],
});

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
    return problems;
  }
  const payload = record.payload ?? {};
  for (const field of PAYLOAD_FIELDS[record.kind] ?? []) {
    if (!(field in payload)) problems.push(`payload.${field}`);
  }
  return problems;
}
