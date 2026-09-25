// 授权包服务：在登记、译审、发包与回执事件之上实现跨境展演知识授权包领域逻辑。
//
// 设计要点：
// - 状态变化一律追加为事件（事件种类见 heritage_exchange_boundary.js），服务可由事件日志整体重放恢复。
// - 知识单元分别记录权利人、公开层级、地域、用途与有效期；译文必须引用已登记的原文版本。
// - 授权决定不得超出单元登记范围，且需全部权利人同意；意见不一致时冻结相关单元，不影响其他单元。
// - 发包只包含接收机构当前获准的最小集合；同一包标识对应不同内容时拒绝签发，重复签发按稳定标识归并。
// - 离线回执、重复下载与转授权申请按稳定标识归并；机构退出后立即停止新取用，历史展演事实继续留痕。
// - 紧急停用产生版本递增的撤回通知；recover() 只补送未确认撤回，不重复签发能力。
// - auditTrace() 支持从一次实际使用反查原文版本、译审记录、授权决定与接收回执。

import { createHash } from "node:crypto";
import { EVENT_KINDS } from "./heritage_exchange_boundary.js";

export const PUBLICITY_LEVELS = Object.freeze(["public", "partner", "restricted"]);
export const TRANSLATION_RESULTS = Object.freeze(["approved", "rejected"]);
export const RECEIPT_KINDS = Object.freeze(["offline_use", "download"]);

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DomainError(code, message);
}

// 生成键序稳定的 JSON 文本，用于计算包内容摘要。
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function requirePresent(input, fields) {
  for (const field of fields) {
    const value = input[field];
    if (value === undefined || value === null || value === "") fail("VALIDATION", `缺少必填字段: ${field}`);
  }
}

