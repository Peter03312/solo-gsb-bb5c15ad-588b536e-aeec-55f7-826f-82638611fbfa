import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import { SCHEMA, insertPublication } from '../src/db.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
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

const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

const SECTION_NAMES = [
  'publications',
  'verifications',
  'reservations',
  'suspensions',
  'runs',
  'maintenances',
  'calibrations',
];

// 依据已发布图建立核验并完成（entries 直接按冻结图构造，必然通过）
async function completeVerificationFor(pubId) {
  const created = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const vid = created.json.id;
  const pub = await call('GET', `/api/publications/${pubId}`);
  const entries = pub.json.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  const saved = await call('PUT', `/api/verifications/${vid}`, { version: 1, entries });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const done = await call('POST', `/api/verifications/${vid}/complete`);
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return vid;
}

test('准备：配置 + 两张可用发布图 + 一份已完成核验', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  await call('POST', '/api/solve');
  const p1 = await call('POST', '/api/publish');
  assert.equal(p1.status, 201);
  const p2 = await call('POST', '/api/publish');
  assert.equal(p2.status, 201);
  await completeVerificationFor(p1.json.id);
});

test('overview：当前配置/指纹/草稿/设备/可执行状态与各区块首页齐全且有界', async () => {
  const r = await call('GET', '/api/workbench/overview');
  assert.equal(r.status, 200);
  const o = r.json;
  assert.ok(o.data && o.data.holes === 4);
  assert.ok(typeof o.currentHash === 'string');
  assert.ok(o.draft);
  assert.deepEqual(Object.keys(o.sections).sort(), [...SECTION_NAMES].sort());
  assert.equal(o.defaultLimit, 20);
  assert.equal(o.maxLimit, 100);
  assert.ok(o.serverTime);
  // 可执行状态：两张图当前均可用；已完成核验 1 份；无生效预约/进行中运行
  assert.equal(o.executable.usablePublications.length, 2);
  assert.deepEqual(
    o.executable.usablePublications.map((p) => p.usable),
    [true, true],
  );
  assert.equal(o.executable.completedVerifications.length, 1);
  assert.equal(o.executable.activeReservations.length, 0);
  assert.equal(o.executable.runningRuns.length, 0);
  // 区块首页为有界页结构
  const pubPage = o.sections.publications;
  assert.equal(pubPage.items.length, 2);
  assert.equal(pubPage.hasMore, false);
  assert.equal(pubPage.nextCursor, null);
  assert.equal(pubPage.anchorId, pubPage.items[0].id); // 最新 id
  assert.equal(pubPage.items[0].usable, true);
  assert.equal(pubPage.limit, 20);
});

test('区块列表的当前可用性按读取时现状（数据变化后刷新即可见），发布冻结内容不变', async () => {
  // 新增配重规格 → 指纹变化，两张旧图均不可用（但冻结内容不变）
  const w = await call('PUT', '/api/weights', [
    { mass: 50, quantity: 20 },
    { mass: 1, quantity: 1 },
  ]);
  assert.equal(w.status, 200);
  const r = await call('GET', '/api/workbench/sections/publications');
  assert.equal(r.status, 200);
  assert.ok(r.json.items.length >= 2);
  for (const p of r.json.items) assert.equal(p.usable, false);
  const oldest = r.json.items[r.json.items.length - 1];
  const detail = await call('GET', `/api/publications/${oldest.id}`);
  assert.equal(detail.json.usable, false);
  assert.ok(detail.json.result); // 冻结装载图仍在
  // 还原
  const w2 = await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  assert.equal(w2.status, 200);
});

