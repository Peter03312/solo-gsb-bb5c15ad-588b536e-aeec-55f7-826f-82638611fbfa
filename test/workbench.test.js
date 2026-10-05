import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const iso = (ms) => new Date(ms).toISOString();
const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

async function setupBaseData() {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  await call('POST', '/api/solve');
}

// 连续发布 n 张相同数据的发布图（全部当前可用），返回编号数组
async function publishMany(n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const r = await call('POST', '/api/publish');
    assert.equal(r.status, 201, JSON.stringify(r.json));
    ids.push(r.json.id);
  }
  return ids;
}

beforeEach(async () => {
  // 每个测试用例使用全新内存库（before 只建一次服务：直接清表重建）
  db.exec(`
    DELETE FROM runs; DELETE FROM checkouts; DELETE FROM checkout_items;
    DELETE FROM weight_items; DELETE FROM schedules; DELETE FROM bookings;
    DELETE FROM calibrations; DELETE FROM maintenances; DELETE FROM device_limits;
    DELETE FROM verifications; DELETE FROM suspensions; DELETE FROM reservations;
    DELETE FROM publications; DELETE FROM drafts; DELETE FROM exclusion_pairs;
    DELETE FROM fixed_slots; DELETE FROM tube_holes; DELETE FROM tubes;
    DELETE FROM weights; DELETE FROM hole_max; DELETE FROM config;
  `);
});

test('overview：未配置时 data 为 null、可执行状态为空数组', async () => {
  const r = await call('GET', '/api/workbench/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.data, null);
  assert.equal(r.json.currentHash, null);
  assert.equal(r.json.draft, null);
  assert.deepEqual(r.json.actionable.usablePublications, []);
  assert.deepEqual(r.json.actionable.completedVerifications, []);
  assert.deepEqual(r.json.actionable.activeReservations, []);
  assert.deepEqual(r.json.actionable.devices, []);
});

test('overview：配置后给出当前配置、草稿（含 stale）与可执行状态', async () => {
  await setupBaseData();
  let r = await call('GET', '/api/workbench/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.holes, 4);
  assert.equal(r.json.draft.feasible, true);
  assert.equal(r.json.draft.stale, false);
  const pubIds = await publishMany(2);
  r = await call('GET', '/api/workbench/overview');
  assert.deepEqual(
    r.json.actionable.usablePublications.map((p) => p.id).sort(),
    pubIds,
  );
  // 数据变化后：草稿 stale，可执行发布图清空（可用性按读取时现状）
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 21 }]);
  r = await call('GET', '/api/workbench/overview');
  assert.equal(r.json.draft.stale, true);
  assert.deepEqual(r.json.actionable.usablePublications, []);
});

test('history：默认首页有界（20 条）并给出稳定倒序与 nextBeforeId', async () => {
  await setupBaseData();
  const ids = await publishMany(25);
  const r = await call('GET', '/api/workbench/history/publications');
  assert.equal(r.status, 200);
  assert.equal(r.json.section, 'publications');
  assert.equal(r.json.order, 'id_desc');
  assert.equal(r.json.limit, 20);
  assert.equal(r.json.items.length, 20);
  assert.equal(r.json.hasMore, true);
  assert.deepEqual(r.json.items.map((p) => p.id), ids.slice().reverse().slice(0, 20));
  // 首页最后一条（第 20 条，倒序）= 正序第 6 条 ids[5]
  assert.equal(r.json.nextBeforeId, ids[5]);
});

test('history：beforeId 逐页取回剩余记录，本轮记录不重不漏', async () => {
  await setupBaseData();
  const ids = await publishMany(25);
  const p1 = await call('GET', '/api/workbench/history/publications?limit=20');
  const p2 = await call(
    'GET',
    `/api/workbench/history/publications?limit=20&beforeId=${p1.json.nextBeforeId}`,
  );
  assert.equal(p2.json.items.length, 5);
  assert.equal(p2.json.hasMore, false);
  assert.equal(p2.json.nextBeforeId, null);
  assert.deepEqual(p2.json.items.map((p) => p.id), ids.slice(0, 5).reverse());
  const seen = [...p1.json.items, ...p2.json.items].map((p) => p.id);
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);
  assert.deepEqual(seen.slice().sort((a, b) => a - b), ids);
});

