import assert from "node:assert/strict";
import test from "node:test";
import { validateEvent } from "../src/heritage_exchange_boundary.js";
import { LicensingPackageService } from "../src/licensing_package_service.js";

// 固定时钟：每次调用前进一秒，保证事件时间戳互不相同且落在授权有效期内。
function makeService() {
  let tick = 0;
  const base = Date.parse("2026-09-25T08:00:00Z");
  return new LicensingPackageService({ now: () => new Date(base + tick++ * 1000).toISOString() });
}

function assertCode(fn, code) {
  assert.throws(fn, (err) => err.code === code);
}

const HOLDERS = ["holder-a", "holder-b"];

function seedUnit(service, unit_id) {
  service.registerUnit({
    unit_id,
    holders: HOLDERS,
    publicity_level: "partner",
    territories: ["JP", "FR"],
    purposes: ["performance", "workshop"],
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: "2027-01-01T00:00:00Z",
  });
  service.addSourceVersion({ unit_id, version_id: "v1", content_hash: `hash-${unit_id}-v1` });
}

function approveAll(service, unit_id) {
  for (const holder_id of HOLDERS) service.recordHolderConsent({ unit_id, holder_id, approve: true });
}

function grantFor(service, { grant_id, unit_id, institution_id = "inst-museum", territory = "JP", purpose = "performance" }) {
  return service.decideLicense({
    grant_id,
    unit_id,
    institution_id,
    territory,
    purpose,
    valid_from: "2026-06-01T00:00:00Z",
    valid_until: "2026-12-31T00:00:00Z",
  });
}

test("知识单元分别记录权利人、公开层级、地域、用途和有效期", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  const unit = service.units.get("unit-a");
  assert.deepEqual(unit.holders, HOLDERS);
  assert.equal(unit.publicity_level, "partner");
  assert.deepEqual(unit.territories, ["JP", "FR"]);
  assert.deepEqual(unit.purposes, ["performance", "workshop"]);
  assert.equal(unit.valid_from, "2026-01-01T00:00:00Z");
  assert.equal(unit.valid_until, "2027-01-01T00:00:00Z");
  assert.equal(unit.status, "active");

  assertCode(() => seedUnit(service, "unit-a"), "DUPLICATE_ID");
  const base = { holders: HOLDERS, publicity_level: "partner", territories: ["JP"], purposes: ["performance"], valid_from: "2026-01-01T00:00:00Z", valid_until: "2027-01-01T00:00:00Z" };
  assertCode(() => service.registerUnit({ ...base, unit_id: "u-bad-holders", holders: [] }), "VALIDATION");
  assertCode(() => service.registerUnit({ ...base, unit_id: "u-bad-level", publicity_level: "secret" }), "VALIDATION");
  assertCode(() => service.registerUnit({ ...base, unit_id: "u-bad-window", valid_from: "2027-01-01T00:00:00Z", valid_until: "2026-01-01T00:00:00Z" }), "VALIDATION");
  assertCode(() => service.addSourceVersion({ unit_id: "unit-a", version_id: "v1", content_hash: "dup" }), "DUPLICATE_ID");
  assertCode(() => service.addSourceVersion({ unit_id: "nope", version_id: "v1", content_hash: "x" }), "UNIT_NOT_FOUND");
});

test("译文必须引用确定的原文版本", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  assertCode(
    () => service.reviewTranslation({ translation_id: "tr-1", unit_id: "unit-a", source_version: "v9", language: "en", reviewer: "rev-1", result: "approved" }),
    "TRANSLATION_SOURCE_UNKNOWN",
  );
  assertCode(
    () => service.reviewTranslation({ translation_id: "tr-1", unit_id: "nope", source_version: "v1", language: "en", reviewer: "rev-1", result: "approved" }),
    "UNIT_NOT_FOUND",
  );
  const translation = service.reviewTranslation({ translation_id: "tr-1", unit_id: "unit-a", source_version: "v1", language: "en", reviewer: "rev-1", result: "approved" });
  assert.equal(translation.source_version, "v1");
  assertCode(
    () => service.reviewTranslation({ translation_id: "tr-1", unit_id: "unit-a", source_version: "v1", language: "fr", reviewer: "rev-1", result: "approved" }),
    "DUPLICATE_ID",
  );
});

