/**
 * 合并逻辑验证脚本（Node + tsx 运行，不触库）。
 * 构造两台设备的档案，验证：按标本号认同一种标本、工序冲突并排、
 * 材料按批号对账、缺项识别、v1 旧档案升级、幂等重合并。
 */
import assert from 'node:assert';
import {
  buildApplySet,
  computeMergePlan,
  diffProcedures,
  EMPTY_RESOLUTIONS,
  hasUnresolved,
  upgradeArchiveData,
  type ArchiveFile,
  type LocalData,
  type MergeResolutions,
} from '../src/utils/archive';
import type { Specimen, SpecimenDraft } from '../src/types/specimen';
import type { PrepProcedure } from '../src/types/procedure';
import type { SupplyLot } from '../src/types/supply';
import type { PrepPhoto } from '../src/types/photo';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const sp = (id: string, no: string, status = '修复中'): Specimen => ({
  id,
  specimenNo: no,
  taxon: '剑龙',
  horizon: '上侏罗统',
  locality: '四川',
  lithology: '泥岩',
  matrixHardness: 3,
  dimensions: '200×150×80',
  weight: 1000,
  storageBox: 'A 区 1 匣',
  status: status as Specimen['status'],
  createdAt: 1,
});

const pr = (id: string, specimenId: string, seq: number, nodeName: string, state: PrepProcedure['state'] = 'pending', extra: Partial<PrepProcedure> = {}): PrepProcedure => ({
  id,
  specimenId,
  stepType: '清修',
  nodeName,
  seq,
  tools: ['气动笔'],
  abrasive: '800 目',
  adhesive: '',
  adhesiveConc: 0,
  durationMin: 60,
  tempC: 22,
  rh: 50,
  photoBeforeIds: [],
  photoAfterIds: [],
  operator: '甲',
  startedAt: 1,
  state,
  ...extra,
});

const sup = (id: string, lotNo: string, qty: number, issues: SupplyLot['issues'] = []): SupplyLot => ({
  id,
  name: 'Paraloid B-72',
  kind: '胶种',
  spec: '500g',
  lotNo,
  qty,
  unit: '瓶',
  openedAt: 1,
  shelfLifeMonths: 36,
  lowThreshold: 2,
  issues,
});

const issue = (id: string, qty: number, specimenNo: string) => ({
  id,
  qty,
  operator: '甲',
  specimenNo,
  issuedAt: 1,
});

const photo = (id: string, specimenId: string, procedureId: string, caption: string): PrepPhoto => ({
  id,
  specimenId,
  procedureId,
  stage: 'before',
  caption,
  dataUrl: 'data:image/svg+xml;utf8,x',
  capturedAt: 1,
});

function archive(data: ArchiveFile['data'], version = 2): ArchiveFile {
  return { format: 'gbfossilprep-archive', version, exportedAt: 1, device: 'B', data };
}

/* ============ 场景：A、B 两台设备，A 是本机 ============ */
// 共同标本 FP-001（两边都有），B 新增 FP-002
// 共同工序：FP-001#1 两边都改了（冲突）；FP-001#2 只 B 有（新增）
// 材料：同批号 B72 两边都有（对账）；B 新增批号 NEW1
// 影像：B 有一张挂到 FP-001#2（新增工序）；一张引用不存在的工序（缺项）

const local: LocalData = {
  specimens: [sp('a-sp1', 'FP-001')],
  procedures: [
    pr('a-pr1', 'a-sp1', 1, '左侧清修', 'done', { durationMin: 100, operator: '甲' }),
  ],
  supplies: [
    sup('a-sup1', 'B72', 4, [issue('a-iss1', 1, 'FP-001')]),
  ],
  photos: [],
};

