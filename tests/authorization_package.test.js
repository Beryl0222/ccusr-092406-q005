import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateEvent } from "../src/heritage_exchange_boundary.js";
import { AuthorizationPackageService, AuthorizationServiceError } from "../src/authorization_package_service.js";

const NOW = "2026-10-01T10:00:00+08:00";
const clock = () => NOW;

const expectError = (code, fn) => {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof AuthorizationServiceError);
    assert.equal(err.code, code);
    return true;
  });
};

// 搭建一个走完登记、授权、发包流程的服务，供各测试共享同一套时间线。
function seedScenario() {
  const svc = new AuthorizationPackageService({ clock });

  // 四个知识单元：可发的 song、地域不符的 rite、层级不足的 secret、已过期的 old。
  svc.registerUnit({
    unit_code: "unit-song",
    title: "跨境展演唱段",
    holders: ["h-a", "h-b"],
    tier: "RESTRICTED",
    regions: ["SG", "MY"],
    purposes: ["PERFORMANCE"],
    valid_from: "2026-09-01",
    valid_until: "2027-09-01",
    version: "v1",
  });
  svc.registerUnit({
    unit_code: "unit-rite",
    title: "祭祀仪轨",
    holders: ["h-c", "h-d"],
    tier: "RESTRICTED",
    regions: ["JP"],
    purposes: ["PERFORMANCE"],
    valid_from: "2026-09-01",
    valid_until: "2027-09-01",
    version: "v1",
  });
  svc.registerUnit({
    unit_code: "unit-secret",
    title: "内部口诀",
    holders: ["h-e"],
    tier: "INTERNAL",
    regions: ["*"],
    purposes: ["*"],
    valid_from: "2026-09-01",
    valid_until: "2027-09-01",
  });
  svc.registerUnit({
    unit_code: "unit-old",
    title: "往期展演资料",
    holders: ["h-a"],
    tier: "PUBLIC",
    regions: ["*"],
    purposes: ["*"],
    valid_from: "2025-01-01",
    valid_until: "2026-08-31",
  });

  svc.registerRecipient({
    recipient_id: "org-sg",
    name: "新加坡展演点",
    max_tier: "RESTRICTED",
    regions: ["SG"],
    purposes: ["PERFORMANCE"],
  });
  svc.registerRecipient({
    recipient_id: "org-jp",
    name: "东京展演点",
    max_tier: "RESTRICTED",
    regions: ["JP"],
    purposes: ["PERFORMANCE"],
  });

  // 译文必须引用确定原文版本：引用不存在的版本被拒绝。
  expectError("UNPINNED_SOURCE", () =>
    svc.reviewTranslation({
      translation_code: "tr-song-en",
      unit_code: "unit-song",
      source_version: "v999",
      language: "en",
    }),
  );
  svc.reviewTranslation({
    translation_code: "tr-song-en",
    unit_code: "unit-song",
    source_version: "v1",
    language: "en",
    version: "t1",
  });

  // 权利人一致授权后单元才 ACTIVE。
  svc.recordHolderDecision("unit-song", "h-a", "GRANT");
  svc.recordHolderDecision("unit-song", "h-b", "GRANT");
  assert.equal(svc.unitStatus("unit-song"), "ACTIVE");

  svc.recordHolderDecision("unit-rite", "h-c", "GRANT");
  svc.recordHolderDecision("unit-rite", "h-d", "GRANT");
  // 内部口诀权利人虽一致授权，但层级超出机构获准范围，发包时仍应被排除。
  svc.recordHolderDecision("unit-secret", "h-e", "GRANT");

  // 两个机构各自首次发包：只交付一次能力。
  const sg = svc.issuePackage({
    recipient_id: "org-sg",
    package_code: "pkg-sg-001",
    unit_codes: ["unit-song", "unit-rite", "unit-secret", "unit-old"],
  });
  const jp = svc.issuePackage({
    recipient_id: "org-jp",
    package_code: "pkg-jp-001",
    unit_codes: ["unit-rite"],
  });

  return { svc, sg, jp };
}

test("样例符合领域约定", async () => {
  const record = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(record), []);
});