test("权利人意见不一致时冻结相关单元，不影响其他内容", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  seedUnit(service, "unit-b");
  approveAll(service, "unit-a");
  approveAll(service, "unit-b");
  grantFor(service, { grant_id: "g-a", unit_id: "unit-a" });
  grantFor(service, { grant_id: "g-b", unit_id: "unit-b" });

  assertCode(() => service.recordHolderConsent({ unit_id: "unit-a", holder_id: "stranger", approve: true }), "HOLDER_UNKNOWN");

  // 权利人意见不一致 → 冻结 unit-a，unit-b 不受影响
  service.recordHolderConsent({ unit_id: "unit-a", holder_id: "holder-b", approve: false });
  assert.equal(service.units.get("unit-a").status, "frozen");
  assert.equal(service.units.get("unit-b").status, "active");

  // 冻结单元不进入新包，其他单元正常发包
  const pkg = service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });
  assert.deepEqual(pkg.items.map((item) => item.unit_id), ["unit-b"]);

  // 冻结期间不可新增授权决定
  assertCode(() => grantFor(service, { grant_id: "g-a2", unit_id: "unit-a" }), "UNIT_FROZEN");

  // 意见重新一致 → 自动解冻，可继续授权
  service.recordHolderConsent({ unit_id: "unit-a", holder_id: "holder-b", approve: true });
  assert.equal(service.units.get("unit-a").status, "active");
  grantFor(service, { grant_id: "g-a2", unit_id: "unit-a" });
  assert.equal(service.events.filter((event) => event.kind === "KNOWLEDGE_UNIT_FROZEN").length, 1);
  assert.equal(service.events.filter((event) => event.kind === "KNOWLEDGE_UNIT_UNFROZEN").length, 1);
});

test("授权决定需权利人意见齐备且不得超出登记范围", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  assertCode(() => grantFor(service, { grant_id: "g-1", unit_id: "unit-a" }), "CONSENT_INCOMPLETE");
  approveAll(service, "unit-a");
  assertCode(() => grantFor(service, { grant_id: "g-2", unit_id: "unit-a", territory: "US" }), "SCOPE_EXCEEDED");
  assertCode(() => grantFor(service, { grant_id: "g-3", unit_id: "unit-a", purpose: "sale" }), "SCOPE_EXCEEDED");
  assertCode(
    () =>
      service.decideLicense({
        grant_id: "g-4",
        unit_id: "unit-a",
        institution_id: "inst-museum",
        territory: "JP",
        purpose: "performance",
        valid_from: "2026-06-01T00:00:00Z",
        valid_until: "2028-01-01T00:00:00Z",
      }),
    "SCOPE_EXCEEDED",
  );
  const grant = grantFor(service, { grant_id: "g-5", unit_id: "unit-a" });
  assert.equal(grant.status, "active");
  assertCode(() => grantFor(service, { grant_id: "g-5", unit_id: "unit-a" }), "DUPLICATE_ID");
  assertCode(() => grantFor(service, { grant_id: "g-6", unit_id: "nope" }), "UNIT_NOT_FOUND");
});

test("发包只包含接收机构当前获准的最小集合", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  approveAll(service, "unit-a");
  service.reviewTranslation({ translation_id: "tr-en", unit_id: "unit-a", source_version: "v1", language: "en", reviewer: "rev-1", result: "approved" });
  service.reviewTranslation({ translation_id: "tr-fr", unit_id: "unit-a", source_version: "v1", language: "fr", reviewer: "rev-1", result: "rejected" });
  seedUnit(service, "unit-b");
  approveAll(service, "unit-b");
  seedUnit(service, "unit-c");
  approveAll(service, "unit-c");

  grantFor(service, { grant_id: "g-a", unit_id: "unit-a", institution_id: "inst-museum" });
  grantFor(service, { grant_id: "g-b", unit_id: "unit-b", institution_id: "inst-other" });
  // 已过期的授权不进入最小集合
  service.decideLicense({
    grant_id: "g-c",
    unit_id: "unit-c",
    institution_id: "inst-museum",
    territory: "JP",
    purpose: "performance",
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: "2026-06-01T00:00:00Z",
  });

  const pkg = service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });
  assert.deepEqual(pkg.items.map((item) => item.unit_id), ["unit-a"]);
  assert.equal(pkg.items[0].source_version, "v1");
  assert.deepEqual(pkg.items[0].translations, [{ translation_id: "tr-en", language: "en" }]);

  // 原文升级后，只携带与新版本对应的已审译文
  service.addSourceVersion({ unit_id: "unit-a", version_id: "v2", content_hash: "hash-unit-a-v2" });
  service.reviewTranslation({ translation_id: "tr-en-v2", unit_id: "unit-a", source_version: "v2", language: "en", reviewer: "rev-1", result: "approved" });
  const pkg2 = service.issuePackage({ package_id: "pkg-2", institution_id: "inst-museum" });
  assert.equal(pkg2.items[0].source_version, "v2");
  assert.deepEqual(pkg2.items[0].translations.map((item) => item.translation_id), ["tr-en-v2"]);

  // 没有任何有效授权的机构不能发包
  assertCode(() => service.issuePackage({ package_id: "pkg-3", institution_id: "inst-nobody" }), "NOTHING_TO_ISSUE");
});

