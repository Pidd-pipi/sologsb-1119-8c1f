/**
 * 双机合并引擎的纯逻辑冒烟测试（不依赖浏览器 / IndexedDB）。
 * 运行：node --experimental-strip-types src/utils/merge.test.ts
 */
import assert from 'node:assert/strict';
import { buildMergeReport, parseArchive, resolveConflict } from './merge';
import type { ArchiveBundle } from '../types/merge';
import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import type { SupplyLot } from '../types/supply';
import type { PrepPhoto } from '../types/photo';

let passed = 0;
function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    });
}

function specimen(over: Partial<Specimen> & Pick<Specimen, 'id' | 'specimenNo'>): Specimen {
  return {
    taxon: 'T',
    horizon: 'H',
    locality: 'L',
    lithology: '岩性',
    matrixHardness: 3,
    dimensions: '10×10×10',
    weight: 100,
    storageBox: 'A',
    status: '待清修',
    createdAt: 1000,
    ...over,
  };
}

function proc(over: Partial<PrepProcedure> & Pick<PrepProcedure, 'id' | 'specimenId' | 'seq' | 'startedAt'>): PrepProcedure {
  return {
    stepType: '清修',
    nodeName: '节点',
    tools: [],
    abrasive: '',
    adhesive: '',
    adhesiveConc: 0,
    durationMin: 10,
    tempC: 20,
    rh: 50,
    photoBeforeIds: [],
    photoAfterIds: [],
    operator: '甲',
    state: 'pending',
    ...over,
  };
}

function lot(over: Partial<SupplyLot> & Pick<SupplyLot, 'id' | 'lotNo' | 'qty' | 'issues'>): SupplyLot {
  return {
    name: '材料',
    kind: '胶种',
    spec: '',
    unit: '瓶',
    openedAt: 1000,
    shelfLifeMonths: 24,
    lowThreshold: 1,
    ...over,
  };
}

function photo(over: Partial<PrepPhoto> & Pick<PrepPhoto, 'id' | 'specimenId' | 'procedureId' | 'capturedAt' | 'caption'>): PrepPhoto {
  return { stage: 'before', dataUrl: 'data:x', ...over };
}

function bundle(parts: Partial<ArchiveBundle>): ArchiveBundle {
  return {
    magic: 'gbfossilprep-archive',
    format: 1,
    device: '乙机',
    exportedAt: 5000,
    specimens: [],
    procedures: [],
    supplies: [],
    photos: [],
    ...parts,
  };
}

const t1 = Date.now();

const localSpecimen = specimen({ id: 's-local', specimenNo: 'FP-1' });
const incSpecimen = specimen({ id: 's-inc', specimenNo: 'FP-1', status: '修复中', weight: 99 });

const localProcDone = proc({
  id: 'p-local',
  specimenId: 's-local',
  seq: 1,
  startedAt: t1,
  nodeName: '甲机版本',
  state: 'done',
  operator: '甲',
});
const incProcDone = proc({
  id: 'p-inc',
  specimenId: 's-inc',
  seq: 1,
  startedAt: t1,
  nodeName: '乙机版本',
  state: 'done',
  operator: '乙',
  photoAfterIds: ['ph-new'],
});

const incOnlySpecimen = specimen({ id: 's-inc2', specimenNo: 'FP-2', status: '修复中' });
const incOnlyProc = proc({ id: 'p-inc2', specimenId: 's-inc2', seq: 1, startedAt: t1 + 1, nodeName: '乙机新节点' });

const localLotRow = lot({ id: 'l-local', lotNo: 'LOT-A', qty: 5, issues: [] });
const incLotRow = lot({
  id: 'l-inc',
  lotNo: 'LOT-A',
  qty: 9,
  issues: [
    { id: 'i1', lotNo: 'LOT-A', qty: 2, operator: '乙', specimenNo: 'FP-1', issuedAt: 4000 },
    { id: 'i-dup', lotNo: 'LOT-A', qty: 1, operator: '甲', specimenNo: 'FP-1', issuedAt: 3000 },
  ],
});
const localWithDupIssue = lot({
  id: 'l-local',
  lotNo: 'LOT-A',
  qty: 4,
  issues: [{ id: 'i0', lotNo: 'LOT-A', qty: 1, operator: '甲', specimenNo: 'FP-1', issuedAt: 3000 }],
});
const incNewLot = lot({
  id: 'l-new',
  lotNo: 'LOT-B',
  qty: 2,
  issues: [{ id: 'i2', lotNo: 'LOT-B', qty: 1, operator: '乙', specimenNo: 'FP-2', issuedAt: 4100 }],
});
// 残缺档案：某领用引用的批号 LOT-MISSING 在两边批次表里都不存在（批次未随档案带回）
const incBrokenLot = lot({
  id: 'l-broken',
  lotNo: 'LOT-C',
  qty: 1,
  issues: [{ id: 'i3', lotNo: 'LOT-MISSING', qty: 1, operator: '乙', specimenNo: 'FP-1', issuedAt: 4200 }],
});