test("领域校验覆盖新增事件的载荷字段", () => {
  assert.deepEqual(
    validateEvent({
      event_id: "e1",
      kind: "WITHDRAWAL_NOTICE_ISSUED",
      occurred_at: NOW,
      subject_id: "wd-1",
      payload: { withdrawal_id: "wd-1", recipient_id: "org-sg", unit_codes: [], reason: "x", version: "v1" },
    }),
    [],
  );
  const problems = validateEvent({
    event_id: "e2",
    kind: "PACKAGE_ISSUED",
    occurred_at: NOW,
    subject_id: "pkg-1",
    payload: { package_code: "pkg-1" },
  });
  assert.ok(problems.includes("payload.recipient_id"));
  assert.ok(problems.includes("payload.manifest"));
  assert.ok(problems.includes("payload.content_hash"));
});

test("发包只包含接收机构当前获准的最小集合，逐项排除不获准内容", () => {
  const { sg } = seedScenario();
  assert.equal(sg.replayed, false);
  assert.deepEqual(
    sg.package.manifest.map((i) => i.unit_code),
    ["unit-song"],
  );
  // 译文钉住当前原文版本随包交付。
  assert.equal(sg.package.manifest[0].version, "v1");
  assert.deepEqual(sg.package.manifest[0].translations.map((t) => t.translation_code), ["tr-song-en"]);
  assert.equal(sg.package.manifest[0].translations[0].source_version, "v1");
  // 排除原因可向协调员说明：地域、层级、有效期各归其类。
  assert.deepEqual(
    sg.exclusions,
    [
      { unit_code: "unit-rite", reason: "REGION" },
      { unit_code: "unit-secret", reason: "TIER" },
      { unit_code: "unit-old", reason: "EXPIRED" },
    ],
  );
});

test("首次发包交付一次能力；同码同内容幂等重放，不重复签发", () => {
  const { svc } = seedScenario();
  const grantCount = () => svc.events.filter((e) => e.kind === "GRANT_DELIVERED").length;
  assert.equal(grantCount(), 2);
  const again = svc.issuePackage({
    recipient_id: "org-sg",
    package_code: "pkg-sg-001",
    unit_codes: ["unit-song", "unit-rite"],
  });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.events, []);
  assert.equal(grantCount(), 2);
});

test("同包异内容必须冲突", () => {
  const { svc } = seedScenario();
  // 单元出新版后，同 package_code 折出的清单内容变化 → 冲突，而不是覆盖旧包。
  svc.reviseUnit("unit-song", "v2", { note: "唱段修订" });
  expectError("PACKAGE_CONTENT_CONFLICT", () =>
    svc.issuePackage({ recipient_id: "org-sg", package_code: "pkg-sg-001", unit_codes: ["unit-song"] }),
  );
  // 同一包标识被其他机构使用同样冲突。
  expectError("PACKAGE_CODE_CONFLICT", () =>
    svc.issuePackage({ recipient_id: "org-jp", package_code: "pkg-sg-001", unit_codes: ["unit-rite"] }),
  );
});

test("多个权利人意见不一致时只冻结相关单元，不影响其他内容", () => {
  const { svc } = seedScenario();
  svc.recordHolderDecision("unit-rite", "h-d", "DENY");
  assert.equal(svc.unitStatus("unit-rite"), "FROZEN");
  assert.ok(svc.events.some((e) => e.kind === "HOLDER_DISAGREEMENT" && e.payload.unit_code === "unit-rite"));
  // 另一个单元保持可用。
  assert.equal(svc.unitStatus("unit-song"), "ACTIVE");
  // 冻结单元不能再发出：最小集合为空。
  expectError("EMPTY_GRANT", () =>
    svc.issuePackage({ recipient_id: "org-jp", package_code: "pkg-jp-002", unit_codes: ["unit-rite"] }),
  );
  // 历史已签发的包继续留痕。
  assert.ok(svc.events.some((e) => e.kind === "PACKAGE_ISSUED" && e.payload.package_code === "pkg-jp-001"));
});