test("同包异内容必须冲突，重复签发按稳定标识归并", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  approveAll(service, "unit-a");
  grantFor(service, { grant_id: "g-a", unit_id: "unit-a" });

  const first = service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });
  const again = service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });
  assert.equal(again, first);
  assert.equal(service.events.filter((event) => event.kind === "PACKAGE_ISSUED").length, 1);

  // 授权内容变化后，同一包标识必须冲突
  seedUnit(service, "unit-b");
  approveAll(service, "unit-b");
  grantFor(service, { grant_id: "g-b", unit_id: "unit-b" });
  assertCode(() => service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" }), "PACKAGE_CONTENT_CONFLICT");

  // 不同包标识可正常签发
  const pkg2 = service.issuePackage({ package_id: "pkg-2", institution_id: "inst-museum" });
  assert.equal(pkg2.items.length, 2);
});

test("离线回执与重复下载按稳定标识归并", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  approveAll(service, "unit-a");
  grantFor(service, { grant_id: "g-a", unit_id: "unit-a" });
  service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });

  const receipt = service.recordReceipt({ receipt_id: "rc-1", receipt_kind: "offline_use", package_id: "pkg-1", institution_id: "inst-museum" });
  const again = service.recordReceipt({ receipt_id: "rc-1", receipt_kind: "offline_use", package_id: "pkg-1", institution_id: "inst-museum" });
  assert.equal(again, receipt);
  assert.equal(service.events.filter((event) => event.kind === "USE_ACKNOWLEDGED").length, 1);

  // 重复下载归并
  service.recordReceipt({ receipt_id: "dl-1", receipt_kind: "download", package_id: "pkg-1", institution_id: "inst-museum" });
  service.recordReceipt({ receipt_id: "dl-1", receipt_kind: "download", package_id: "pkg-1", institution_id: "inst-museum" });
  assert.equal(service.events.filter((event) => event.kind === "USE_ACKNOWLEDGED").length, 2);

  // 同标识异内容必须冲突
  assertCode(
    () => service.recordReceipt({ receipt_id: "rc-1", receipt_kind: "offline_use", package_id: "pkg-1", institution_id: "inst-other" }),
    "RECEIPT_CONFLICT",
  );
  assertCode(
    () => service.recordReceipt({ receipt_id: "rc-9", receipt_kind: "offline_use", package_id: "nope", institution_id: "inst-museum" }),
    "PACKAGE_NOT_FOUND",
  );
  assertCode(
    () => service.recordReceipt({ receipt_id: "rc-8", receipt_kind: "offline_use", package_id: "pkg-1", institution_id: "inst-other" }),
    "INSTITUTION_MISMATCH",
  );
});

test("转授权申请按稳定标识归并并校验现有授权", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  approveAll(service, "unit-a");
  grantFor(service, { grant_id: "g-a", unit_id: "unit-a" });

  const request = service.requestSublicense({ request_id: "sub-1", institution_id: "inst-museum", unit_id: "unit-a", territory: "JP", purpose: "performance" });
  const again = service.requestSublicense({ request_id: "sub-1", institution_id: "inst-museum", unit_id: "unit-a", territory: "JP", purpose: "performance" });
  assert.equal(again, request);
  assert.equal(service.events.filter((event) => event.kind === "SUBLICENSE_REQUESTED").length, 1);

  assertCode(
    () => service.requestSublicense({ request_id: "sub-1", institution_id: "inst-museum", unit_id: "unit-a", territory: "FR", purpose: "performance" }),
    "SUBLICENSE_CONFLICT",
  );
  assertCode(
    () => service.requestSublicense({ request_id: "sub-2", institution_id: "inst-museum", unit_id: "unit-a", territory: "FR", purpose: "performance" }),
    "SCOPE_EXCEEDED",
  );
  assertCode(
    () => service.requestSublicense({ request_id: "sub-3", institution_id: "inst-other", unit_id: "unit-a", territory: "JP", purpose: "performance" }),
    "GRANT_NOT_FOUND",
  );
});

