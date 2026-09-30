/**
 * 合并的落库层：导出本机档案、在单个 Dexie 事务里应用确认后的合并结果。
 * 事务中任何一步失败都会整体回滚 —— 不覆盖、不留半截数据，可重新选文件重试。
 */
import { db } from './db';
import { newId } from './id';
import { clone } from './merge';
import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import type { SupplyLot } from '../types/supply';
import type { PrepPhoto, PhotoStage } from '../types/photo';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_MAGIC,
  type ArchiveBundle,
  type MergeReport,
} from '../types/merge';
import type { MergeApplyResult, MergeChoices, OrphanPhotoChoice } from './merge';
const DEVICE_KEY = 'gbfossilprep:device';

export function getDeviceName(): string {
  try {
    return window.localStorage.getItem(DEVICE_KEY) || '';
  } catch {
    return '';
  }
}

export function setDeviceName(name: string): void {
  try {
    window.localStorage.setItem(DEVICE_KEY, name);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 导出本机四张表为整包档案（领用记录强制盖批号，保证对端能按批号对账） */
export async function exportArchive(device: string): Promise<ArchiveBundle> {
  const [specimens, procedures, supplies, photos] = await Promise.all([
    db.specimens.toArray(),
    db.procedures.toArray(),
    db.supplies.toArray(),
    db.photos.toArray(),
  ]);
  supplies.forEach((lot) => lot.issues.forEach((i) => (i.lotNo = i.lotNo || lot.lotNo)));
  return {
    magic: ARCHIVE_MAGIC,
    format: ARCHIVE_FORMAT,
    device: device.trim() || '未命名设备',
    exportedAt: Date.now(),
    specimens,
    procedures,
    supplies,
    photos,
  };
}

/** 触发浏览器下载档案 JSON */
export function downloadArchive(bundle: ArchiveBundle): void {
  const text = JSON.stringify(bundle);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date(bundle.exportedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `gbfossilprep-${bundle.device.replace(/[^\w一-龥]+/g, '_')}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface Snapshot {
  specimens: Specimen[];
  procedures: PrepProcedure[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
}

export async function readSnapshot(): Promise<Snapshot> {
  const [specimens, procedures, supplies, photos] = await Promise.all([
    db.specimens.toArray(),
    db.procedures.toArray(),
    db.supplies.toArray(),
    db.photos.toArray(),
  ]);
  return { specimens, procedures, supplies, photos };
}

/** 入库前的最终闸门：容量阻断 / 冲突未裁决 / 游离影像未处理，任一项不满足都不写库 */
function assertReady(report: MergeReport, choices: MergeChoices, incoming: ArchiveBundle, local: Snapshot): void {
  if (report.blocked) {
    throw new Error(report.blockReasons.join('；') || '容量预检未通过，已拒绝合并，原档完整保留');
  }
  if (report.hasUnresolvedConflicts) {
    throw new Error('还有两边都改过的工序节点未裁决，请逐组并排列出后选择保留哪一边');
  }
  const choiceById = new Map(choices.orphanPhotos.map((c) => [c.photoId, c]));
  report.photos.orphans.forEach((o) => {
    const c = choiceById.get(o.photo.id);
    if (!c) throw new Error('有挂不上的影像尚未决定处理方式（挂到标本或丢弃）');
    if (c.decision === 'attach-specimen' && !c.specimenNo) {
      throw new Error('游离影像选择挂到标本时必须指定标本号');
    }
    if (c.decision === 'attach-specimen' && c.specimenNo) {
      // 合并后该标本号一定存在（本机已有，或随本次对端档案新增）
      const knownAfterMerge =
        local.specimens.some((s) => s.specimenNo === c.specimenNo) ||
        incoming.specimens.some((s) => s.specimenNo === c.specimenNo);
      if (!knownAfterMerge) throw new Error(`影像无法挂到不存在的标本「${c.specimenNo}」`);
    }
  });
}

/**
 * 将确认后的合并方案写入本机库（单事务、原子提交）。
 * 本机为主：同一批号库存以本机为准，只追加领用；同一标本 id 以本机为准；
 * 对端记录一律换发本机新 id，避免两台设备随机 id 相撞。
 */
export async function applyMerge(
  local: Snapshot,
  incoming: ArchiveBundle,
  report: MergeReport,
  choices: MergeChoices,
): Promise<MergeApplyResult> {
  assertReady(report, choices, incoming, local);

  const result: MergeApplyResult = {
    insertedSpecimens: 0,
    updatedSpecimens: 0,
    insertedProcedures: 0,
    resolvedConflicts: 0,
    insertedLots: 0,
    appliedIssues: 0,
    duplicateIssues: 0,
    blockedIssues: 0,
    insertedPhotos: 0,
    attachedOrphanPhotos: 0,
    discardedPhotos: 0,
  };

  const localPhotoIds = new Set(local.photos.map((p) => p.id));
  const localProcIds = new Set(local.procedures.map((p) => p.id));

  // 标本号 -> 合并后标本（先算好，供工序 / 影像翻译外键）
  const specimenIdByNo = new Map<string, string>();
  local.specimens.forEach((s) => specimenIdByNo.set(s.specimenNo, s.id));
  const incomingIdToNo = new Map(incoming.specimens.map((s) => [s.id, s.specimenNo]));
  const specimenWrites = new Map<string, Specimen>();

  report.specimens.forEach((m) => {
    if (m.status === 'incoming-only' && m.incoming) {
      const s = clone(m.incoming);
      s.id = newId('spm');
      specimenWrites.set(s.id, s);
      specimenIdByNo.set(m.specimenNo, s.id);
      result.insertedSpecimens += 1;
    } else if (m.status === 'changed' && m.local && m.incoming) {
      const side = choices.specimenResolution[m.specimenNo] ?? 'keep-local';
      if (side === 'take-incoming') {
        const merged: Specimen = { ...clone(m.local) };
        m.diffs.forEach((d) => {
          (merged as unknown as Record<string, unknown>)[d.field] = clone(m.incoming![d.field]);
        });
        specimenWrites.set(merged.id, merged);
        result.updatedSpecimens += 1;
      }
    }
  });

  // 对端工序定位：no#seq -> 对端节点
  const incomingProcByNoSeq = new Map<string, PrepProcedure>();
  incoming.procedures.forEach((p) => {
    const no = incomingIdToNo.get(p.specimenId);
    if (no) incomingProcByNoSeq.set(`${no}#${p.seq}`, p);
  });
  const localProcByNoSeq = new Map<string, PrepProcedure>();
  const localIdToNo = new Map(local.specimens.map((s) => [s.id, s.specimenNo]));
  local.procedures.forEach((p) => {
    const no = localIdToNo.get(p.specimenId);
    if (no) localProcByNoSeq.set(`${no}#${p.seq}`, p);
  });
  const conflictByKey = new Map(report.procedures.conflicts.map((c) => [`${c.specimenNo}#${c.seq}`, c]));

  // 对端影像 id -> 新 id（换发），并按节点收集挂接
  const photoIdRemap = new Map<string, string>();
  const photoWrites = new Map<string, PrepPhoto>();
  const incomingPhotoById = new Map(incoming.photos.map((p) => [p.id, p]));
  const localPhotoFp = new Set(local.photos.map((p) => `${p.capturedAt}|${p.caption}|${p.stage}`));

  const materializePhoto = (oldId: string, targetSpecimenId: string, targetProcId: string): string | null => {
    if (photoIdRemap.has(oldId)) return photoIdRemap.get(oldId)!;
    const src = incomingPhotoById.get(oldId);
    if (!src) return null;
    const fp = `${src.capturedAt}|${src.caption}|${src.stage}`;
    if (localPhotoFp.has(fp)) return null; // 本机已有同帧，不重复入库
    const nid = localPhotoIds.has(oldId) ? newId('pho') : oldId;
    localPhotoIds.add(nid);
    photoWrites.set(nid, {
      ...clone(src),
      id: nid,
      specimenId: targetSpecimenId,
      procedureId: targetProcId,
    });
    photoIdRemap.set(oldId, nid);
    result.insertedPhotos += 1;
    return nid;
  };

  // 先处理随节点进入的影像，确定工序写入内容
  const procedureWrites = new Map<string, PrepProcedure>();

  incomingProcByNoSeq.forEach((ip, key) => {
    const lp = localProcByNoSeq.get(key);
    const no = key.split('#')[0];
    const targetSpecimenId = specimenIdByNo.get(no)!;
    if (!lp) {
      // 对端独有的新节点：整体入库并换发 id
      const nid = localProcIds.has(ip.id) ? newId('prc') : ip.id;
      localProcIds.add(nid);
      const created: PrepProcedure = {
        ...clone(ip),
        id: nid,
        specimenId: targetSpecimenId,
        photoBeforeIds: [],
        photoAfterIds: [],
      };
      ip.photoBeforeIds.forEach((pid) => {
        const npid = materializePhoto(pid, targetSpecimenId, nid);
        if (npid) created.photoBeforeIds.push(npid);
      });
      ip.photoAfterIds.forEach((pid) => {
        const npid = materializePhoto(pid, targetSpecimenId, nid);
        if (npid) created.photoAfterIds.push(npid);
      });
      procedureWrites.set(nid, created);
      result.insertedProcedures += 1;
    } else {
      const conflict = conflictByKey.get(key);
      if (!conflict) {
        // 内容一致：并集补齐影像（不覆盖本机记录）
        const before = [...lp.photoBeforeIds];
        const after = [...lp.photoAfterIds];
        ip.photoBeforeIds.forEach((pid) => {
          const npid = materializePhoto(pid, lp.specimenId, lp.id);
          if (npid && !before.includes(npid)) before.push(npid);
        });
        ip.photoAfterIds.forEach((pid) => {
          const npid = materializePhoto(pid, lp.specimenId, lp.id);
          if (npid && !after.includes(npid)) after.push(npid);
        });
        if (before.length !== lp.photoBeforeIds.length || after.length !== lp.photoAfterIds.length) {
          procedureWrites.set(lp.id, { ...clone(lp), photoBeforeIds: before, photoAfterIds: after });
        }
      } else if (conflict.resolution === 'take-incoming') {
        // 人工确认采用对端：业务内容取对端，id / 外键 / 序号留本机，影像跟对端
        const merged: PrepProcedure = {
          ...clone(ip),
          id: lp.id,
          specimenId: lp.specimenId,
          seq: lp.seq,
          photoBeforeIds: [],
          photoAfterIds: [],
        };
        ip.photoBeforeIds.forEach((pid) => {
          const npid = materializePhoto(pid, lp.specimenId, lp.id);
          if (npid) merged.photoBeforeIds.push(npid);
        });
        ip.photoAfterIds.forEach((pid) => {
          const npid = materializePhoto(pid, lp.specimenId, lp.id);
          if (npid) merged.photoAfterIds.push(npid);
        });
        procedureWrites.set(lp.id, merged);
        result.resolvedConflicts += 1;
      } else {
        // 保留本机：对端该节点内容与影像都不进入
        result.resolvedConflicts += 1;
      }
    }
  });

  // 游离影像：按确认选择挂到标本级留痕，或丢弃
  const choiceById = new Map(choices.orphanPhotos.map((c) => [c.photoId, c]));
  report.photos.orphans.forEach((o) => {
    const choice: OrphanPhotoChoice | undefined = choiceById.get(o.photo.id);
    if (!choice || choice.decision === 'discard') {
      result.discardedPhotos += 1;
      return;
    }
    const targetSpecimenId = specimenIdByNo.get(choice.specimenNo!);
    if (!targetSpecimenId) {
      throw new Error(`影像挂接失败：标本「${choice.specimenNo}」不存在`);
    }
    materializePhoto(o.photo.id, targetSpecimenId, '');
    result.attachedOrphanPhotos += 1;
  });

  // 材料：matched 以本机批次为主、追加领用并扣库存；incoming-only 整批新增；缺批号领用跳过
  const supplyWrites = new Map<string, SupplyLot>();
  const localLotByNo = new Map(local.supplies.map((s) => [s.lotNo, s]));
  const incomingLotByNo = new Map(incoming.supplies.map((s) => [s.lotNo, s]));

  report.lots.forEach((lr) => {
    const localLot = localLotByNo.get(lr.lotNo);
    const incomingLot = incomingLotByNo.get(lr.lotNo);

    if (localLot) {
      // 同一批号：以本机批次为主，只把对端新领用追加进来并扣减本机库存
      let lot: SupplyLot | undefined;
      lr.issues.forEach((ir) => {
        if (ir.status === 'duplicate') {
          result.duplicateIssues += 1;
          return;
        }
        if (ir.status === 'blocked') {
          result.blockedIssues += 1;
          return; // 缺项：补齐前不生效
        }
        if (!lot) lot = { ...clone(localLot), issues: [...localLot.issues] };
        lot.issues.unshift({ ...clone(ir.issue), lotNo: lr.lotNo });
        lot.qty = Math.max(0, lot.qty - ir.issue.qty);
        result.appliedIssues += 1;
      });
      if (lot) supplyWrites.set(lot.id, lot);
    } else if (incomingLot) {
      // 本端没有该批号：整批新增（对端库存 + 全部领用历史原样带回）
      const created: SupplyLot = { ...clone(incomingLot), id: newId('sup'), issues: [] };
      lr.issues.forEach((ir) => {
        if (ir.status === 'blocked') {
          result.blockedIssues += 1;
          return;
        }
        if (ir.status === 'duplicate') {
          result.duplicateIssues += 1;
          return;
        }
        created.issues.unshift({ ...clone(ir.issue), lotNo: lr.lotNo });
        result.appliedIssues += 1;
      });
      supplyWrites.set(created.id, created);
      result.insertedLots += 1;
    } else {
      // 两边都没有批次记录的缺项批号：领用保持挂起，不生效
      lr.issues.forEach((ir) => {
        if (ir.status === 'blocked') result.blockedIssues += 1;
      });
    }
  });

  // 单事务原子提交：任一写入失败，Dexie 自动回滚，本机原档不动
  await db.transaction(
    'rw',
    db.specimens,
    db.procedures,
    db.supplies,
    db.photos,
    async () => {
      if (specimenWrites.size) await db.specimens.bulkPut(Array.from(specimenWrites.values()));
      if (procedureWrites.size) await db.procedures.bulkPut(Array.from(procedureWrites.values()));
      if (supplyWrites.size) await db.supplies.bulkPut(Array.from(supplyWrites.values()));
      if (photoWrites.size) await db.photos.bulkPut(Array.from(photoWrites.values()));
    },
  );

  return result;
}

/** 影像阶段中文标签（确认页回显用） */
export function stageLabel(stage: PhotoStage): string {
  return stage === 'before' ? '修复前' : stage === 'after' ? '修复后' : '过程';
}

export type { MergeApplyResult } from './merge';