test("重复下载与离线使用回执按稳定标识归并", () => {
  const { svc } = seedScenario();
  const d1 = svc.recordDownload({ recipient_id: "org-sg", package_code: "pkg-sg-001" });
  assert.equal(d1.repeat, false);
  const d2 = svc.recordDownload({ recipient_id: "org-sg", package_code: "pkg-sg-001" });
  assert.equal(d2.repeat, true);
  assert.equal(d2.download.repeats, 1);

  const a1 = svc.recordUseAck({
    recipient_id: "org-sg",
    package_code: "pkg-sg-001",
    unit_codes: ["unit-song"],
    venue: "Singapore Expo",
    used_at: "2026-10-05T20:00:00+08:00",
  });
  const a2 = svc.recordUseAck({
    recipient_id: "org-sg",
    package_code: "pkg-sg-001",
    unit_codes: ["unit-song"],
    venue: "Singapore Expo",
    used_at: "2026-10-05T20:00:00+08:00",
  });
  assert.equal(a1.repeat, false);
  assert.equal(a2.repeat, true);
  assert.equal(a2.ack.repeats, 1);
  // 归并下载不产生新能力。
  assert.equal(svc.events.filter((e) => e.kind === "GRANT_DELIVERED").length, 2);
  return a1.ack.dedup_key;
});

test("紧急停用产生新版撤回通知，只发给实际持有者，历史事实留痕", () => {
  const { svc } = seedScenario();
  const before = svc.events.length;
  const { stop, notices } = svc.emergencyStop("unit-song", "权利人临时要求停用");
  assert.equal(stop.kind, "EMERGENCY_STOP");
  assert.equal(svc.unitStatus("unit-song"), "REVOKED");
  // 只有 org-sg 持有含 song 的包；org-jp 与退出/无关机构不收通知。
  assert.equal(notices.length, 1);
  assert.equal(notices[0].payload.recipient_id, "org-sg");
  assert.equal(notices[0].payload.version, "v1");
  assert.equal(notices[0].payload.withdrawal_id, "wd:unit-song:org-sg:v1");

  // 历史包与展演事实仍然可查。
  const tracePkg = svc.events.find((e) => e.kind === "PACKAGE_ISSUED" && e.payload.package_code === "pkg-sg-001");
  assert.ok(tracePkg);
  assert.equal(tracePkg.payload.manifest[0].version, "v1");

  // 撤回后该单元不能再进入任何新包。
  expectError("EMPTY_GRANT", () =>
    svc.issuePackage({ recipient_id: "org-sg", package_code: "pkg-sg-009", unit_codes: ["unit-song"] }),
  );

  // 事态再次升级：产生新一版撤回通知。
  const again = svc.emergencyStop("unit-song", "停用范围扩大");
  assert.equal(again.notices[0].payload.version, "v2");
  assert.ok(svc.events.length > before);
});

test("撤回确认离线归并；系统恢复只补送未确认撤回，不重复签发能力", () => {
  const { svc } = seedScenario();
  svc.emergencyStop("unit-song", "权利人临时要求停用");
  svc.emergencyStop("unit-song", "停用范围扩大");

  const wdV1 = "wd:unit-song:org-sg:v1";
  const ack1 = svc.acknowledgeWithdrawal({ withdrawal_id: wdV1 });
  assert.equal(ack1.repeat, false);
  const ack2 = svc.acknowledgeWithdrawal({ withdrawal_id: wdV1 });
  assert.equal(ack2.repeat, true);
  assert.equal(ack2.ack.repeats, 1);

  // v1 已确认，v2 尚未确认：恢复时只补送 v2。
  const pending = svc.pendingWithdrawalRedelivery();
  assert.deepEqual(pending.redeliver.map((w) => w.withdrawal_id), ["wd:unit-song:org-sg:v2"]);
  assert.equal(pending.capabilities_reissued, 0);
});