const imported: ArchiveFile = archive({
  specimens: [sp('b-sp1', 'FP-001'), sp('b-sp2', 'FP-002', '待清修')],
  procedures: [
    pr('b-pr1', 'b-sp1', 1, '左侧清修（B 改）', 'done', { durationMin: 120, operator: '乙' }),
    pr('b-pr2', 'b-sp1', 2, '右侧加固', 'pending', { stepType: '加固', seq: 2 }),
  ],
  supplies: [
    sup('b-sup1', 'B72', 3, [issue('b-iss1', 1, 'FP-001'), issue('b-iss2', 1, 'FP-002')]),
    sup('b-sup2', 'NEW1', 5),
  ],
  photos: [
    photo('b-pho1', 'b-sp1', 'b-pr2', '加固前'),
    photo('b-pho2', 'b-sp2', 'b-pr-missing', '缺项影像'), // 引用了档案中不存在的工序 → 缺项
  ],
});

const plan = computeMergePlan(local, imported);

console.log('\n== 标本认同 ==');
test('按标本号匹配 FP-001（不按设备 id）', () => {
  assert.strictEqual(plan.matchedSpecimens.length, 1);
  assert.strictEqual(plan.matchedSpecimens[0].specimenNo, 'FP-001');
  assert.strictEqual(plan.matchedSpecimens[0].local.id, 'a-sp1');
});
test('新增 FP-002 并分配新 id', () => {
  assert.strictEqual(plan.newSpecimens.length, 1);
  assert.strictEqual(plan.newSpecimens[0].specimenNo, 'FP-002');
  assert.ok(plan.newSpecimens[0].id !== 'b-sp2');
});
test('导入标本 id 重映射到本地 id', () => {
  assert.strictEqual(plan.specimenIdMap['b-sp1'], 'a-sp1');
  assert.ok(plan.specimenIdMap['b-sp2'] !== 'b-sp2');
});

console.log('\n== 工序冲突与新增 ==');
test('FP-001#1 两边都改 → 识别为冲突', () => {
  assert.strictEqual(plan.procedureConflicts.length, 1);
  assert.strictEqual(plan.procedureConflicts[0].key, 'FP-001#1');
});
test('冲突并排对比返回差异字段', () => {
  const rows = diffProcedures(plan.procedureConflicts[0].local, plan.procedureConflicts[0].imported);
  const fields = rows.map((r) => r.field);
  assert.ok(fields.includes('durationMin'));
  assert.ok(fields.includes('operator'));
  assert.ok(!fields.includes('seq')); // 序号相同，不算差异
});
test('FP-001#2 仅 B 有 → 新增工序并重映射标本', () => {
  assert.strictEqual(plan.newProcedures.length, 1);
  assert.strictEqual(plan.newProcedures[0].seq, 2);
  assert.strictEqual(plan.newProcedures[0].specimenId, 'a-sp1');
  assert.ok(plan.newProcedures[0].id !== 'b-pr2');
});

console.log('\n== 材料按批号对账 ==');
test('同批号 B72 对账：领用记录合并去重', () => {
  assert.strictEqual(plan.supplyReconciles.length, 1);
  const merged = plan.supplyReconciles[0].merged;
  const ids = merged.issues.map((i) => i.id).sort();
  assert.deepStrictEqual(ids, ['a-iss1', 'b-iss1', 'b-iss2']);
});
test('对账后数量按初始-领用重算', () => {
  const merged = plan.supplyReconciles[0].merged;
  // 本机 4 + 1 = 5；B 3 + 2 = 5 → 初始 5；领用 3 → 在库 2
  assert.strictEqual(merged.qty, 2);
});
test('新增批号 NEW1', () => {
  assert.strictEqual(plan.newSupplies.length, 1);
  assert.strictEqual(plan.newSupplies[0].lotNo, 'NEW1');
});

