// authorization_package_service 授权包服务。
//
// 在登记、译审、发包、回执四类既有事件之上，提供知识单元授权的最小集合发包、
// 分歧冻结、紧急撤回新版通知、离线回执归并、同包异内容冲突、机构退出停用、
// 恢复补送与一次使用全链反查。所有状态由事件流折出（event sourcing），
// 历史事实永不删除；本模块零外部依赖，可在单容器内直接运行。

import crypto from "node:crypto";
import { EVENT_KINDS, PUBLIC_TIERS, HOLDER_STANCES, SUBGRANT_DECISIONS } from "./heritage_exchange_boundary.js";

export class AuthorizationServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthorizationServiceError";
    this.code = code;
  }
}

const asDate = (instant) => String(instant).slice(0, 10);
const intersects = (a, b) => a.includes("*") || b.includes("*") || a.some((x) => b.includes(x));

function canonicalHash(value) {
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.keys(v)
        .sort()
        .reduce((acc, key) => {
          acc[key] = stable(v[key]);
          return acc;
        }, {});
    }
    return v;
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export class AuthorizationPackageService {
  #events;
  #state;
  #clock;

  constructor({ events = [], clock = () => new Date().toISOString() } = {}) {
    this.#clock = clock;
    this.#events = [];
    this.#state = this.#blankState();
    for (const event of events) this.#fold(event);
    this.#events.push(...events);
  }

  #blankState() {
    return {
      seq: 0,
      units: new Map(),
      translations: new Map(),
      recipients: new Map(),
      packages: new Map(),
      grants: new Map(),
      withdrawals: new Map(),
      downloads: new Map(),
      useAcks: new Map(),
      subgrants: new Map(),
    };
  }

  // ---- 事件日志 ---------------------------------------------------------

  get events() {
    return this.#events.map((e) => structuredClone(e));
  }

  #append(kind, subjectId, payload, { eventId, occurredAt } = {}) {
    if (!EVENT_KINDS.includes(kind)) throw new AuthorizationServiceError("BAD_EVENT", `未知事件种类 ${kind}`);
    this.#state.seq += 1;
    const event = Object.freeze({
      event_id: eventId ?? `${kind.toLowerCase()}-${subjectId}-${this.#state.seq}`,
      kind,
      occurred_at: occurredAt ?? this.#clock(),
      subject_id: subjectId,
      payload: Object.freeze(structuredClone(payload)),
    });
    this.#fold(event);
    this.#events.push(event);
    return event;
  }

  // ---- 折出投影 ---------------------------------------------------------

  #holderStatus(unit) {
    const decided = [...unit.decisions.values()].map((d) => d.stance);
    if (decided.length < unit.holderIds.length) return "PENDING";
    const stances = new Set(decided);
    if (stances.size > 1) return "FROZEN";
    if (stances.has("GRANT")) return "ACTIVE";
    if (stances.has("REVOKE")) return "REVOKED";
    return "DENIED";
  }

  unitStatus(unitCode, at = this.#clock()) {
    const unit = this.#state.units.get(unitCode);
    if (!unit) throw new AuthorizationServiceError("UNKNOWN_UNIT", `未知知识单元 ${unitCode}`);
    if (unit.emergencyStops.length > 0) return "REVOKED";
    const status = this.#holderStatus(unit);
    if (["REVOKED", "FROZEN", "DENIED"].includes(status)) return status;
    if (asDate(at) > unit.validUntil) return "EXPIRED";
    if (asDate(at) < unit.validFrom) return "PENDING";
    return status;
  }

  #fold(event) {
    const { kind, payload: p, occurred_at: at } = event;
    const s = this.#state;
    switch (kind) {
      case "KNOWLEDGE_REGISTERED": {
        s.units.set(p.unit_code, {
          code: p.unit_code,
          title: p.title,
          holderIds: [...p.holders],
          tier: p.tier,
          regions: [...p.regions],
          purposes: [...p.purposes],
          validFrom: p.valid_from,
          validUntil: p.valid_until,
          version: p.version,
          revisions: [{ version: p.version, at, eventId: event.event_id }],
          decisions: new Map(),
          emergencyStops: [],
          registeredAt: at,
          registrationEventId: event.event_id,
        });
        break;
      }
      case "KNOWLEDGE_REVISED": {
        const unit = s.units.get(p.unit_code);
        unit.version = p.version;
        unit.revisions.push({ version: p.version, at, eventId: event.event_id, note: p.note });
        break;
      }
      case "HOLDER_DECISION": {
        const unit = s.units.get(p.unit_code);
        if (!unit.holderIds.includes(p.holder_id)) {
          throw new AuthorizationServiceError("UNKNOWN_HOLDER", `${p.holder_id} 不是 ${p.unit_code} 的登记权利人`);
        }
        if (!HOLDER_STANCES.includes(p.stance)) {
          throw new AuthorizationServiceError("BAD_STANCE", `未知立场 ${p.stance}`);
        }
        unit.decisions.set(p.holder_id, { stance: p.stance, at, eventId: event.event_id });
        break;
      }
      case "HOLDER_DISAGREEMENT": {
        const unit = s.units.get(p.unit_code);
        unit.disagreements = unit.disagreements ?? [];
        unit.disagreements.push({ holderIds: [...p.holder_ids], at, eventId: event.event_id });
        break;
      }
      case "EMERGENCY_STOP": {
        s.units.get(p.unit_code).emergencyStops.push({ reason: p.reason, at, eventId: event.event_id });
        break;
      }
      case "TRANSLATION_REVIEWED": {
        const unit = s.units.get(p.unit_code);
        if (!unit) throw new AuthorizationServiceError("UNKNOWN_UNIT", `译文引用未知单元 ${p.unit_code}`);
        const known = unit.revisions.some((r) => r.version === p.source_version);
        if (!known) {
          throw new AuthorizationServiceError("UNPINNED_SOURCE", `译文必须引用确定原文版本，未知版本 ${p.source_version}`);
        }
        const entry = s.translations.get(p.translation_code) ?? {
          code: p.translation_code,
          unitCode: p.unit_code,
          language: p.language,
          reviews: [],
        };
        entry.reviews.push({ version: p.version, sourceVersion: p.source_version, at, eventId: event.event_id });
        s.translations.set(p.translation_code, entry);
        break;
      }
      case "RECIPIENT_REGISTERED": {
        s.recipients.set(p.recipient_id, {
          id: p.recipient_id,
          name: p.name,
          maxTier: p.max_tier,
          regions: [...p.regions],
          purposes: [...p.purposes],
          status: "ACTIVE",
          registeredAt: at,
        });
        break;
      }
      case "RECIPIENT_EXITED": {
        const recipient = s.recipients.get(p.recipient_id);
        recipient.status = "EXITED";
        recipient.exitedAt = at;
        break;
      }
      case "GRANT_DELIVERED": {
        s.grants.set(p.recipient_id, {
          grantId: p.grant_id,
          recipientId: p.recipient_id,
          regions: [...p.regions],
          purposes: [...p.purposes],
          items: structuredClone(p.items),
          capabilityReissued: p.capability_reissued,
          at,
          eventId: event.event_id,
        });
        break;
      }
      case "PACKAGE_ISSUED": {
        s.packages.set(p.package_code, {
          code: p.package_code,
          recipientId: p.recipient_id,
          manifest: structuredClone(p.manifest),
          contentHash: p.content_hash,
          at,
          eventId: event.event_id,
        });
        break;
      }
      case "WITHDRAWAL_NOTICE_ISSUED": {
        s.withdrawals.set(p.withdrawal_id, {
          id: p.withdrawal_id,
          recipientId: p.recipient_id,
          unitCodes: [...p.unit_codes],
          reason: p.reason,
          version: p.version,
          at,
          eventId: event.event_id,
          ack: null,
        });
        break;
      }
      case "WITHDRAWAL_ACK": {
        const notice = s.withdrawals.get(p.withdrawal_id);
        if (!notice) throw new AuthorizationServiceError("UNKNOWN_WITHDRAWAL", `未知撤回通知 ${p.withdrawal_id}`);
        if (notice.ack) {
          notice.ack.repeats += 1;
        } else {
          notice.ack = { received: p.received, at, eventId: event.event_id, repeats: 0 };
        }
        break;
      }
      case "DOWNLOAD_RECORDED": {
        const known = s.downloads.get(p.dedup_key);
        if (known) {
          known.repeats += 1;
        } else {
          s.downloads.set(p.dedup_key, {
            dedupKey: p.dedup_key,
            recipientId: p.recipient_id,
            packageCode: p.package_code,
            contentHash: p.content_hash,
            at,
            eventId: event.event_id,
            repeats: 0,
          });
        }
        break;
      }
      case "USE_ACKNOWLEDGED": {
        const known = s.useAcks.get(p.dedup_key);
        if (known) {
          known.repeats += 1;
        } else {
          s.useAcks.set(p.dedup_key, {
            dedupKey: p.dedup_key,
            recipientId: p.recipient_id,
            packageCode: p.package_code,
            unitCodes: [...p.unit_codes],
            venue: p.venue,
            usedAt: p.used_at,
            at,
            eventId: event.event_id,
            repeats: 0,
          });
        }
        break;
      }
      case "SUBGRANT_REQUESTED": {
        if (!s.subgrants.has(p.request_id)) {
          s.subgrants.set(p.request_id, {
            requestId: p.request_id,
            recipientId: p.recipient_id,
            toParty: p.to_party,
            unitCodes: [...p.unit_codes],
            regions: [...p.regions],
            purposes: [...p.purposes],
            requestedAt: at,
            eventId: event.event_id,
            decision: null,
          });
        }
        break;
      }
      case "SUBGRANT_DECIDED": {
        const request = s.subgrants.get(p.request_id);
        if (!request) throw new AuthorizationServiceError("UNKNOWN_SUBGRANT", `未知转授权申请 ${p.request_id}`);
        request.decision = { decision: p.decision, at, eventId: event.event_id, note: p.note };
        break;
      }
      default:
        throw new AuthorizationServiceError("BAD_EVENT", `未支持的事件种类 ${kind}`);
    }
  }

  // ---- 登记与译审 -------------------------------------------------------

  registerUnit(input) {
    if (this.#state.units.has(input.unit_code)) {
      throw new AuthorizationServiceError("DUP_UNIT", `知识单元已登记 ${input.unit_code}`);
    }
    if (!(input.tier in PUBLIC_TIERS)) throw new AuthorizationServiceError("BAD_TIER", `未知公开层级 ${input.tier}`);
    if (!input.holders?.length) throw new AuthorizationServiceError("NO_HOLDER", "至少记录一名权利人");
    const payload = {
      unit_code: input.unit_code,
      title: input.title,
      holders: [...input.holders],
      tier: input.tier,
      regions: [...input.regions],
      purposes: [...input.purposes],
      valid_from: input.valid_from,
      valid_until: input.valid_until,
      version: input.version ?? "v1",
      note: input.note,
    };
    return this.#append("KNOWLEDGE_REGISTERED", input.unit_code, payload);
  }

  reviseUnit(unitCode, version, { note, occurredAt } = {}) {
    const unit = this.#requireUnit(unitCode);
    if (unit.revisions.some((r) => r.version === version)) {
      throw new AuthorizationServiceError("DUP_VERSION", `${unitCode} 已存在版本 ${version}`);
    }
    return this.#append("KNOWLEDGE_REVISED", unitCode, { unit_code: unitCode, version, note }, { occurredAt });
  }

  // 权利人表态。多个权利人意见不一致时冻结该单元，其他单元不受影响。
  recordHolderDecision(unitCode, holderId, stance, { occurredAt } = {}) {
    const unit = this.#requireUnit(unitCode);
    const wasFrozen = this.unitStatus(unitCode, occurredAt ?? this.#clock()) === "FROZEN";
    const event = this.#append(
      "HOLDER_DECISION",
      unitCode,
      { unit_code: unitCode, holder_id: holderId, stance },
      { occurredAt },
    );
    const nowFrozen = this.unitStatus(unitCode, occurredAt ?? this.#clock()) === "FROZEN";
    if (nowFrozen && !wasFrozen) {
      const holderIds = unit.holderIds.filter((id) => unit.decisions.has(id));
      this.#append("HOLDER_DISAGREEMENT", unitCode, { unit_code: unitCode, holder_ids: holderIds }, { occurredAt });
    }
    return event;
  }

  reviewTranslation(input) {
    const payload = {
      translation_code: input.translation_code,
      unit_code: input.unit_code,
      source_version: input.source_version,
      language: input.language,
      version: input.version ?? "v1",
    };
    return this.#append("TRANSLATION_REVIEWED", input.translation_code, payload, { occurredAt: input.occurred_at });
  }

  registerRecipient(input) {
    if (this.#state.recipients.has(input.recipient_id)) {
      throw new AuthorizationServiceError("DUP_RECIPIENT", `机构已登记 ${input.recipient_id}`);
    }
    if (!(input.max_tier in PUBLIC_TIERS)) throw new AuthorizationServiceError("BAD_TIER", `未知公开层级 ${input.max_tier}`);
    const payload = {
      recipient_id: input.recipient_id,
      name: input.name,
      max_tier: input.max_tier,
      regions: [...input.regions],
      purposes: [...input.purposes],
    };
    return this.#append("RECIPIENT_REGISTERED", input.recipient_id, payload);
  }

  // ---- 最小集合发包 -----------------------------------------------------

  #requireUnit(unitCode) {
    const unit = this.#state.units.get(unitCode);
    if (!unit) throw new AuthorizationServiceError("UNKNOWN_UNIT", `未知知识单元 ${unitCode}`);
    return unit;
  }

  #requireActiveRecipient(recipientId) {
    const recipient = this.#state.recipients.get(recipientId);
    if (!recipient) throw new AuthorizationServiceError("UNKNOWN_RECIPIENT", `未知接收机构 ${recipientId}`);
    if (recipient.status === "EXITED") {
      throw new AuthorizationServiceError("RECIPIENT_EXITED", `机构已退出，停止一切新取用：${recipientId}`);
    }
    return recipient;
  }

  // 计算某机构对某单元在当前时刻的取用资格；不获准给出原因。
  #eligibility(unit, recipient, at) {
    const status = this.unitStatus(unit.code, at);
    if (status !== "ACTIVE") return { ok: false, reason: status };
    if (PUBLIC_TIERS[unit.tier] > PUBLIC_TIERS[recipient.maxTier]) return { ok: false, reason: "TIER" };
    if (!intersects(unit.regions, recipient.regions)) return { ok: false, reason: "REGION" };
    if (!intersects(unit.purposes, recipient.purposes)) return { ok: false, reason: "PURPOSE" };
    return { ok: true };
  }

  // 钉版译文：只纳入引用单元当前原文版本且审订通过的最新译文。
  #pinnedTranslations(unitCode, sourceVersion) {
    const items = [];
    for (const t of this.#state.translations.values()) {
      if (t.unitCode !== unitCode) continue;
      const latest = t.reviews.at(-1);
      if (latest.sourceVersion === sourceVersion) {
        items.push({
          translation_code: t.code,
          language: t.language,
          version: latest.version,
          source_version: latest.sourceVersion,
        });
      }
    }
    return items;
  }

  // 返回接收机构当前获准的最小集合（只含明确请求且仍获准的单元，逐项排除不获准内容）。
  minimalSet(recipientId, unitCodes, at = this.#clock()) {
    const recipient = this.#state.recipients.get(recipientId);
    if (!recipient) throw new AuthorizationServiceError("UNKNOWN_RECIPIENT", `未知接收机构 ${recipientId}`);
    const manifest = [];
    const exclusions = [];
    for (const unitCode of unitCodes) {
      const unit = this.#requireUnit(unitCode);
      if (recipient.status === "EXITED") {
        exclusions.push({ unit_code: unitCode, reason: "RECIPIENT_EXITED" });
        continue;
      }
      const check = this.#eligibility(unit, recipient, at);
      if (!check.ok) {
        exclusions.push({ unit_code: unitCode, reason: check.reason });
        continue;
      }
      manifest.push({
        unit_code: unit.code,
        version: unit.version,
        tier: unit.tier,
        translations: this.#pinnedTranslations(unit.code, unit.version),
      });
    }
    return { manifest, exclusions };
  }

  // 签发授权包。同一稳定 package_code：内容相同为幂等重放，内容不同即冲突。
  // 首次发包同时交付一次授权能力；任何重复取用都不会重新签发能力。
  issuePackage({ recipient_id, package_code, unit_codes, occurred_at }) {
    const recipient = this.#state.recipients.get(recipient_id);
    if (!recipient) throw new AuthorizationServiceError("UNKNOWN_RECIPIENT", `未知接收机构 ${recipient_id}`);
    const at = occurred_at ?? this.#clock();

    // 同码同内容是历史事实的幂等重放（含离线重试、撤回/退出后到达的重复请求）。
    // 不按当下资格重算包内容：事后撤回或退出只让条目在重算时落空，历史定格内容不变；
    // 但定格条目若因原文出新版、译审钉版变化而内容不同，则属于同包异内容，必须冲突。
    const known = this.#state.packages.get(package_code);
    if (known) {
      if (known.recipientId !== recipient_id) {
        throw new AuthorizationServiceError("PACKAGE_CODE_CONFLICT", `包标识 ${package_code} 已属于其他机构`);
      }
      const { manifest } = this.minimalSet(recipient_id, unit_codes, at);
      for (const frozen of known.manifest) {
        const current = manifest.find((m) => m.unit_code === frozen.unit_code);
        if (current && canonicalHash(current) !== canonicalHash(frozen)) {
          throw new AuthorizationServiceError(
            "PACKAGE_CONTENT_CONFLICT",
            `同包异内容冲突：${package_code} 中 ${frozen.unit_code} 已定格为 ${frozen.version}，当前内容不同`,
          );
        }
      }
      return { package: known, replayed: true, exclusions: [], events: [] };
    }

    // 新包属于新取用：机构退出后立即拒绝。
    this.#requireActiveRecipient(recipient_id);
    const { manifest, exclusions } = this.minimalSet(recipient_id, unit_codes, at);
    if (manifest.length === 0) {
      throw new AuthorizationServiceError("EMPTY_GRANT", `机构 ${recipient_id} 当前对所请求单元无任何获准取用`);
    }
    const contentHash = canonicalHash({ package_code, recipient_id, manifest });

    const events = [];
    if (!this.#state.grants.has(recipient_id)) {
      const grantId = `grant:${recipient_id}`;
      events.push(
        this.#append(
          "GRANT_DELIVERED",
          recipient_id,
          {
            recipient_id,
            grant_id: grantId,
            regions: [...recipient.regions],
            purposes: [...recipient.purposes],
            items: structuredClone(manifest),
            capability_reissued: false,
          },
          { occurredAt: at },
        ),
      );
    }
    events.push(
      this.#append(
        "PACKAGE_ISSUED",
        package_code,
        { package_code, recipient_id, manifest, content_hash: contentHash },
        { occurredAt: at },
      ),
    );
    return { package: this.#state.packages.get(package_code), replayed: false, exclusions, events };
  }

  // ---- 下载与使用回执（离线，按稳定标识归并） ---------------------------

  // 重复下载按 dedup_key 归并；已归并的旧下载即使内容事后被撤回也只是回放过往记录，
  // 不构成新取用、不重新签发能力。首次下载必须通过当下取用资格检查。
  recordDownload({ recipient_id, package_code, dedup_key, occurred_at }) {
    const pkg = this.#state.packages.get(package_code);
    if (!pkg) throw new AuthorizationServiceError("UNKNOWN_PACKAGE", `未知授权包 ${package_code}`);
    if (pkg.recipientId !== recipient_id) {
      throw new AuthorizationServiceError("PACKAGE_RECIPIENT_MISMATCH", `包 ${package_code} 不属于 ${recipient_id}`);
    }
    const dedupKey = dedup_key ?? `dl:${recipient_id}:${package_code}:${pkg.contentHash}`;
    const known = this.#state.downloads.get(dedupKey);
    const at = occurred_at ?? this.#clock();
    if (!known) this.#requireActiveRecipient(recipient_id);
    const event = this.#append(
      "DOWNLOAD_RECORDED",
      recipient_id,
      {
        recipient_id,
        package_code,
        content_hash: pkg.contentHash,
        dedup_key: dedupKey,
        repeat: Boolean(known),
      },
      { occurredAt: at },
    );
    return { download: this.#state.downloads.get(dedupKey), repeat: Boolean(known), event };
  }

  recordUseAck({ recipient_id, package_code, unit_codes, venue, used_at, dedup_key, occurred_at }) {
    const pkg = this.#state.packages.get(package_code);
    if (!pkg) throw new AuthorizationServiceError("UNKNOWN_PACKAGE", `未知授权包 ${package_code}`);
    if (pkg.recipientId !== recipient_id) {
      throw new AuthorizationServiceError("PACKAGE_RECIPIENT_MISMATCH", `包 ${package_code} 不属于 ${recipient_id}`);
    }
    const dedupKey = dedup_key ?? `use:${recipient_id}:${package_code}:${asDate(used_at ?? this.#clock())}`;
    const known = this.#state.useAcks.get(dedupKey);
    const event = this.#append(
      "USE_ACKNOWLEDGED",
      package_code,
      {
        recipient_id,
        package_code,
        unit_codes: [...unit_codes],
        venue,
        used_at,
        dedup_key: dedupKey,
        repeat: Boolean(known),
      },
      { occurredAt: occurred_at ?? this.#clock() },
    );
    return { ack: this.#state.useAcks.get(dedupKey), repeat: Boolean(known), event };
  }

  // ---- 分歧冻结、紧急停用与撤回 ----------------------------------------

  // 紧急停用：单元立即进入 REVOKED，并向所有仍持有含该单元包的活跃机构发出
  // 带新版本号的撤回通知。历史包与展演回执继续留痕，不删除。
  emergencyStop(unitCode, reason, { occurred_at } = {}) {
    const unit = this.#requireUnit(unitCode);
    const at = occurred_at ?? this.#clock();
    const stop = this.#append("EMERGENCY_STOP", unitCode, { unit_code: unitCode, reason }, { occurredAt: at });
    const generation = unit.emergencyStops.length;

    const holders = new Set();
    for (const pkg of this.#state.packages.values()) {
      if (!pkg.manifest.some((item) => item.unit_code === unitCode)) continue;
      holders.add(pkg.recipientId);
    }
    const notices = [];
    for (const recipientId of holders) {
      const recipient = this.#state.recipients.get(recipientId);
      if (recipient.status === "EXITED") continue;
      const withdrawalId = `wd:${unitCode}:${recipientId}:v${generation}`;
      if (this.#state.withdrawals.has(withdrawalId)) continue;
      notices.push(
        this.#append(
          "WITHDRAWAL_NOTICE_ISSUED",
          withdrawalId,
          {
            withdrawal_id: withdrawalId,
            recipient_id: recipientId,
            unit_codes: [unitCode],
            reason,
            version: `v${generation}`,
          },
          { occurredAt: at },
        ),
      );
    }
    return { stop, notices };
  }

  // 合作方离线确认撤回；同一通知的重复确认按 withdrawal_id 归并。
  acknowledgeWithdrawal({ withdrawal_id, received = true, occurred_at }) {
    if (!this.#state.withdrawals.has(withdrawal_id)) {
      throw new AuthorizationServiceError("UNKNOWN_WITHDRAWAL", `未知撤回通知 ${withdrawal_id}`);
    }
    const before = this.#state.withdrawals.get(withdrawal_id).ack;
    const event = this.#append(
      "WITHDRAWAL_ACK",
      withdrawal_id,
      { withdrawal_id, recipient_id: this.#state.withdrawals.get(withdrawal_id).recipientId, received },
      { occurredAt: occurred_at ?? this.#clock() },
    );
    return { ack: this.#state.withdrawals.get(withdrawal_id).ack, repeat: Boolean(before), event };
  }

  // ---- 机构退出 ---------------------------------------------------------

  // 机构退出：立即停止新取用，并就其手上全部单元补发撤回通知（供恢复补送统一处理）。
  exitRecipient(recipientId, { occurred_at } = {}) {
    const recipient = this.#requireActiveRecipient(recipientId);
    const at = occurred_at ?? this.#clock();
    const exit = this.#append("RECIPIENT_EXITED", recipientId, { recipient_id: recipientId }, { occurredAt: at });

    const unitCodes = new Set();
    for (const pkg of this.#state.packages.values()) {
      if (pkg.recipientId !== recipientId) continue;
      for (const item of pkg.manifest) unitCodes.add(item.unit_code);
    }
    const notices = [];
    for (const unitCode of unitCodes) {
      const withdrawalId = `wd:${unitCode}:${recipientId}:exit:1`;
      if (this.#state.withdrawals.has(withdrawalId)) continue;
      notices.push(
        this.#append(
          "WITHDRAWAL_NOTICE_ISSUED",
          withdrawalId,
          {
            withdrawal_id: withdrawalId,
            recipient_id: recipientId,
            unit_codes: [unitCode],
            reason: "RECIPIENT_EXITED",
            version: "exit:1",
          },
          { occurredAt: at },
        ),
      );
    }
    return { exit, notices };
  }

  // ---- 转授权 -----------------------------------------------------------

  requestSubgrant(input) {
    const requestId = input.request_id;
    const known = this.#state.subgrants.get(requestId);
    if (known) return { request: known, replayed: true };
    const recipient = this.#state.recipients.get(input.recipient_id);
    if (!recipient) throw new AuthorizationServiceError("UNKNOWN_RECIPIENT", `未知接收机构 ${input.recipient_id}`);
    for (const unitCode of input.unit_codes) this.#requireUnit(unitCode);
    const event = this.#append(
      "SUBGRANT_REQUESTED",
      requestId,
      {
        request_id: requestId,
        recipient_id: input.recipient_id,
        to_party: input.to_party,
        unit_codes: [...input.unit_codes],
        regions: [...input.regions],
        purposes: [...input.purposes],
      },
      { occurredAt: input.occurred_at },
    );
    return { request: this.#state.subgrants.get(requestId), replayed: false, event };
  }

  // 转授权批准前提：申请机构当前对每个单元在目标地域/用途仍持有有效授权，
  // 且单元处于 ACTIVE；冻结、撤回、过期单元一律不得转授权。
  decideSubgrant(requestId, decision, { note, occurred_at } = {}) {
    const request = this.#state.subgrants.get(requestId);
    if (!request) throw new AuthorizationServiceError("UNKNOWN_SUBGRANT", `未知转授权申请 ${requestId}`);
    if (!SUBGRANT_DECISIONS.includes(decision)) {
      throw new AuthorizationServiceError("BAD_DECISION", `未知转授权决定 ${decision}`);
    }
    if (request.decision) {
      if (request.decision.decision === decision) return { request, replayed: true };
      throw new AuthorizationServiceError(
        "SUBGRANT_CONFLICT",
        `申请 ${requestId} 已有决定 ${request.decision.decision}，不能改为 ${decision}`,
      );
    }
    if (decision === "APPROVED") {
      const recipient = this.#state.recipients.get(request.recipientId);
      if (recipient.status === "EXITED") {
        throw new AuthorizationServiceError("RECIPIENT_EXITED", "机构已退出，转授权申请不得批准");
      }
      const at = occurred_at ?? this.#clock();
      const scoped = { ...recipient, regions: request.regions, purposes: request.purposes };
      for (const unitCode of request.unitCodes) {
        const unit = this.#requireUnit(unitCode);
        const check = this.#eligibility(unit, scoped, at);
        if (!check.ok) {
          throw new AuthorizationServiceError(
            "SUBGRANT_NOT_ELIGIBLE",
            `单元 ${unitCode} 当前不可转授（${check.reason}）`,
          );
        }
      }
    }
    const event = this.#append(
      "SUBGRANT_DECIDED",
      requestId,
      { request_id: requestId, decision, note },
      { occurredAt: occurred_at ?? this.#clock() },
    );
    return { request: this.#state.subgrants.get(requestId), replayed: false, event };
  }

  // ---- 恢复与反查 -------------------------------------------------------

  // 系统恢复：只找出尚未被确认收到（或确认未收到）的撤回通知用于补送；
  // 不重新生成通知，更不重新签发任何能力。
  pendingWithdrawalRedelivery() {
    const pending = [];
    for (const notice of this.#state.withdrawals.values()) {
      if (!notice.ack || notice.ack.received !== true) {
        pending.push({
          withdrawal_id: notice.id,
          recipient_id: notice.recipientId,
          unit_codes: [...notice.unitCodes],
          reason: notice.reason,
          version: notice.version,
          issued_at: notice.at,
          repeats: notice.ack?.repeats ?? 0,
        });
      }
    }
    return { redeliver: pending, capabilities_reissued: 0 };
  }

  // 从一次实际使用反查：原文版本、译审钉版、权利人授权决定、紧急停用、
  // 撤回通知与接收回执，以及该机构的能力交付记录。
  traceUse(dedupKey) {
    const use = this.#state.useAcks.get(dedupKey);
    if (!use) throw new AuthorizationServiceError("UNKNOWN_USE", `未知使用回执 ${dedupKey}`);
    const pkg = this.#state.packages.get(use.packageCode);

    const items = pkg.manifest.map((item) => {
      const unit = this.#state.units.get(item.unit_code);
      const decisions = [...unit.decisions.entries()].map(([holderId, d]) => ({
        holder_id: holderId,
        stance: d.stance,
        at: d.at,
        event_id: d.eventId,
      }));
      const translations = [];
      for (const t of this.#state.translations.values()) {
        if (t.unitCode !== item.unit_code) continue;
        for (const review of t.reviews) {
          translations.push({
            translation_code: t.code,
            language: t.language,
            version: review.version,
            source_version: review.sourceVersion,
            pinned_to_used_source: review.sourceVersion === item.version,
            at: review.at,
            event_id: review.eventId,
          });
        }
      }
      const withdrawals = [];
      for (const notice of this.#state.withdrawals.values()) {
        if (notice.recipientId !== pkg.recipientId) continue;
        if (!notice.unitCodes.includes(item.unit_code)) continue;
        withdrawals.push({
          withdrawal_id: notice.id,
          reason: notice.reason,
          version: notice.version,
          issued_at: notice.at,
          issued_event_id: notice.eventId,
          receipt: notice.ack,
        });
      }
      return {
        unit_code: item.unit_code,
        source: {
          title: unit.title,
          used_version: item.version,
          tier: unit.tier,
          regions: [...unit.regions],
          purposes: [...unit.purposes],
          valid_from: unit.validFrom,
          valid_until: unit.validUntil,
          registered_at: unit.registeredAt,
          registration_event_id: unit.registrationEventId,
          revisions: [...unit.revisions],
        },
        holder_decisions: decisions,
        disagreement_events: unit.disagreements ?? [],
        emergency_stops: [...unit.emergencyStops],
        translations,
        withdrawals,
      };
    });

    return {
      use: structuredClone(use),
      package: {
        package_code: pkg.code,
        recipient_id: pkg.recipientId,
        content_hash: pkg.contentHash,
        issued_at: pkg.at,
        issued_event_id: pkg.eventId,
        manifest: structuredClone(pkg.manifest),
      },
      grant: this.#state.grants.get(pkg.recipientId)
        ? (() => {
            const g = this.#state.grants.get(pkg.recipientId);
            return {
              grant_id: g.grantId,
              delivered_at: g.at,
              delivered_event_id: g.eventId,
              capability_reissued: g.capabilityReissued,
            };
          })()
        : null,
      items,
    };
  }

  // ---- 只读视图（供运维/审计） ------------------------------------------

  view() {
    const s = this.#state;
    return {
      units: [...s.units.values()].map((u) => ({
        unit_code: u.code,
        title: u.title,
        version: u.version,
        status: this.unitStatus(u.code),
        holder_ids: [...u.holderIds],
        tier: u.tier,
        regions: [...u.regions],
        purposes: [...u.purposes],
        valid_from: u.validFrom,
        valid_until: u.validUntil,
      })),
      recipients: [...s.recipients.values()].map((r) => ({
        recipient_id: r.id,
        name: r.name,
        status: r.status,
        max_tier: r.maxTier,
        regions: [...r.regions],
        purposes: [...r.purposes],
      })),
      packages: [...s.packages.values()].map((p) => ({
        package_code: p.code,
        recipient_id: p.recipientId,
        content_hash: p.contentHash,
        manifest: structuredClone(p.manifest),
      })),
      withdrawals: [...s.withdrawals.values()].map((w) => ({
        withdrawal_id: w.id,
        recipient_id: w.recipientId,
        unit_codes: [...w.unitCodes],
        version: w.version,
        acknowledged: Boolean(w.ack && w.ack.received === true),
      })),
    };
  }
}