test("紧急停用产生新版撤回通知，历史展演事实继续留痕", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  approveAll(service, "unit-a");
  grantFor(service, { grant_id: "g-a", unit_id: "unit-a", institution_id: "inst-museum" });
  grantFor(service, { grant_id: "g-a2", unit_id: "unit-a", institution_id: "inst-other" });
  service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });
  service.recordReceipt({ receipt_id: "rc-1", receipt_kind: "offline_use", package_id: "pkg-1", institution_id: "inst-museum" });

  const notice1 = service.withdrawPermission({ unit_id: "unit-a", institution_id: "inst-museum", reason: "权利人撤回演示步骤" });
  assert.equal(notice1.notice_version, 1);
  assert.equal(service.grants.get("g-a").status, "withdrawn");
  assert.equal(service.grants.get("g-a2").status, "active");

  // 紧急停用产生新版撤回通知
  const notice2 = service.withdrawPermission({ unit_id: "unit-a", institution_id: "inst-museum", reason: "紧急停用", emergency: true });
  assert.equal(notice2.notice_version, 2);
  assert.equal(notice2.emergency, true);

  // 历史展演事实继续留痕
  assert.ok(service.events.some((event) => event.kind === "PACKAGE_ISSUED"));
  assert.ok(service.events.some((event) => event.kind === "USE_ACKNOWLEDGED"));
  assert.ok(service.receipts.has("rc-1"));

  // 撤回后该单元不再进入新包
  assertCode(() => service.issuePackage({ package_id: "pkg-2", institution_id: "inst-museum" }), "NOTHING_TO_ISSUE");

  // 全量紧急停用影响所有机构
  const notice3 = service.withdrawPermission({ unit_id: "unit-a", reason: "全量紧急停用", emergency: true });
  assert.equal(notice3.institution_id, null);
  assert.equal(notice3.notice_version, 1);
  assert.equal(service.grants.get("g-a2").status, "withdrawn");
});

test("机构退出后立即停止新取用，历史事实继续留痕", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  approveAll(service, "unit-a");
  grantFor(service, { grant_id: "g-a", unit_id: "unit-a" });
  service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });

  service.exitInstitution({ institution_id: "inst-museum" });
  assertCode(() => service.issuePackage({ package_id: "pkg-2", institution_id: "inst-museum" }), "INSTITUTION_EXITED");
  assertCode(
    () => service.recordReceipt({ receipt_id: "dl-1", receipt_kind: "download", package_id: "pkg-1", institution_id: "inst-museum" }),
    "INSTITUTION_EXITED",
  );
  assertCode(
    () => service.requestSublicense({ request_id: "sub-1", institution_id: "inst-museum", unit_id: "unit-a", territory: "JP", purpose: "performance" }),
    "INSTITUTION_EXITED",
  );
  assertCode(() => grantFor(service, { grant_id: "g-new", unit_id: "unit-a" }), "INSTITUTION_EXITED");

  // 迟到的离线回执作为历史展演事实仍可登记
  const late = service.recordReceipt({ receipt_id: "rc-late", receipt_kind: "offline_use", package_id: "pkg-1", institution_id: "inst-museum" });
  assert.equal(late.receipt_id, "rc-late");

  // 退出操作幂等
  service.exitInstitution({ institution_id: "inst-museum" });
  assert.equal(service.events.filter((event) => event.kind === "INSTITUTION_EXITED").length, 1);
});