function compareIds(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export class LicensingPackageService {
  constructor({ now, events } = {}) {
    this._now = now ?? (() => new Date().toISOString());
    this._seq = 0;
    this.events = [];
    this.units = new Map();
    this.translations = new Map();
    this.consents = new Map();
    this.grants = new Map();
    this.packages = new Map();
    this.receipts = new Map();
    this.sublicenseRequests = new Map();
    this.withdrawals = new Map();
    this.institutions = new Map();
    this._withdrawalVersions = new Map();
    this._withdrawalAcks = new Map();
    for (const event of events ?? []) this._replay(event);
  }

  // ---- 登记 ----

  // 每个知识单元分别记录权利人、公开层级、地域、用途和有效期。
  registerUnit(input) {
    requirePresent(input, ["unit_id", "publicity_level", "valid_from", "valid_until"]);
    if (this.units.has(input.unit_id)) fail("DUPLICATE_ID", `知识单元已存在: ${input.unit_id}`);
    if (!Array.isArray(input.holders) || input.holders.length === 0) fail("VALIDATION", "权利人列表不能为空");
    if (new Set(input.holders).size !== input.holders.length) fail("VALIDATION", "权利人列表存在重复");
    if (!PUBLICITY_LEVELS.includes(input.publicity_level)) fail("VALIDATION", `未知公开层级: ${input.publicity_level}`);
    if (!Array.isArray(input.territories) || input.territories.length === 0) fail("VALIDATION", "地域列表不能为空");
    if (!Array.isArray(input.purposes) || input.purposes.length === 0) fail("VALIDATION", "用途列表不能为空");
    if (!(input.valid_from < input.valid_until)) fail("VALIDATION", "有效期起止不合法");
    this._emit("KNOWLEDGE_REGISTERED", input.unit_id, {
      unit_id: input.unit_id,
      holders: [...input.holders],
      publicity_level: input.publicity_level,
      territories: [...input.territories],
      purposes: [...input.purposes],
      valid_from: input.valid_from,
      valid_until: input.valid_until,
    });
    return this.units.get(input.unit_id);
  }

  addSourceVersion(input) {
    requirePresent(input, ["unit_id", "version_id", "content_hash"]);
    const unit = this._unit(input.unit_id);
    if (unit.versions.has(input.version_id)) fail("DUPLICATE_ID", `原文版本已存在: ${input.unit_id}/${input.version_id}`);
    this._emit("SOURCE_VERSION_REGISTERED", input.unit_id, {
      unit_id: input.unit_id,
      version_id: input.version_id,
      content_hash: input.content_hash,
    });
    return unit.versions.get(input.version_id);
  }

  // ---- 译审 ----

  // 译文必须引用确定的原文版本，否则拒绝登记。
  reviewTranslation(input) {
    requirePresent(input, ["translation_id", "unit_id", "source_version", "language", "reviewer", "result"]);
    if (this.translations.has(input.translation_id)) fail("DUPLICATE_ID", `译文已存在: ${input.translation_id}`);
    const unit = this._unit(input.unit_id);
    if (!unit.versions.has(input.source_version)) {
      fail("TRANSLATION_SOURCE_UNKNOWN", `译文必须引用已登记的原文版本: ${input.unit_id}@${input.source_version}`);
    }
    if (!TRANSLATION_RESULTS.includes(input.result)) fail("VALIDATION", `未知译审结论: ${input.result}`);
    this._emit("TRANSLATION_REVIEWED", input.translation_id, {
      translation_id: input.translation_id,
      unit_id: input.unit_id,
      source_version: input.source_version,
      language: input.language,
      reviewer: input.reviewer,
      result: input.result,
    });
    return this.translations.get(input.translation_id);
  }

  // ---- 权利人意见与冻结 ----

  // 多个权利人意见不一致时冻结相关单元，不影响其他内容；意见重新一致后自动解冻。
  recordHolderConsent(input) {
    requirePresent(input, ["unit_id", "holder_id"]);
    if (typeof input.approve !== "boolean") fail("VALIDATION", "权利人意见必须为布尔值");
    const unit = this._unit(input.unit_id);
    if (!unit.holders.includes(input.holder_id)) fail("HOLDER_UNKNOWN", `非该单元权利人: ${input.holder_id}`);
    this._emit("HOLDER_CONSENT_RECORDED", input.unit_id, {
      unit_id: input.unit_id,
      holder_id: input.holder_id,
      approve: input.approve,
    });
    const consents = this.consents.get(input.unit_id);
    const opinions = [...consents.values()];
    if (opinions.includes(true) && opinions.includes(false) && unit.status !== "frozen") {
      this._emit("KNOWLEDGE_UNIT_FROZEN", input.unit_id, { unit_id: input.unit_id, reason: "holder_disagreement" });
    } else if (unit.status === "frozen" && unit.holders.every((holder) => consents.get(holder) === true)) {
      this._emit("KNOWLEDGE_UNIT_UNFROZEN", input.unit_id, { unit_id: input.unit_id });
    }
    return this.units.get(input.unit_id);
  }

  // ---- 授权决定 ----

  // 授权决定不得超出单元登记的地域、用途与有效期，且需全部权利人同意。
  decideLicense(input) {
    requirePresent(input, ["grant_id", "unit_id", "institution_id", "territory", "purpose", "valid_from", "valid_until"]);
    if (this.grants.has(input.grant_id)) fail("DUPLICATE_ID", `授权决定已存在: ${input.grant_id}`);
    const unit = this._unit(input.unit_id);
    if (unit.status === "frozen") fail("UNIT_FROZEN", `知识单元已冻结: ${input.unit_id}`);
    this._assertInstitutionActive(input.institution_id);
    if (!unit.territories.includes(input.territory)) fail("SCOPE_EXCEEDED", `地域超出登记范围: ${input.territory}`);
    if (!unit.purposes.includes(input.purpose)) fail("SCOPE_EXCEEDED", `用途超出登记范围: ${input.purpose}`);
    if (!(unit.valid_from <= input.valid_from && input.valid_from < input.valid_until && input.valid_until <= unit.valid_until)) {
      fail("SCOPE_EXCEEDED", "授权有效期超出单元登记范围");
    }
    const consents = this.consents.get(input.unit_id) ?? new Map();
    const missing = unit.holders.filter((holder) => consents.get(holder) !== true);
    if (missing.length > 0) fail("CONSENT_INCOMPLETE", `权利人意见未齐备: ${missing.join(", ")}`);
    this._emit("LICENSE_DECIDED", input.grant_id, {
      grant_id: input.grant_id,
      unit_id: input.unit_id,
      institution_id: input.institution_id,
      territory: input.territory,
      purpose: input.purpose,
      valid_from: input.valid_from,
      valid_until: input.valid_until,
      outcome: "granted",
    });
    return this.grants.get(input.grant_id);
  }

  // ---- 发包 ----

  // 发包只包含接收机构当前获准的最小集合；同一包标识内容不同必须冲突，重复签发按稳定标识归并。
  issuePackage({ package_id, institution_id, as_of } = {}) {
    requirePresent({ package_id, institution_id }, ["package_id", "institution_id"]);
    this._assertInstitutionActive(institution_id);
    const asOf = as_of ?? this._now();
    const items = this._minimalSet(institution_id, asOf);
    if (items.length === 0) fail("NOTHING_TO_ISSUE", `机构当前没有获准内容可发包: ${institution_id}`);
    const hash = contentHash({ institution_id, items });
    const existing = this.packages.get(package_id);
    if (existing) {
      if (existing.content_hash !== hash) fail("PACKAGE_CONTENT_CONFLICT", `同一包标识对应不同内容: ${package_id}`);
      return existing;
    }
    this._emit("PACKAGE_ISSUED", package_id, { package_id, institution_id, items, content_hash: hash });
    return this.packages.get(package_id);
  }

  // ---- 回执与转授权 ----

  // 离线回执与重复下载按稳定标识归并；同标识异内容必须冲突。
  // 下载属于新取用，机构退出后立即拒绝；离线回执是历史展演事实，继续留痕。
  recordReceipt(input) {
    requirePresent(input, ["receipt_id", "package_id", "institution_id"]);
    const receipt_kind = input.receipt_kind ?? "offline_use";
    if (!RECEIPT_KINDS.includes(receipt_kind)) fail("VALIDATION", `未知回执种类: ${receipt_kind}`);
    const existing = this.receipts.get(input.receipt_id);
    if (existing) {
      if (existing.package_id !== input.package_id || existing.institution_id !== input.institution_id || existing.receipt_kind !== receipt_kind) {
        fail("RECEIPT_CONFLICT", `同一回执标识对应不同内容: ${input.receipt_id}`);
      }
      return existing;
    }
    const pkg = this.packages.get(input.package_id);
    if (!pkg) fail("PACKAGE_NOT_FOUND", `未找到授权包: ${input.package_id}`);
    if (pkg.institution_id !== input.institution_id) fail("INSTITUTION_MISMATCH", `回执机构与发包机构不一致: ${input.institution_id}`);
    if (receipt_kind === "download") this._assertInstitutionActive(input.institution_id);
    this._emit("USE_ACKNOWLEDGED", input.receipt_id, {
      receipt_id: input.receipt_id,
      receipt_kind,
      package_id: input.package_id,
      institution_id: input.institution_id,
    });
    return this.receipts.get(input.receipt_id);
  }

  // 转授权申请按稳定标识归并，且不得超出现有授权范围。
  requestSublicense(input) {
    requirePresent(input, ["request_id", "institution_id", "unit_id", "territory", "purpose"]);
    const existing = this.sublicenseRequests.get(input.request_id);
    if (existing) {
      if (
        existing.institution_id !== input.institution_id ||
        existing.unit_id !== input.unit_id ||
        existing.territory !== input.territory ||
        existing.purpose !== input.purpose
      ) {
        fail("SUBLICENSE_CONFLICT", `同一转授权申请标识对应不同内容: ${input.request_id}`);
      }
      return existing;
    }
    this._assertInstitutionActive(input.institution_id);
    const unit = this._unit(input.unit_id);
    if (unit.status === "frozen") fail("UNIT_FROZEN", `知识单元已冻结: ${input.unit_id}`);
    const grant = [...this.grants.values()].find(
      (item) => item.institution_id === input.institution_id && item.unit_id === input.unit_id && item.status === "active",
    );
    if (!grant) fail("GRANT_NOT_FOUND", `机构未持有该单元授权: ${input.institution_id}/${input.unit_id}`);
    if (grant.territory !== input.territory || grant.purpose !== input.purpose) fail("SCOPE_EXCEEDED", "转授权范围超出现有授权");
    this._emit("SUBLICENSE_REQUESTED", input.request_id, {
      request_id: input.request_id,
      institution_id: input.institution_id,
      unit_id: input.unit_id,
      territory: input.territory,
      purpose: input.purpose,
      status: "pending",
    });
    return this.sublicenseRequests.get(input.request_id);
  }

  // ---- 撤回 ----

  // 紧急停用产生版本递增的撤回通知；历史发包与展演事实保留在事件日志中。
  // institution_id 为空表示全量停用，影响持有该单元授权的所有机构。
  withdrawPermission(input) {
    requirePresent(input, ["unit_id", "reason"]);
    this._unit(input.unit_id);
    const institution_id = input.institution_id ?? null;
    const key = `${input.unit_id}::${institution_id ?? "all"}`;
    const notice_version = (this._withdrawalVersions.get(key) ?? 0) + 1;
    const notice_id = `notice-${input.unit_id}-${institution_id ?? "all"}-v${notice_version}`;
    const withdrawn = [...this.grants.values()].filter(
      (grant) => grant.unit_id === input.unit_id && grant.status === "active" && (institution_id === null || grant.institution_id === institution_id),
    );
    this._emit("PERMISSION_WITHDRAWN", notice_id, {
      notice_id,
      unit_id: input.unit_id,
      institution_id,
      notice_version,
      reason: input.reason,
      emergency: input.emergency === true,
      withdrawn_grant_ids: withdrawn.map((grant) => grant.grant_id),
    });
    return this.withdrawals.get(notice_id);
  }

  // 撤回确认按稳定标识归并；同一回执标识不得对应不同通知。
  acknowledgeWithdrawal(input) {
    requirePresent(input, ["notice_id", "receipt_id", "institution_id"]);
    const notice = this.withdrawals.get(input.notice_id);
    if (!notice) fail("NOTICE_NOT_FOUND", `未找到撤回通知: ${input.notice_id}`);
    const known = this._withdrawalAcks.get(input.receipt_id);
    if (known !== undefined) {
      if (known !== input.notice_id) fail("RECEIPT_CONFLICT", `同一回执标识对应不同撤回通知: ${input.receipt_id}`);
      return notice;
    }
    this._emit("WITHDRAWAL_ACKNOWLEDGED", input.notice_id, {
      notice_id: input.notice_id,
      receipt_id: input.receipt_id,
      institution_id: input.institution_id,
    });
    return this.withdrawals.get(input.notice_id);
  }

  // ---- 机构退出 ----

  // 机构退出后立即停止新取用（发包、下载、转授权、新授权决定），历史事实继续留痕。
  exitInstitution({ institution_id } = {}) {
    requirePresent({ institution_id }, ["institution_id"]);
    const existing = this.institutions.get(institution_id);
    if (existing?.status === "exited") return existing;
    this._emit("INSTITUTION_EXITED", institution_id, { institution_id });
    return this.institutions.get(institution_id);
  }

  // ---- 恢复与审计 ----

  // 系统恢复时只补送未确认撤回，不重复签发能力（本方法不产生任何事件）。
  recover() {
    const resend_notices = [...this.withdrawals.values()]
      .filter((notice) => notice.acknowledgements.length === 0)
      .sort((a, b) => compareIds(a.issued_at, b.issued_at) || compareIds(a.notice_id, b.notice_id))
      .map((notice) => ({
        notice_id: notice.notice_id,
        unit_id: notice.unit_id,
        institution_id: notice.institution_id,
        notice_version: notice.notice_version,
        reason: notice.reason,
        emergency: notice.emergency,
        issued_at: notice.issued_at,
      }));
    return { resend_notices };
  }

  // 审计：从一次实际使用反查原文版本、译审记录、授权决定与接收回执。
  auditTrace(use_id) {
    const use = this.receipts.get(use_id);
    if (!use) fail("RECEIPT_NOT_FOUND", `未找到使用回执: ${use_id}`);
    const pkg = this.packages.get(use.package_id);
    const items = pkg.items.map((item) => {
      const unit = this.units.get(item.unit_id);
      const source = unit.versions.get(item.source_version);
      const grant = this.grants.get(item.grant_id);
      return {
        unit_id: item.unit_id,
        knowledge_unit: {
          holders: [...unit.holders],
          publicity_level: unit.publicity_level,
          territories: [...unit.territories],
          purposes: [...unit.purposes],
          valid_from: unit.valid_from,
          valid_until: unit.valid_until,
        },
        source_version: { version_id: source.version_id, content_hash: source.content_hash },
        translation_reviews: item.translations.map((ref) => {
          const translation = this.translations.get(ref.translation_id);
          return {
            translation_id: translation.translation_id,
            language: translation.language,
            source_version: translation.source_version,
            reviewer: translation.reviewer,
            reviewed_at: translation.reviewed_at,
          };
        }),
        license_decision: {
          grant_id: grant.grant_id,
          institution_id: grant.institution_id,
          territory: grant.territory,
          purpose: grant.purpose,
          valid_from: grant.valid_from,
          valid_until: grant.valid_until,
          status: grant.status,
          decided_at: grant.decided_at,
        },
      };
    });
    const receipts = [...this.receipts.values()].filter((receipt) => receipt.package_id === pkg.package_id);
    return {
      use,
      package: {
        package_id: pkg.package_id,
        institution_id: pkg.institution_id,
        content_hash: pkg.content_hash,
        issued_at: pkg.issued_at,
      },
      items,
      receipts,
    };
  }

  // ---- 内部实现 ----

  _unit(unit_id) {
    const unit = this.units.get(unit_id);
    if (!unit) fail("UNIT_NOT_FOUND", `未找到知识单元: ${unit_id}`);
    return unit;
  }

  _assertInstitutionActive(institution_id) {
    if (this.institutions.get(institution_id)?.status === "exited") {
      fail("INSTITUTION_EXITED", `机构已退出，停止新取用: ${institution_id}`);
    }
  }

  _latestVersion(unit) {
    const versions = [...unit.versions.values()];
    return versions.length === 0 ? undefined : versions[versions.length - 1];
  }

  _approvedTranslations(unit_id, source_version) {
    return [...this.translations.values()]
      .filter((translation) => translation.unit_id === unit_id && translation.result === "approved" && translation.source_version === source_version)
      .sort((a, b) => compareIds(a.translation_id, b.translation_id))
      .map((translation) => ({ translation_id: translation.translation_id, language: translation.language }));
  }

  // 接收机构当前获准的最小集合：有效授权 + 单元未冻结 + 当前原文版本 + 对应已审译文。
  _minimalSet(institution_id, asOf) {
    const byUnit = new Map();
    for (const grant of this.grants.values()) {
      if (grant.institution_id !== institution_id || grant.status !== "active") continue;
      if (!(grant.valid_from <= asOf && asOf <= grant.valid_until)) continue;
      if (byUnit.has(grant.unit_id)) continue;
      const unit = this.units.get(grant.unit_id);
      if (!unit || unit.status !== "active") continue;
      if (!(unit.valid_from <= asOf && asOf <= unit.valid_until)) continue;
      const source = this._latestVersion(unit);
      if (!source) continue;
      byUnit.set(unit.unit_id, { grant, unit, source });
    }
    return [...byUnit.values()]
      .sort((a, b) => compareIds(a.unit.unit_id, b.unit.unit_id))
      .map(({ grant, unit, source }) => ({
        unit_id: unit.unit_id,
        grant_id: grant.grant_id,
        source_version: source.version_id,
        translations: this._approvedTranslations(unit.unit_id, source.version_id),
      }));
  }

  _emit(kind, subject_id, payload) {
    if (!EVENT_KINDS.includes(kind)) fail("UNKNOWN_EVENT", `未知事件种类: ${kind}`);
    this._seq += 1;
    const event = {
      event_id: `evt-${String(this._seq).padStart(4, "0")}`,
      kind,
      occurred_at: this._now(),
      subject_id,
      payload,
    };
    this.events.push(event);
    this._apply(event);
    return event;
  }

  _replay(event) {
    if (!EVENT_KINDS.includes(event.kind)) fail("UNKNOWN_EVENT", `未知事件种类: ${event.kind}`);
    this.events.push(event);
    this._apply(event);
    this._seq += 1;
  }

  _apply(event) {
    const payload = event.payload;
    switch (event.kind) {
      case "KNOWLEDGE_REGISTERED":
        this.units.set(payload.unit_id, { ...payload, status: "active", versions: new Map(), registered_at: event.occurred_at });
        break;
      case "SOURCE_VERSION_REGISTERED":
        this.units.get(payload.unit_id).versions.set(payload.version_id, {
          version_id: payload.version_id,
          content_hash: payload.content_hash,
          registered_at: event.occurred_at,
        });
        break;
      case "TRANSLATION_REVIEWED":
        this.translations.set(payload.translation_id, { ...payload, reviewed_at: event.occurred_at });
        break;
      case "HOLDER_CONSENT_RECORDED": {
        if (!this.consents.has(payload.unit_id)) this.consents.set(payload.unit_id, new Map());
        this.consents.get(payload.unit_id).set(payload.holder_id, payload.approve);
        break;
      }
      case "LICENSE_DECIDED":
        this.grants.set(payload.grant_id, { ...payload, status: "active", decided_at: event.occurred_at });
        break;
      case "KNOWLEDGE_UNIT_FROZEN": {
        const unit = this.units.get(payload.unit_id);
        unit.status = "frozen";
        unit.frozen_reason = payload.reason;
        break;
      }
      case "KNOWLEDGE_UNIT_UNFROZEN": {
        const unit = this.units.get(payload.unit_id);
        unit.status = "active";
        delete unit.frozen_reason;
        break;
      }
      case "PACKAGE_ISSUED":
        this.packages.set(payload.package_id, { ...payload, issued_at: event.occurred_at });
        break;
      case "USE_ACKNOWLEDGED":
        this.receipts.set(payload.receipt_id, { ...payload, received_at: event.occurred_at });
        break;
      case "SUBLICENSE_REQUESTED":
        this.sublicenseRequests.set(payload.request_id, { ...payload, requested_at: event.occurred_at });
        break;
      case "PERMISSION_WITHDRAWN": {
        this.withdrawals.set(payload.notice_id, { ...payload, issued_at: event.occurred_at, acknowledgements: [] });
        const key = `${payload.unit_id}::${payload.institution_id ?? "all"}`;
        this._withdrawalVersions.set(key, Math.max(this._withdrawalVersions.get(key) ?? 0, payload.notice_version));
        for (const grant_id of payload.withdrawn_grant_ids) {
          const grant = this.grants.get(grant_id);
          if (grant) grant.status = "withdrawn";
        }
        break;
      }
      case "WITHDRAWAL_ACKNOWLEDGED": {
        const notice = this.withdrawals.get(payload.notice_id);
        notice.acknowledgements.push({
          receipt_id: payload.receipt_id,
          institution_id: payload.institution_id,
          acknowledged_at: event.occurred_at,
        });
        this._withdrawalAcks.set(payload.receipt_id, payload.notice_id);
        break;
      }
      case "INSTITUTION_EXITED":
        this.institutions.set(payload.institution_id, {
          institution_id: payload.institution_id,
          status: "exited",
          exited_at: event.occurred_at,
        });
        break;
      default:
        fail("UNKNOWN_EVENT", `未知事件种类: ${event.kind}`);
    }
  }
}