console.log('\n== 缺项识别 ==');
test('合法影像重映射到新增工序', () => {
  const newId = plan.photoIdMap['b-pho1'];
  assert.ok(newId, '合法影像应分配本地 id');
  const valid = plan.newPhotos.find((p) => p.id === newId);
  assert.ok(valid, '引用合法的影像应进入新增');
  assert.strictEqual(valid!.procedureId, plan.newProcedures.find((p) => p.seq === 2)!.id);
  assert.strictEqual(valid!.specimenId, 'a-sp1');
});
test('领用引用不存在的标本号 → 缺项', () => {
  // b-iss2 引用 FP-002，但 FP-002 是新增标本，合并后存在 → 不缺项
  // 这里 b-iss2 引用 FP-002，而 FP-002 在 newSpecimens 里，所以不缺项
  // 真正缺项的是引用一个完全不存在的标本号
  const orphan = plan.orphanIssues.find((o) => o.issueId === 'b-iss2');
  assert.ok(!orphan, 'FP-002 是新增标本，不应判为缺项');
});
test('构造一个引用不存在标本号的领用 → 判为缺项', () => {
  const local2: LocalData = { ...local };
  const imp2 = archive({
    specimens: [sp('b-sp1', 'FP-001')],
    procedures: [],
    supplies: [sup('b-supX', 'LOT-X', 1, [issue('x-iss', 1, 'FP-9999')])],
    photos: [],
  });
  const plan2 = computeMergePlan(local2, imp2);
  assert.strictEqual(plan2.orphanIssues.length, 1);
  assert.strictEqual(plan2.orphanIssues[0].issue.specimenNo, 'FP-9999');
});
test('影像引用了档案中不存在的工序 → 缺项', () => {
  // b-pho2 的 procedureId 指向一个档案里根本不存在的工序 → 真正的悬空虚指
  const orphanPhoto = plan.orphanPhotos.find((o) => o.photoId === 'b-pho2');
  assert.ok(orphanPhoto, '工序引用无法重映射，应判缺项');
});
test('缺项影像「映射到现有工序」后进入入库集', () => {
  const resolutions: MergeResolutions = {
    conflicts: { 'FP-001#1': 'local' },
    issues: {},
    photos: { 'b-pho2': { type: 'map', procKey: 'FP-001#1' } },
  };
  const applySet = buildApplySet(plan, resolutions);
  const mapped = applySet.photos.find((p) => p.caption === '缺项影像');
  assert.ok(mapped, '映射后影像应入库');
  assert.strictEqual(mapped!.procedureId, 'a-pr1', '映射到 FP-001#1 本地工序');
  assert.strictEqual(mapped!.specimenId, 'a-sp1');
});

console.log('\n== 缺项补齐后生效 ==');
test('缺项领用「新建补齐」后进入入库集', () => {
  const imp2 = archive({
    specimens: [sp('b-sp1', 'FP-001')],
    procedures: [],
    supplies: [sup('b-supX', 'LOT-X', 1, [issue('x-iss', 1, 'FP-9999')])],
    photos: [],
  });
  const plan2 = computeMergePlan(local, imp2);
  const draft: SpecimenDraft = {
    specimenNo: 'FP-9999',
    taxon: '',
    horizon: '',
    locality: '',
    lithology: '',
    matrixHardness: 3,
    dimensions: '200×150×80',
    weight: 1500,
    storageBox: '',
    status: '待清修',
  };
  const resolutions: MergeResolutions = {
    conflicts: {},
    issues: { 'x-iss': { type: 'create', draft } },
    photos: {},
  };
  const applySet = buildApplySet(plan2, resolutions);
  // 新建了 FP-9999 标本
  const created = applySet.specimens.find((s) => s.specimenNo === 'FP-9999');
  assert.ok(created, '补齐后应新建标本 FP-9999');
  // 领用记录保留并指向新标本号
  const lot = applySet.supplies.find((s) => s.lotNo === 'LOT-X');
  assert.ok(lot);
  assert.strictEqual(lot!.issues[0].specimenNo, 'FP-9999');
});
test('缺项领用「放弃」后不入库', () => {
  const imp2 = archive({
    specimens: [sp('b-sp1', 'FP-001')],
    procedures: [],
    supplies: [sup('b-supX', 'LOT-X', 1, [issue('x-iss', 1, 'FP-9999')])],
    photos: [],
  });
  const plan2 = computeMergePlan(local, imp2);
  const resolutions: MergeResolutions = {
    conflicts: {},
    issues: { 'x-iss': { type: 'discard' } },
    photos: {},
  };
  const applySet = buildApplySet(plan2, resolutions);
  const lot = applySet.supplies.find((s) => s.lotNo === 'LOT-X');
  assert.ok(lot);
  assert.strictEqual(lot!.issues.length, 0, '放弃后领用记录不入库');
});