test("系统恢复时只补送未确认撤回，不重复签发能力", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  approveAll(service, "unit-a");
  grantFor(service, { grant_id: "g-1", unit_id: "unit-a", institution_id: "inst-museum" });
  grantFor(service, { grant_id: "g-2", unit_id: "unit-a", institution_id: "inst-other" });
  service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });

  const notice1 = service.withdrawPermission({ unit_id: "unit-a", institution_id: "inst-museum", reason: "撤回演示步骤" });
  const notice2 = service.withdrawPermission({ unit_id: "unit-a", institution_id: "inst-other", reason: "撤回演示步骤" });
  service.acknowledgeWithdrawal({ notice_id: notice1.notice_id, receipt_id: "ack-1", institution_id: "inst-museum" });

  // 重复确认按稳定标识归并，同标识异通知必须冲突
  service.acknowledgeWithdrawal({ notice_id: notice1.notice_id, receipt_id: "ack-1", institution_id: "inst-museum" });
  assert.equal(service.events.filter((event) => event.kind === "WITHDRAWAL_ACKNOWLEDGED").length, 1);
  assertCode(
    () => service.acknowledgeWithdrawal({ notice_id: notice2.notice_id, receipt_id: "ack-1", institution_id: "inst-other" }),
    "RECEIPT_CONFLICT",
  );

  // 从事件日志整体恢复
  const restored = new LicensingPackageService({ events: service.events });
  assert.equal(restored.events.length, service.events.length);
  assert.equal(restored.grants.get("g-1").status, "withdrawn");
  assert.equal(restored.grants.get("g-2").status, "withdrawn");

  const before = restored.events.length;
  const plan = restored.recover();
  assert.equal(restored.events.length, before);
  assert.deepEqual(plan.resend_notices.map((notice) => notice.notice_id), [notice2.notice_id]);

  // 恢复后可继续服务，事件标识不重复
  restored.recordReceipt({ receipt_id: "rc-1", receipt_kind: "offline_use", package_id: "pkg-1", institution_id: "inst-museum" });
  const ids = restored.events.map((event) => event.event_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("审计能从一次实际使用反查原文、译审、授权决定和接收回执", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  approveAll(service, "unit-a");
  service.reviewTranslation({ translation_id: "tr-en", unit_id: "unit-a", source_version: "v1", language: "en", reviewer: "rev-1", result: "approved" });
  grantFor(service, { grant_id: "g-a", unit_id: "unit-a" });
  service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });
  service.recordReceipt({ receipt_id: "rc-1", receipt_kind: "offline_use", package_id: "pkg-1", institution_id: "inst-museum" });
  service.recordReceipt({ receipt_id: "dl-1", receipt_kind: "download", package_id: "pkg-1", institution_id: "inst-museum" });

  const trace = service.auditTrace("rc-1");
  assert.equal(trace.use.receipt_id, "rc-1");
  assert.equal(trace.package.package_id, "pkg-1");
  assert.equal(trace.package.institution_id, "inst-museum");
  assert.equal(trace.items.length, 1);

  const item = trace.items[0];
  assert.equal(item.unit_id, "unit-a");
  assert.deepEqual(item.knowledge_unit.holders, HOLDERS);
  assert.equal(item.source_version.version_id, "v1");
  assert.equal(item.source_version.content_hash, "hash-unit-a-v1");
  assert.deepEqual(item.translation_reviews.map((entry) => entry.translation_id), ["tr-en"]);
  assert.equal(item.translation_reviews[0].reviewer, "rev-1");
  assert.equal(item.license_decision.grant_id, "g-a");
  assert.equal(item.license_decision.territory, "JP");
  assert.equal(item.license_decision.status, "active");
  assert.deepEqual(trace.receipts.map((receipt) => receipt.receipt_id).sort(), ["dl-1", "rc-1"]);

  assertCode(() => service.auditTrace("rc-x"), "RECEIPT_NOT_FOUND");
});

test("服务产生的全部事件符合领域词汇", () => {
  const service = makeService();
  seedUnit(service, "unit-a");
  approveAll(service, "unit-a");
  service.reviewTranslation({ translation_id: "tr-en", unit_id: "unit-a", source_version: "v1", language: "en", reviewer: "rev-1", result: "approved" });
  grantFor(service, { grant_id: "g-a", unit_id: "unit-a" });
  service.issuePackage({ package_id: "pkg-1", institution_id: "inst-museum" });
  service.recordReceipt({ receipt_id: "rc-1", receipt_kind: "offline_use", package_id: "pkg-1", institution_id: "inst-museum" });
  service.requestSublicense({ request_id: "sub-1", institution_id: "inst-museum", unit_id: "unit-a", territory: "JP", purpose: "performance" });
  const notice = service.withdrawPermission({ unit_id: "unit-a", institution_id: "inst-museum", reason: "紧急停用", emergency: true });
  service.acknowledgeWithdrawal({ notice_id: notice.notice_id, receipt_id: "ack-1", institution_id: "inst-museum" });
  service.exitInstitution({ institution_id: "inst-museum" });

  assert.ok(service.events.length > 0);
  for (const event of service.events) assert.deepEqual(validateEvent(event), []);
});