test('history：同一轮翻页期间插入新记录，本轮开始前已有记录不重不漏；新记录取首页可见', async () => {
  await setupBaseData();
  const ids = await publishMany(25);
  const p1 = await call('GET', '/api/workbench/history/publications?limit=20');
  // 第一轮翻页进行中：插入 3 条新记录（id 更大）
  const newIds = await publishMany(3);
  const p2 = await call(
    'GET',
    `/api/workbench/history/publications?limit=20&beforeId=${p1.json.nextBeforeId}`,
  );
  // 第二页仍是本轮开始前的旧 5 条，新记录不串入本轮
  assert.deepEqual(p2.json.items.map((p) => p.id), ids.slice(0, 5).reverse());
  assert.equal(p2.json.hasMore, false);
  // 刷新（重新取首页）后新记录立即可见
  const fresh = await call('GET', '/api/workbench/history/publications?limit=20');
  assert.deepEqual(
    fresh.json.items.slice(0, 3).map((p) => p.id),
    newIds.slice().reverse(),
  );
  // 新首页 20 条 = 3 新 + 旧记录最大的 17 条（旧倒序前 17 条）
  assert.equal(fresh.json.nextBeforeId, ids.slice().reverse()[16]);
});

test('history：自定义 limit（多取 1 条判定 hasMore）与上限', async () => {
  await setupBaseData();
  const ids = await publishMany(5);
  const r = await call('GET', '/api/workbench/history/publications?limit=2');
  assert.equal(r.json.items.length, 2);
  assert.equal(r.json.hasMore, true);
  assert.deepEqual(r.json.items.map((p) => p.id), ids.slice().reverse().slice(0, 2));
  assert.equal(r.json.nextBeforeId, ids.slice().reverse()[1]);
  const last = await call(
    'GET',
    `/api/workbench/history/publications?limit=2&beforeId=${r.json.nextBeforeId}`,
  );
  assert.deepEqual(last.json.items.map((p) => p.id), ids.slice().reverse().slice(2, 4));
  assert.equal(last.json.hasMore, true);
  const tail = await call(
    'GET',
    `/api/workbench/history/publications?limit=2&beforeId=${last.json.nextBeforeId}`,
  );
  assert.equal(tail.json.items.length, 1);
  assert.equal(tail.json.hasMore, false);
  assert.equal(tail.json.nextBeforeId, null);
});

test('history：非法 limit/beforeId → 400；未知区块 → 404', async () => {
  await setupBaseData();
  assert.equal((await call('GET', '/api/workbench/history/runs?limit=0')).status, 400);
  assert.equal((await call('GET', '/api/workbench/history/runs?limit=101')).status, 400);
  assert.equal((await call('GET', '/api/workbench/history/runs?limit=x')).status, 400);
  assert.equal((await call('GET', '/api/workbench/history/runs?beforeId=-3')).status, 400);
  assert.equal((await call('GET', '/api/workbench/history/runs?beforeId=abc')).status, 400);
  assert.equal((await call('GET', '/api/workbench/history/nope')).status, 404);
  // schedules 才支持 status 过滤
  assert.equal(
    (await call('GET', '/api/workbench/history/runs?status=active')).status,
    400,
  );
  assert.equal(
    (await call('GET', '/api/workbench/history/schedules?status=bogus')).status,
    400,
  );
});