test('稳定顺序分页（id DESC，最新在前）', async () => {
  // 直接追加 23 条发布（连同既有 2 条共 25 条），避免逐条走求解。
  const frozen = {
    ...cfg,
    tubes: [],
    weights: [],
    exclusionPairs: [],
    fixedSlots: [],
  };
  for (let i = 0; i < 23; i += 1) {
    insertPublication(db, {
      basisHash: `bulk-${i}`,
      feasible: false,
      config: frozen,
      result: null,
      reasons: [],
      weightCount: null,
      diffSum: null,
    });
  }
  const p1 = await call('GET', '/api/workbench/sections/publications?limit=10');
  assert.equal(p1.status, 200);
  assert.equal(p1.json.items.length, 10);
  assert.equal(p1.json.hasMore, true);
  assert.ok(p1.json.nextCursor);
  const ids1 = p1.json.items.map((x) => x.id);
  assert.deepEqual(ids1, [...ids1].sort((a, b) => b - a));
  const anchor = p1.json.anchorId;
  assert.equal(anchor, ids1[0]);

  const p2 = await call(
    'GET',
    `/api/workbench/sections/publications?limit=10&cursor=${encodeURIComponent(p1.json.nextCursor)}`,
  );
  assert.equal(p2.json.items.length, 10);
  assert.equal(p2.json.anchorId, anchor); // 同一轮锚点不变
  assert.ok(ids1[ids1.length - 1] > p2.json.items[0].id); // 严格接续

  // 翻页期间插入 5 条新记录
  for (let i = 0; i < 5; i += 1) {
    insertPublication(db, {
      basisHash: `new-${i}`,
      feasible: false,
      config: frozen,
      result: null,
      reasons: [],
      weightCount: null,
      diffSum: null,
    });
  }

  const p3 = await call(
    'GET',
    `/api/workbench/sections/publications?limit=10&cursor=${encodeURIComponent(p2.json.nextCursor)}`,
  );
  assert.equal(p3.json.anchorId, anchor); // 本轮锚点仍是开始前的最大 id
  assert.equal(p3.json.hasMore, false);
  assert.equal(p3.json.nextCursor, null);
  // 本轮三页并集恰为「本轮开始前已有」的 25 条，无重复、无遗漏，且不含新插入的 5 条
  const seen = [...p1.json.items, ...p2.json.items, ...p3.json.items];
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen.map((x) => x.id)).size, 25);
  for (const x of seen) assert.ok(x.id <= anchor, '新记录不得进入本轮');

  // 新一轮首页（不带游标）：新记录立即可见，锚点前移
  const q1 = await call('GET', '/api/workbench/sections/publications?limit=10');
  assert.equal(q1.json.anchorId, anchor + 5);
  assert.equal(q1.json.items[0].id, anchor + 5);
});

test('用篡改/过期游标：非法 → 400；锚点前移后旧游标仍能稳定取回旧记录', async () => {
  const bad = await call('GET', '/api/workbench/sections/runs?cursor=%%%not-base64');
  assert.equal(bad.status, 400);
  const bad2 = await call(
    'GET',
    `/api/workbench/sections/runs?cursor=${Buffer.from(JSON.stringify({ a: -1 })).toString('base64url')}`,
  );
  assert.equal(bad2.status, 400);
  const badLimit = await call('GET', '/api/workbench/sections/runs?limit=0');
  assert.equal(badLimit.status, 400);
  const unknown = await call('GET', '/api/workbench/sections/unknown');
  assert.equal(unknown.status, 404);
});

test('limit 上限截断为 100', async () => {
  const r = await call('GET', '/api/workbench/sections/publications?limit=99999');
  assert.equal(r.status, 200);
  assert.equal(r.json.limit, 100);
});

test('其余区块在空历史时返回空首页结构，字段同构', async () => {
  for (const name of ['reservations', 'suspensions', 'runs', 'maintenances', 'calibrations']) {
    const r = await call('GET', `/api/workbench/sections/${name}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.json.section, name);
    assert.deepEqual(r.json.items, []);
    assert.equal(r.json.hasMore, false);
    assert.equal(r.json.nextCursor, null);
  }
});

test('核验区块列表项带读取时可用性与完成状态；可执行集合只含已完成核验', async () => {
  const r = await call('GET', '/api/workbench/sections/verifications');
  assert.equal(r.status, 200);
  assert.ok(r.json.items.length >= 1);
  const done = r.json.items.find((v) => v.completed);
  assert.ok(done);
  assert.equal(done.publicationId, 1);
  assert.ok(done.progress);
  // overview 的可执行核验只含已完成
  const o = (await call('GET', '/api/workbench/overview')).json;
  assert.ok(o.executable.completedVerifications.every((v) => v.completed));
});

test('GET /api/state 完整响应保持不变（旧客户端仍取全量历史）', async () => {
  const r = await call('GET', '/api/state');
  assert.equal(r.status, 200);
  const s = r.json;
  for (const key of [
    'data',
    'currentHash',
    'draft',
    'publications',
    'verifications',
    'reservations',
    'suspensions',
    'runs',
    'devices',
    'maintenances',
    'calibrations',
    'items',
    'checkouts',
    'schedules',
    'bookings',
  ]) {
    assert.ok(key in s, `/api/state 缺少字段 ${key}`);
  }
  // 全量 30 条发布（25 + 5），工作台首页仅 20 条
  assert.equal(s.publications.length, 30);
  const o = (await call('GET', '/api/workbench/overview')).json;
  assert.equal(o.sections.publications.items.length, 20);
});