const linkedPhoto = photo({ id: 'ph-new', specimenId: 's-inc', procedureId: 'p-inc', capturedAt: 7000, caption: '新图' });
const orphanPhoto = photo({ id: 'ph-orphan', specimenId: 's-gone', procedureId: 'p-gone', capturedAt: 7100, caption: '孤图' });

const local = {
  specimens: [localSpecimen],
  procedures: [localProcDone],
  supplies: [
    lot({
      id: 'l-local',
      lotNo: 'LOT-A',
      qty: 4,
      issues: [{ id: 'i0', lotNo: 'LOT-A', qty: 1, operator: '甲', specimenNo: 'FP-1', issuedAt: 3000 }],
    }),
  ],
  photos: [],
};

const incoming = bundle({
  specimens: [incSpecimen, incOnlySpecimen],
  procedures: [incProcDone, incOnlyProc],
  supplies: [incLotRow, incNewLot, incBrokenLot],
  photos: [linkedPhoto, orphanPhoto],
});

await test('标本按标本号认同一件，字段差异被标出；对端独有标本计新增', async () => {
  const r = await buildMergeReport(local, incoming);
  const fp1 = r.specimens.find((s) => s.specimenNo === 'FP-1')!;
  assert.equal(fp1.status, 'changed');
  const fields = fp1.diffs.map((d) => d.field).sort();
  assert.deepEqual(fields, ['status', 'weight']);
  const fp2 = r.specimens.find((s) => s.specimenNo === 'FP-2')!;
  assert.equal(fp2.status, 'incoming-only');
});

await test('同一工序两边都改过 -> 冲突且默认未裁决；仅对端有的节点计新增', async () => {
  const r = await buildMergeReport(local, incoming);
  assert.equal(r.procedures.conflicts.length, 1);
  assert.equal(r.procedures.conflicts[0].specimenNo, 'FP-1');
  assert.equal(r.procedures.conflicts[0].seq, 1);
  assert.equal(r.hasUnresolvedConflicts, true);
  assert.equal(r.procedures.addedFromIncoming, 1);
  const resolved = resolveConflict(r, r.procedures.conflicts[0].id, 'take-incoming');
  assert.equal(resolved.hasUnresolvedConflicts, false);
  assert.equal(resolved.procedures.conflicts[0].resolution, 'take-incoming');
});

await test('材料按批号对账：新领用 apply、指纹重复 duplicate、缺批号 blocked', async () => {
  const r = await buildMergeReport(local, incoming);
  const a = r.lots.find((l) => l.lotNo === 'LOT-A')!;
  assert.equal(a.status, 'matched');
  const statuses = new Map(a.issues.map((i) => [i.issue.id, i.status]));
  assert.equal(statuses.get('i1'), 'apply');
  assert.equal(statuses.get('i-dup'), 'duplicate');
  const b = r.lots.find((l) => l.lotNo === 'LOT-B')!;
  assert.equal(b.status, 'incoming-only');
  const missing = r.lots.find((l) => l.lotNo === 'LOT-MISSING')!;
  assert.ok(missing.issues.some((i) => i.status === 'blocked'));
  assert.deepEqual(r.missingLotNos, ['LOT-MISSING']);
});

await test('影像按标本+节点重挂；引用缺失的列入游离，未处理前阻塞确认', async () => {
  const r = await buildMergeReport(local, incoming);
  assert.equal(r.photos.added, 1);
  assert.equal(r.photos.orphans.length, 1);
  assert.equal(r.photos.orphans[0].reason, 'no-specimen');
  assert.equal(r.hasOrphanPhotos, true);
});

await test('解析：老格式无 magic 头也接受（旧档案升级后继续参与）', () => {
  const legacy = JSON.stringify({
    specimens: [specimen({ id: 'x', specimenNo: 'FP-9' })],
    procedures: [],
    supplies: [],
    photos: [],
  });
  const parsed = parseArchive(legacy);
  assert.equal(parsed.specimens.length, 1);
  assert.equal(parsed.device, '未知设备');
});

await test('解析：magic 不匹配 / 更高结构版本 / 非法 JSON 均拒绝', () => {
  assert.throws(() => parseArchive('{"magic":"other"}'), /文件标识不匹配/);
  assert.throws(() => parseArchive('{"format":99,"specimens":[]}'), /结构版本/);
  assert.throws(() => parseArchive('{bad json'), /JSON/);
});

console.log(`\n合并引擎测试全部通过：${passed} 项`);