test('各区块首页端点均可调用（空库返回空页结构）', async () => {
  await setupBaseData();
  for (const section of [
    'publications', 'verifications', 'reservations', 'suspensions', 'runs',
    'maintenances', 'calibrations', 'items', 'checkouts', 'schedules', 'bookings',
  ]) {
    const r = await call('GET', `/api/workbench/history/${section}`);
    assert.equal(r.status, 200, section);
    assert.deepEqual(r.json.items, [], section);
    assert.equal(r.json.hasMore, false, section);
    assert.equal(r.json.nextBeforeId, null, section);
  }
});

test('发布图可用性按读取时现状显示（失效后列表 usable=false，历史详情不改写）', async () => {
  await setupBaseData();
  const [pubId] = await publishMany(1);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 19 }]);
  const list = await call('GET', '/api/workbench/history/publications');
  const item = list.json.items.find((p) => p.id === pubId);
  assert.equal(item.usable, false);
  assert.equal(item.feasible, true); // 冻结内容不变
  const detail = await call('GET', `/api/publications/${pubId}`);
  assert.equal(detail.json.usable, false);
  assert.ok(detail.json.result);
});

test('预约/停用状态按读取时现状（phase/cancellable/revocable 随时间）', async () => {
  await setupBaseData();
  const [pubId] = await publishMany(1);
  const now = Date.now();
  const created = await call('POST', '/api/reservations', {
    batchNo: 'WB-R1',
    publicationId: pubId,
    startUtc: iso(now + 60_000),
    endUtc: iso(now + 120_000),
  });
  assert.equal(created.status, 201);
  const susp = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 1,
    reason: '送检',
    startUtc: iso(now + 60_000),
    endUtc: iso(now + 120_000),
  });
  assert.equal(susp.status, 201, JSON.stringify(susp.json));
  const resPage = await call('GET', '/api/workbench/history/reservations');
  const r0 = resPage.json.items[0];
  assert.equal(r0.phase, 'notStarted');
  assert.equal(r0.cancellable, true);
  assert.equal(r0.publicationUsable, true);
  const susPage = await call('GET', '/api/workbench/history/suspensions');
  assert.equal(susPage.json.items[0].phase, 'notStarted');
  assert.equal(susPage.json.items[0].revocable, true);
  // 取消预约后：同一条历史记录读取时状态变为 cancelled
  const cancelled = await call('POST', `/api/reservations/${r0.id}/cancel`);
  assert.equal(cancelled.status, 200);
  const resPage2 = await call('GET', '/api/workbench/history/reservations');
  assert.equal(resPage2.json.items[0].status, 'cancelled');
  assert.equal(resPage2.json.items[0].phase, 'cancelled');
  assert.equal(resPage2.json.items[0].cancellable, false);
});

async function startOneRun(runNo, deviceNo) {
  const [pubId] = await publishMany(1);
  const ver = await call('POST', '/api/verifications', { publicationId: pubId });
  const vid = ver.json.id;
  const pub = await call('GET', `/api/publications/${pubId}`);
  const entries = pub.json.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  await call('PUT', `/api/verifications/${vid}`, { version: 1, entries });
  await call('POST', `/api/verifications/${vid}/complete`);
  const now = Date.now();
  const res = await call('POST', '/api/reservations', {
    batchNo: `WB-${runNo}`,
    publicationId: pubId,
    startUtc: iso(now - 60_000),
    endUtc: iso(now + 3_600_000),
  });
  const started = await call('POST', '/api/runs', {
    runNo,
    deviceNo,
    verificationId: vid,
    reservationId: res.json.id,
  });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  return { runId: started.json.id, reservationId: res.json.id, pubId };
}