test("机构退出后立即停止新取用，历史包重放不被改写", () => {
  const { svc } = seedScenario();
  // 退出前已发生过一次下载。
  const beforeExit = svc.recordDownload({ recipient_id: "org-jp", package_code: "pkg-jp-001", dedup_key: "dl:jp:venue-1" });
  assert.equal(beforeExit.repeat, false);

  const { notices } = svc.exitRecipient("org-jp");
  // 就其手上单元产生撤回通知，纳入统一的补送/确认通道。
  assert.deepEqual(notices.map((n) => n.payload.withdrawal_id), ["wd:unit-rite:org-jp:exit:1"]);

  expectError("RECIPIENT_EXITED", () =>
    svc.issuePackage({ recipient_id: "org-jp", package_code: "pkg-jp-999", unit_codes: ["unit-rite"] }),
  );
  expectError("RECIPIENT_EXITED", () =>
    svc.recordDownload({ recipient_id: "org-jp", package_code: "pkg-jp-001", dedup_key: "dl:new-after-exit" }),
  );
  // 旧包的同码重放是历史事实，不被拒绝、不产生事件。
  const replay = svc.issuePackage({ recipient_id: "org-jp", package_code: "pkg-jp-001", unit_codes: ["unit-rite"] });
  assert.equal(replay.replayed, true);
  // 退出前那次下载的离线重复回执到达，仍按稳定标识归并留痕。
  const again = svc.recordDownload({ recipient_id: "org-jp", package_code: "pkg-jp-001", dedup_key: "dl:jp:venue-1" });
  assert.equal(again.repeat, true);
  assert.equal(again.download.repeats, 1);
});

test("转授权申请按稳定标识归并，并受当前授权状态约束", () => {
  const { svc } = seedScenario();
  svc.emergencyStop("unit-song", "停用");
  svc.recordHolderDecision("unit-rite", "h-d", "DENY");

  const r1 = svc.requestSubgrant({
    request_id: "sg-sub-001",
    recipient_id: "org-sg",
    to_party: "venue-partner-x",
    unit_codes: ["unit-song"],
    regions: ["SG"],
    purposes: ["PERFORMANCE"],
  });
  assert.equal(r1.replayed, false);
  const r2 = svc.requestSubgrant({
    request_id: "sg-sub-001",
    recipient_id: "org-sg",
    to_party: "venue-partner-x",
    unit_codes: ["unit-song"],
    regions: ["SG"],
    purposes: ["PERFORMANCE"],
  });
  assert.equal(r2.replayed, true);

  // 已停用单元不得转授权。
  expectError("SUBGRANT_NOT_ELIGIBLE", () => svc.decideSubgrant("sg-sub-001", "APPROVED"));
  // 但可以正式拒绝并留痕。
  const rejected = svc.decideSubgrant("sg-sub-001", "REJECTED", { note: "单元已撤回" });
  assert.equal(rejected.request.decision.decision, "REJECTED");
  // 决定不可翻转。
  expectError("SUBGRANT_CONFLICT", () => svc.decideSubgrant("sg-sub-001", "APPROVED"));

  // 退出机构的申请不得批准。
  svc.exitRecipient("org-jp");
  svc.requestSubgrant({
    request_id: "jp-sub-001",
    recipient_id: "org-jp",
    to_party: "venue-partner-y",
    unit_codes: ["unit-rite"],
    regions: ["JP"],
    purposes: ["PERFORMANCE"],
  });
  expectError("RECIPIENT_EXITED", () => svc.decideSubgrant("jp-sub-001", "APPROVED"));

  // 独立单元不受冻结/停用影响：另一单元正常获批转授权。
  svc.registerUnit({
    unit_code: "unit-craft",
    title: "手工技艺",
    holders: ["h-f"],
    tier: "PUBLIC",
    regions: ["SG"],
    purposes: ["PERFORMANCE"],
    valid_from: "2026-09-01",
    valid_until: "2027-09-01",
  });
  svc.recordHolderDecision("unit-craft", "h-f", "GRANT");
  svc.requestSubgrant({
    request_id: "sg-sub-002",
    recipient_id: "org-sg",
    to_party: "venue-partner-z",
    unit_codes: ["unit-craft"],
    regions: ["SG"],
    purposes: ["PERFORMANCE"],
  });
  const approved = svc.decideSubgrant("sg-sub-002", "APPROVED");
  assert.equal(approved.request.decision.decision, "APPROVED");
  // 超出申请机构获准地域的转授权同样被拦截。
  svc.requestSubgrant({
    request_id: "sg-sub-003",
    recipient_id: "org-sg",
    to_party: "venue-partner-z",
    unit_codes: ["unit-craft"],
    regions: ["JP"],
    purposes: ["PERFORMANCE"],
  });
  expectError("SUBGRANT_NOT_ELIGIBLE", () => svc.decideSubgrant("sg-sub-003", "APPROVED"));
});