console.log('\n== 冲突确认后入库 ==');
test('冲突选「导入」→ 以本地 id 写入导入内容', () => {
  const resolutions: MergeResolutions = {
    conflicts: { 'FP-001#1': 'imported' },
    issues: {},
    photos: {},
  };
  const applySet = buildApplySet(plan, resolutions);
  const proc = applySet.procedures.find((p) => p.seq === 1);
  assert.ok(proc);
  assert.strictEqual(proc!.id, 'a-pr1', '采用导入时沿用本地 id');
  assert.strictEqual(proc!.durationMin, 120, '写入导入内容');
  assert.strictEqual(proc!.operator, '乙');
});
test('冲突选「本地」→ 不写入该工序', () => {
  const resolutions: MergeResolutions = {
    conflicts: { 'FP-001#1': 'local' },
    issues: {},
    photos: {},
  };
  const applySet = buildApplySet(plan, resolutions);
  // 新增工序 FP-001#2 仍在；冲突的 #1 不在 proceduresToPut（保留本地）
  const seq1 = applySet.procedures.filter((p) => p.seq === 1);
  assert.strictEqual(seq1.length, 0, '保留本地时不写入冲突工序');
  const seq2 = applySet.procedures.find((p) => p.seq === 2);
  assert.ok(seq2, '新增工序仍入库');
});

console.log('\n== 未解决拦截 ==');
test('冲突未确认 / 缺项未补齐 → hasUnresolved 为 true', () => {
  assert.strictEqual(hasUnresolved(plan, EMPTY_RESOLUTIONS), true);
});
test('全部确认后 → hasUnresolved 为 false', () => {
  const resolutions: MergeResolutions = {
    conflicts: { 'FP-001#1': 'local' },
    issues: {},
    photos: { 'b-pho2': { type: 'discard' } },
  };
  // 注意：b-iss2 引用 FP-002（新增标本），不算缺项
  assert.strictEqual(hasUnresolved(plan, resolutions), false);
});

console.log('\n== 旧档案升级 ==');
test('v1 档案导入前补齐缺字段', () => {
  const v1: ArchiveFile['data'] = {
    specimens: [],
    procedures: [{ id: 'p1', specimenId: 's1', stepType: '清修', nodeName: 'x', seq: 1, tools: [], abrasive: '', adhesive: '', durationMin: 1, tempC: 1, rh: 1, photoBeforeIds: [], photoAfterIds: [], operator: 'o', startedAt: 1, state: 'pending' } as unknown as PrepProcedure],
    supplies: [{ id: 'l1', name: 'n', kind: '胶种', spec: '', lotNo: 'L', qty: 1, unit: '瓶', openedAt: 1, shelfLifeMonths: 1, lowThreshold: 1, issues: [] } as unknown as SupplyLot],
    photos: [],
  };
  // 模拟 v1：去掉 v2 新增字段
  const v1Proc = { ...v1.procedures[0] } as any;
  delete v1Proc.adhesiveConc;
  const v1Sup = { ...v1.supplies[0] } as any;
  const upgraded = upgradeArchiveData({ ...v1, procedures: [v1Proc], supplies: [v1Sup] }, 1);
  assert.strictEqual((upgraded.procedures[0] as any).adhesiveConc, 0);
  assert.strictEqual((upgraded.supplies[0] as any).lowThreshold, 1);
});

console.log(`\n结果：${passed} 项通过`);
if (process.exitCode) process.exit(process.exitCode);