test('运行列表项为轻量字段（不含冻结快照）；冻结依据详情与 /api/runs 全量列表仍可读取', async () => {
  await setupBaseData();
  const { runId, reservationId } = await startOneRun('WB-RUN-1', 'DEV-1');
  const page = await call('GET', '/api/workbench/history/runs');
  assert.equal(page.json.items.length, 1);
  const item = page.json.items[0];
  assert.equal(item.id, runId);
  assert.equal(item.status, 'running');
  assert.equal(item.frozenBasis.publication.currentlyUsable, true);
  assert.equal(item.frozenBasis.reservationCurrentStatus, 'active');
  // 列表不带完整冻结快照（详情按需读取）
  assert.equal(item.frozenBasis.publication.config, undefined);
  assert.equal(item.frozenBasis.publication.result, undefined);
  assert.equal(item.frozenBasis.verification, undefined);
  assert.equal(item.frozenBasis.reservation, undefined);
  assert.equal(item.frozenBasis.calibration, undefined);
  // 详情接口仍是完整冻结依据（未改写）
  const detail = await call('GET', `/api/runs/${runId}`);
  assert.ok(detail.json.frozenBasis.publication.config);
  assert.ok(detail.json.frozenBasis.publication.result);
  assert.ok(detail.json.frozenBasis.verification);
  assert.equal(detail.json.frozenBasis.reservation.id, reservationId);
  // 旧全量接口保留且仍给完整冻结依据
  const oldList = await call('GET', '/api/runs');
  assert.ok(oldList.json[0].frozenBasis.publication.config);
  // 预约取消后：列表读取时展示预约当前状态，但运行冻结依据不改写
  await call('POST', `/api/reservations/${reservationId}/cancel`).catch(() => {});
  // 进行中预约无法取消（已开始）→ 改为通过完成运行后校验预约状态字段仍可读取
  const done = await call('POST', `/api/runs/${runId}/complete`, { outcome: 'completed' });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  const page2 = await call('GET', '/api/workbench/history/runs');
  assert.equal(page2.json.items[0].status, 'completed');
  assert.equal(page2.json.items[0].frozenBasis.publication.currentlyUsable, true);
});

test('运行的冻结依据不被配置变化改写，列表仅按读取时现状标记可用性', async () => {
  await setupBaseData();
  const { runId } = await startOneRun('WB-RUN-2', 'DEV-2');
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 18 }]);
  const page = await call('GET', '/api/workbench/history/runs');
  const item = page.json.items.find((r) => r.id === runId);
  assert.equal(item.frozenBasis.publication.currentlyUsable, false);
  const detail = await call('GET', '/api/runs/${runId}'.replace('${runId}', runId));
  // 冻结依据内容不变，仅展示用 currentlyUsable 按现状
  assert.ok(detail.json.frozenBasis.publication.result);
  assert.equal(detail.json.frozenBasis.publication.currentlyUsable, false);
});

test('运行完成后可执行状态（设备状态）按读取时现状给出', async () => {
  await setupBaseData();
  const { runId } = await startOneRun('WB-RUN-3', 'DEV-3');
  let ov = (await call('GET', '/api/workbench/overview')).json;
  const dev0 = ov.actionable.devices.find((d) => d.deviceNo === 'DEV-3');
  assert.equal(dev0.running, true);
  await call('POST', `/api/runs/${runId}/complete`, { outcome: 'aborted' });
  ov = (await call('GET', '/api/workbench/overview')).json;
  const dev1 = ov.actionable.devices.find((d) => d.deviceNo === 'DEV-3');
  assert.equal(dev1.running, false);
  assert.equal(dev1.countedRuns, 1);
});

test('旧接口 GET /api/state 完整响应与列表/详情接口保持不变', async () => {
  await setupBaseData();
  const { runId } = await startOneRun('WB-RUN-4', 'DEV-4');
  const s = await call('GET', '/api/state');
  for (const key of [
    'data', 'currentHash', 'draft', 'publications', 'verifications',
    'reservations', 'suspensions', 'runs', 'devices', 'maintenances',
    'calibrations', 'items', 'checkouts', 'schedules', 'bookings',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(s.json, key), key);
  }
  assert.ok(s.json.runs.find((r) => r.id === runId).frozenBasis.publication.config);
  // 写入接口仍可用
  const cfgR = await call('PUT', '/api/config', cfg);
  assert.equal(cfgR.status, 200);
});