test("从一次实际使用可反查原文、译审、授权决定与接收回执", () => {
  const { svc } = seedScenario();
  const useDedup = svc.recordUseAck({
    recipient_id: "org-sg",
    package_code: "pkg-sg-001",
    unit_codes: ["unit-song"],
    venue: "Singapore Expo",
    used_at: "2026-10-05T20:00:00+08:00",
  }).ack.dedupKey;
  svc.emergencyStop("unit-song", "权利人临时要求停用");
  svc.emergencyStop("unit-song", "停用范围扩大");
  svc.acknowledgeWithdrawal({ withdrawal_id: "wd:unit-song:org-sg:v1" });

  const trace = svc.traceUse(useDedup);
  assert.equal(trace.use.venue, "Singapore Expo");
  assert.equal(trace.package.package_code, "pkg-sg-001");
  assert.equal(trace.grant.capability_reissued, false);
  assert.ok(trace.grant.delivered_event_id);

  const item = trace.items[0];
  assert.equal(item.unit_code, "unit-song");
  // 反查到的原文是使用时钉住的历史版本，而非当前版本。
  assert.equal(item.source.used_version, "v1");
  assert.deepEqual(
    item.holder_decisions.map((d) => [d.holder_id, d.stance]),
    [
      ["h-a", "GRANT"],
      ["h-b", "GRANT"],
    ],
  );
  const en = item.translations.find((t) => t.translation_code === "tr-song-en");
  assert.equal(en.source_version, "v1");
  assert.equal(en.pinned_to_used_source, true);
  assert.equal(item.emergency_stops.length, 2);

  const wdV1 = item.withdrawals.find((w) => w.version === "v1");
  const wdV2 = item.withdrawals.find((w) => w.version === "v2");
  assert.equal(wdV1.receipt.received, true);
  assert.equal(wdV2.receipt, null);
});

test("事件流可重建：恢复后状态一致，补送未确认撤回且不重复签发能力", () => {
  const { svc } = seedScenario();
  svc.recordDownload({ recipient_id: "org-sg", package_code: "pkg-sg-001" });
  svc.emergencyStop("unit-song", "权利人临时要求停用");
  svc.emergencyStop("unit-song", "停用范围扩大");
  svc.acknowledgeWithdrawal({ withdrawal_id: "wd:unit-song:org-sg:v1" });
  const originalEvents = svc.events;

  // 用既有事件流重建服务（模拟系统恢复）。
  const restored = new AuthorizationPackageService({ events: originalEvents, clock });
  assert.equal(restored.events.length, originalEvents.length);
  assert.equal(restored.unitStatus("unit-song"), "REVOKED");
  assert.equal(restored.unitStatus("unit-rite"), "ACTIVE");

  const pending = restored.pendingWithdrawalRedelivery();
  assert.deepEqual(pending.redeliver.map((w) => w.withdrawal_id), ["wd:unit-song:org-sg:v2"]);
  assert.equal(pending.capabilities_reissued, 0);

  // 重建后重复请求与重复下载全部走归并/幂等通道，能力数量不增加。
  const grantsBefore = restored.events.filter((e) => e.kind === "GRANT_DELIVERED").length;
  restored.issuePackage({ recipient_id: "org-sg", package_code: "pkg-sg-001", unit_codes: ["unit-song"] });
  restored.recordDownload({ recipient_id: "org-sg", package_code: "pkg-sg-001" });
  assert.equal(restored.events.filter((e) => e.kind === "GRANT_DELIVERED").length, grantsBefore);
});
