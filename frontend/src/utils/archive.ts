/**
 * 档案导出 / 导入合并。
 *
 * 修复组在发掘站断网录工序，回馆后用文件把两台设备的档案合并。
 * 合并规则：
 *  - 按标本号（specimenNo）认同一标本，不按设备本地 id；
 *  - 同一工序（标本号 + 序号）两边都改过时并排列出，确认后才入库；
 *  - 材料领用按批号（lotNo）对账，领用记录按批号合并去重；
 *  - 领用 / 影像引用了不存在的标本或工序即为「缺项」，补齐（映射 / 新建）前不生效；
 *  - 容量不足拒绝合并并保留原档；失败后可重试；
 *  - 旧版本档案（version < 当前结构版本）导入前先升级迁移。
 */
import Dexie from 'dexie';
import { db, DB_VERSION } from './db';
import { newId } from './id';
import type { Specimen, SpecimenDraft } from '../types/specimen';
import type { PrepProcedure, ProcedureState } from '../types/procedure';
import type { SupplyLot, SupplyIssue } from '../types/supply';
import type { PrepPhoto } from '../types/photo';

export const ARCHIVE_FORMAT = 'gbfossilprep-archive';

export interface ArchiveFile {
  format: string;
  version: number;
  exportedAt: number;
  device?: string;
  data: {
    specimens: Specimen[];
    procedures: PrepProcedure[];
    supplies: SupplyLot[];
    photos: PrepPhoto[];
  };
}

/** 本地档案快照（合并的目标侧） */
export interface LocalData {
  specimens: Specimen[];
  procedures: PrepProcedure[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
}

/* ----------------------------- 导出 ----------------------------- */

export async function exportArchive(): Promise<ArchiveFile> {
  const [specimens, procedures, supplies, photos] = await Promise.all([
    db.specimens.toArray(),
    db.procedures.toArray(),
    db.supplies.toArray(),
    db.photos.toArray(),
  ]);
  let device = 'unknown';
  try {
    device = window.localStorage.getItem('gbfossilprep:device') || 'unknown';
  } catch {
    /* ignore */
  }
  return {
    format: ARCHIVE_FORMAT,
    version: DB_VERSION,
    exportedAt: Date.now(),
    device,
    data: { specimens, procedures, supplies, photos },
  };
}

export function downloadArchive(archive: ArchiveFile): void {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date(archive.exportedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  a.href = url;
  a.download = `gbfossilprep-archive-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* --------------------------- 解析与升级 --------------------------- */

/** 读取文件、校验、升级旧版本档案 */
export async function parseArchiveFile(file: File): Promise<ArchiveFile> {
  const text = await file.text();
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('档案不是合法的 JSON 文件');
  }
  if (!raw || typeof raw !== 'object') throw new Error('档案内容为空');
  if (raw.format !== ARCHIVE_FORMAT) {
    throw new Error(`档案格式不符（应为 ${ARCHIVE_FORMAT}）`);
  }
  const version = Number(raw.version);
  if (!Number.isFinite(version)) throw new Error('档案缺少版本号');
  if (version > DB_VERSION) {
    throw new Error(`档案版本 v${version} 比当前应用新，请升级应用后再导入`);
  }
  const data = raw.data ?? {};
  const archive: ArchiveFile = {
    format: ARCHIVE_FORMAT,
    version,
    exportedAt: Number(raw.exportedAt) || 0,
    device: raw.device,
    data: {
      specimens: Array.isArray(data.specimens) ? data.specimens : [],
      procedures: Array.isArray(data.procedures) ? data.procedures : [],
      supplies: Array.isArray(data.supplies) ? data.supplies : [],
      photos: Array.isArray(data.photos) ? data.photos : [],
    },
  };
  archive.data = upgradeArchiveData(archive.data, version);
  return archive;
}

/**
 * 纯数据升级：把旧版本档案补到当前结构。
 * 与 db.ts 里的迁移保持一致，但作用于任意档案数据。
 */
export function upgradeArchiveData(data: ArchiveFile['data'], fromVersion: number): ArchiveFile['data'] {
  let { specimens, procedures, supplies, photos } = data;
  if (fromVersion < 2) {
    procedures = procedures.map((row: any) => {
      const next: any = { ...row };
      if (!next.state) next.state = 'pending' as ProcedureState;
      if (next.tools === undefined) next.tools = [];
      if (next.photoBeforeIds === undefined) next.photoBeforeIds = [];
      if (next.photoAfterIds === undefined) next.photoAfterIds = [];
      if (next.adhesiveConc === undefined) next.adhesiveConc = 0;
      return next as PrepProcedure;
    });
    supplies = supplies.map((row: any) => {
      const next: any = { ...row };
      if (!next.issues) next.issues = [];
      if (next.lowThreshold === undefined) next.lowThreshold = 1;
      return next as SupplyLot;
    });
  }
  return { specimens, procedures, supplies, photos };
}

/* --------------------------- 合并计划 --------------------------- */

export interface ProcedureConflict {
  key: string;
  specimenNo: string;
  seq: number;
  local: PrepProcedure;
  imported: PrepProcedure;
}

export interface SupplyReconcile {
  lotNo: string;
  local: SupplyLot;
  imported: SupplyLot;
  merged: SupplyLot;
}

export interface OrphanIssue {
  lotNo: string;
  issueId: string;
  issue: SupplyIssue;
}

export interface OrphanPhoto {
  photoId: string;
  photo: PrepPhoto;
}

export interface MergePlan {
  archive: ArchiveFile;
  /** 按标本号匹配上的标本（本地保留，不覆盖） */
  matchedSpecimens: { specimenNo: string; local: Specimen; imported: Specimen }[];
  /** 新增标本（已分配新 id） */
  newSpecimens: Specimen[];
  /** 两边都改过的工序冲突（需并排确认） */
  procedureConflicts: ProcedureConflict[];
  /** 新增工序（已分配新 id、重映射 specimenId） */
  newProcedures: PrepProcedure[];
  /** 按批号对账的材料批次 */
  supplyReconciles: SupplyReconcile[];
  /** 新增材料批次（已分配新 id） */
  newSupplies: SupplyLot[];
  /** 新增影像（已分配新 id、重映射引用、去重） */
  newPhotos: PrepPhoto[];
  /** 缺项：领用引用了不存在的标本号 */
  orphanIssues: OrphanIssue[];
  /** 缺项：影像引用了不存在的工序 */
  orphanPhotos: OrphanPhoto[];
  /* 引用映射：导入 id -> 本地 id */
  specimenIdMap: Record<string, string>;
  procedureIdMap: Record<string, string>;
  photoIdMap: Record<string, string>;
  /** 工序 key（specimenNo#seq）-> 本地工序 { id, specimenId }，用于影像缺项映射 */
  procKeyMap: Record<string, { id: string; specimenId: string }>;
}

export const procKeyOf = (specimenNo: string, seq: number): string => `${specimenNo}#${seq}`;

/** 计算合并计划（纯函数，不写库） */
export function computeMergePlan(local: LocalData, archive: ArchiveFile): MergePlan {
  const imp = archive.data;

  // ---- 标本：按标本号认同一种标本 ----
  const localByNo = new Map<string, Specimen>();
  for (const s of local.specimens) localByNo.set(s.specimenNo, s);

  const specimenIdMap: Record<string, string> = {};
  const matchedSpecimens: MergePlan['matchedSpecimens'] = [];
  const newSpecimens: Specimen[] = [];
  for (const s of imp.specimens) {
    const loc = localByNo.get(s.specimenNo);
    if (loc) {
      specimenIdMap[s.id] = loc.id;
      matchedSpecimens.push({ specimenNo: s.specimenNo, local: loc, imported: s });
    } else {
      const id = newId('spm');
      specimenIdMap[s.id] = id;
      newSpecimens.push({ ...s, id });
    }
  }

  // ---- 工序：按（标本号 + 序号）认同一个节点 ----
  const impSpecimenById = new Map<string, Specimen>();
  for (const s of imp.specimens) impSpecimenById.set(s.id, s);

  const localProcByKey = new Map<string, PrepProcedure>();
  for (const p of local.procedures) {
    const s = local.specimens.find((x) => x.id === p.specimenId);
    if (s) localProcByKey.set(procKeyOf(s.specimenNo, p.seq), p);
  }

  const procedureIdMap: Record<string, string> = {};
  const procedureConflicts: ProcedureConflict[] = [];
  const newProcedures: PrepProcedure[] = [];
  for (const p of imp.procedures) {
    const impSpec = impSpecimenById.get(p.specimenId);
    if (!impSpec) continue; // 档案自洽时不会发生
    const key = procKeyOf(impSpec.specimenNo, p.seq);
    const loc = localProcByKey.get(key);
    if (loc) {
      procedureIdMap[p.id] = loc.id;
      if (!proceduresEqual(loc, p)) {
        procedureConflicts.push({ key, specimenNo: impSpec.specimenNo, seq: p.seq, local: loc, imported: p });
      }
    } else {
      const id = newId('prc');
      procedureIdMap[p.id] = id;
      newProcedures.push({ ...p, id, specimenId: specimenIdMap[p.specimenId] ?? p.specimenId });
    }
  }

  // 工序 key -> 本地工序（含本地已有与新增），供影像缺项映射用
  const procKeyMap: Record<string, { id: string; specimenId: string }> = {};
  for (const p of local.procedures) {
    const s = local.specimens.find((x) => x.id === p.specimenId);
    if (s) procKeyMap[procKeyOf(s.specimenNo, p.seq)] = { id: p.id, specimenId: p.specimenId };
  }
  for (const p of newProcedures) {
    const s = newSpecimens.find((x) => x.id === p.specimenId);
    if (s) procKeyMap[procKeyOf(s.specimenNo, p.seq)] = { id: p.id, specimenId: p.specimenId };
  }

  // ---- 材料：按批号对账 ----
  const localSupplyByLotNo = new Map<string, SupplyLot>();
  for (const s of local.supplies) localSupplyByLotNo.set(s.lotNo, s);

  const supplyReconciles: SupplyReconcile[] = [];
  const newSupplies: SupplyLot[] = [];
  for (const lot of imp.supplies) {
    const loc = localSupplyByLotNo.get(lot.lotNo);
    if (loc) {
      supplyReconciles.push({ lotNo: lot.lotNo, local: loc, imported: lot, merged: reconcileLot(loc, lot) });
    } else {
      const id = newId('sup');
      newSupplies.push({ ...lot, id });
    }
  }

  // ---- 影像：重映射引用 + 去重 ----
  const localPhotoById = new Map<string, PrepPhoto>();
  for (const ph of local.photos) localPhotoById.set(ph.id, ph);
  const localPhotoDedupe = new Set<string>();
  for (const ph of local.photos) {
    const proc = local.procedures.find((p) => p.id === ph.procedureId);
    const s = proc ? local.specimens.find((x) => x.id === proc.specimenId) : undefined;
    if (s) localPhotoDedupe.add(photoDedupeKey(s.specimenNo, ph.stage, ph.caption));
  }

  const photoIdMap: Record<string, string> = {};
  const newPhotos: PrepPhoto[] = [];
  const orphanPhotos: OrphanPhoto[] = [];
  for (const ph of imp.photos) {
    const remappedSpecimenId = specimenIdMap[ph.specimenId];
    const remappedProcedureId = procedureIdMap[ph.procedureId];
    if (!remappedSpecimenId || !remappedProcedureId) {
      orphanPhotos.push({ photoId: ph.id, photo: ph });
      continue;
    }
    if (localPhotoById.has(ph.id)) {
      photoIdMap[ph.id] = ph.id;
      continue;
    }
    const impSpec = impSpecimenById.get(ph.specimenId);
    const dedupeKey = impSpec ? photoDedupeKey(impSpec.specimenNo, ph.stage, ph.caption) : '';
    if (dedupeKey && localPhotoDedupe.has(dedupeKey)) {
      // 同（标本号 + 阶段 + 说明）视为同一张，跳过
      const existing = local.photos.find((x) => {
        const proc = local.procedures.find((p) => p.id === x.procedureId);
        const s = proc ? local.specimens.find((y) => y.id === proc.specimenId) : undefined;
        return s ? photoDedupeKey(s.specimenNo, x.stage, x.caption) === dedupeKey : false;
      });
      if (existing) {
        photoIdMap[ph.id] = existing.id;
        continue;
      }
    }
    const id = newId('pho');
    photoIdMap[ph.id] = id;
    newPhotos.push({ ...ph, id, specimenId: remappedSpecimenId, procedureId: remappedProcedureId });
  }

  // ---- 缺项：领用引用了合并后仍不存在的标本号 ----
  const mergedSpecimenNos = new Set<string>([
    ...local.specimens.map((s) => s.specimenNo),
    ...newSpecimens.map((s) => s.specimenNo),
  ]);
  const orphanIssues: OrphanIssue[] = [];
  for (const lot of imp.supplies) {
    for (const iss of lot.issues) {
      if (!mergedSpecimenNos.has(iss.specimenNo)) {
        orphanIssues.push({ lotNo: lot.lotNo, issueId: iss.id, issue: iss });
      }
    }
  }

  return {
    archive,
    matchedSpecimens,
    newSpecimens,
    procedureConflicts,
    newProcedures,
    supplyReconciles,
    newSupplies,
    newPhotos,
    orphanIssues,
    orphanPhotos,
    specimenIdMap,
    procedureIdMap,
    photoIdMap,
    procKeyMap,
  };
}

function photoDedupeKey(specimenNo: string, stage: string, caption: string): string {
  return `${specimenNo}|${stage}|${caption}`;
}

function proceduresEqual(a: PrepProcedure, b: PrepProcedure): boolean {
  const norm = (p: PrepProcedure) =>
    JSON.stringify({
      stepType: p.stepType,
      nodeName: p.nodeName,
      seq: p.seq,
      tools: [...p.tools].sort(),
      abrasive: p.abrasive,
      adhesive: p.adhesive,
      adhesiveConc: p.adhesiveConc,
      durationMin: p.durationMin,
      tempC: p.tempC,
      rh: p.rh,
      operator: p.operator,
      state: p.state,
      finishedAt: p.finishedAt ?? null,
    });
  return norm(a) === norm(b);
}

function sumIssues(issues: SupplyIssue[]): number {
  return issues.reduce((acc, it) => acc + (Number(it.qty) || 0), 0);
}

function dedupeIssues(issues: SupplyIssue[]): SupplyIssue[] {
  const seen = new Set<string>();
  const out: SupplyIssue[] = [];
  for (const iss of issues) {
    if (seen.has(iss.id)) continue;
    seen.add(iss.id);
    out.push(iss);
  }
  return out;
}

/**
 * 按批号对账：领用记录合并去重，数量按「初始 - 已领用」重算，
 * 保证数量与领用台账一致。
 */
function reconcileLot(local: SupplyLot, imported: SupplyLot): SupplyLot {
  const initialQty = Math.max(local.qty + sumIssues(local.issues), imported.qty + sumIssues(imported.issues));
  const mergedIssues = dedupeIssues([...local.issues, ...imported.issues]);
  return {
    ...local,
    qty: Math.max(0, initialQty - sumIssues(mergedIssues)),
    issues: mergedIssues,
  };
}

/* --------------------------- 冲突对比 --------------------------- */

export interface DiffRow {
  field: string;
  label: string;
  local: string;
  imported: string;
}

/** 并排对比两个工序节点，返回有差异的字段 */
export function diffProcedures(local: PrepProcedure, imported: PrepProcedure): DiffRow[] {
  const fmt = (p: PrepProcedure, field: string): string => {
    switch (field) {
      case 'stepType':
        return p.stepType;
      case 'nodeName':
        return p.nodeName;
      case 'seq':
        return `#${p.seq}`;
      case 'tools':
        return p.tools.length ? p.tools.join('、') : '—';
      case 'abrasive':
        return p.abrasive || '—';
      case 'adhesive':
        return p.adhesive || '—';
      case 'adhesiveConc':
        return p.adhesiveConc > 0 ? `${p.adhesiveConc} %` : '—';
      case 'durationMin':
        return `${p.durationMin} min`;
      case 'tempC':
        return `${p.tempC} ℃`;
      case 'rh':
        return `${p.rh} %`;
      case 'operator':
        return p.operator || '—';
      case 'state':
        return p.state === 'done' ? '已完成' : p.state === 'rolledback' ? '已回退' : '待办';
      case 'finishedAt':
        return p.finishedAt ? new Date(p.finishedAt).toLocaleString('zh-CN') : '—';
      default:
        return '';
    }
  };
  const fields: { field: string; label: string }[] = [
    { field: 'stepType', label: '工序类型' },
    { field: 'nodeName', label: '节点名称' },
    { field: 'seq', label: '序号' },
    { field: 'tools', label: '工具' },
    { field: 'abrasive', label: '磨料' },
    { field: 'adhesive', label: '胶种' },
    { field: 'adhesiveConc', label: '胶液浓度' },
    { field: 'durationMin', label: '耗时' },
    { field: 'tempC', label: '环境温度' },
    { field: 'rh', label: '相对湿度' },
    { field: 'operator', label: '责任人' },
    { field: 'state', label: '状态' },
    { field: 'finishedAt', label: '完成时间' },
  ];
  const rows: DiffRow[] = [];
  for (const { field, label } of fields) {
    const lv = fmt(local, field);
    const iv = fmt(imported, field);
    if (lv !== iv) rows.push({ field, label, local: lv, imported: iv });
  }
  return rows;
}

/* --------------------------- 应用合并 --------------------------- */

export type ConflictResolution = 'local' | 'imported';

export type IssueResolution =
  | { type: 'map'; specimenNo: string }
  | { type: 'discard' }
  | { type: 'create'; draft: SpecimenDraft };

export type PhotoResolution =
  | { type: 'map'; procKey: string }
  | { type: 'discard' };

export interface MergeResolutions {
  /** key = procKey（specimenNo#seq） */
  conflicts: Record<string, ConflictResolution>;
  /** key = issueId */
  issues: Record<string, IssueResolution>;
  /** key = photoId */
  photos: Record<string, PhotoResolution>;
}

export const EMPTY_RESOLUTIONS: MergeResolutions = { conflicts: {}, issues: {}, photos: {} };

export interface ApplySet {
  specimens: Specimen[];
  procedures: PrepProcedure[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
  bytes: number;
}

/** 汇总当前待应用的记录（已应用冲突 / 缺项决议） */
export function buildApplySet(plan: MergePlan, resolutions: MergeResolutions): ApplySet {
  const specimens: Specimen[] = [...plan.newSpecimens];
  const procedures: PrepProcedure[] = [];
  const supplies: SupplyLot[] = [];

  // 记录通过「新建补齐」创建的标本，避免重复
  const createdSpecimenNos = new Set<string>();
  for (const s of plan.newSpecimens) createdSpecimenNos.add(s.specimenNo);

  const ensureCreatedSpecimen = (draft: SpecimenDraft): Specimen => {
    const existing = specimens.find((s) => s.specimenNo === draft.specimenNo.trim());
    if (existing) return existing;
    const id = newId('spm');
    const record: Specimen = { ...draft, id, specimenNo: draft.specimenNo.trim(), createdAt: Date.now() };
    specimens.push(record);
    createdSpecimenNos.add(record.specimenNo);
    return record;
  };

  // ---- 工序：新增 + 冲突采用导入 ----
  for (const p of plan.newProcedures) {
    procedures.push(remapProcedurePhotos(p, plan.photoIdMap));
  }
  for (const c of plan.procedureConflicts) {
    const winner = resolutions.conflicts[c.key];
    if (winner === 'imported') {
      // 采用导入：以本地 id 写入导入内容，重映射标本与影像引用
      const remappedSpecimenId = plan.specimenIdMap[c.imported.specimenId] ?? c.imported.specimenId;
      procedures.push(
        remapProcedurePhotos({ ...c.imported, id: c.local.id, specimenId: remappedSpecimenId }, plan.photoIdMap),
      );
    } else {
      // 保留本地：不动本地记录（导入的影像仍会挂到本地节点）
    }
  }

  // ---- 材料：新增 + 对账合并，应用缺项决议 ----
  const finalizeLot = (lot: SupplyLot): SupplyLot => {
    const issues: SupplyIssue[] = [];
    for (const iss of lot.issues) {
      const res = resolutions.issues[iss.id];
      if (res?.type === 'discard') continue;
      if (res?.type === 'map') {
        issues.push({ ...iss, specimenNo: res.specimenNo });
      } else if (res?.type === 'create') {
        const created = ensureCreatedSpecimen(res.draft);
        issues.push({ ...iss, specimenNo: created.specimenNo });
      } else {
        issues.push(iss);
      }
    }
    return { ...lot, issues };
  };
  for (const lot of plan.newSupplies) supplies.push(finalizeLot(lot));
  for (const r of plan.supplyReconciles) supplies.push(finalizeLot(r.merged));

  // ---- 影像：新增 + 缺项映射 ----
  const finalPhotos: PrepPhoto[] = [...plan.newPhotos];
  for (const o of plan.orphanPhotos) {
    const res = resolutions.photos[o.photoId];
    if (!res || res.type === 'discard') continue;
    if (res.type === 'map') {
      const target = plan.procKeyMap[res.procKey];
      if (target) {
        finalPhotos.push({ ...o.photo, id: newId('pho'), specimenId: target.specimenId, procedureId: target.id });
      }
    }
  }

  const bytes = JSON.stringify({ specimens, procedures, supplies, photos: finalPhotos }).length;
  return { specimens, procedures, supplies, photos: finalPhotos, bytes };
}

function remapProcedurePhotos(p: PrepProcedure, photoIdMap: Record<string, string>): PrepProcedure {
  const mapIds = (ids: string[]) => ids.map((id) => photoIdMap[id] ?? id).filter((id) => id);
  return { ...p, photoBeforeIds: mapIds(p.photoBeforeIds), photoAfterIds: mapIds(p.photoAfterIds) };
}

/** 是否还有未解决的冲突 / 缺项 */
export function hasUnresolved(plan: MergePlan, resolutions: MergeResolutions): boolean {
  for (const c of plan.procedureConflicts) {
    if (!resolutions.conflicts[c.key]) return true;
  }
  for (const o of plan.orphanIssues) {
    if (!resolutions.issues[o.issueId]) return true;
  }
  for (const o of plan.orphanPhotos) {
    if (!resolutions.photos[o.photoId]) return true;
  }
  return false;
}

/* --------------------------- 容量 --------------------------- */

export interface CapacityInfo {
  ok: boolean;
  available: number;
  reason?: string;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 容量预检：估算浏览器可用配额，不足则拒绝（保留原档） */
export async function checkCapacity(incomingBytes: number): Promise<CapacityInfo> {
  let available = Infinity;
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const quota = est.quota ?? 0;
      const usage = est.usage ?? 0;
      available = Math.max(0, quota - usage);
    } catch {
      /* 估算不可用时不拦截 */
    }
  }
  if (Number.isFinite(available) && incomingBytes > available * 0.85) {
    return {
      ok: false,
      available,
      reason: `容量不足：本次待入库约 ${formatBytes(incomingBytes)}，浏览器当前可用约 ${formatBytes(available)}。为保留原档，已拒绝合并；请清理空间后重试。`,
    };
  }
  return { ok: true, available };
}

/* --------------------------- 写入 --------------------------- */

export class MergeCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeCapacityError';
  }
}

/**
 * 事务性写入：容量预检通过后，在一个读写事务里 bulkPut。
 * 任何一步抛错都会回滚，原档保留；调用方可重试。
 */
export async function applyMerge(applySet: ApplySet): Promise<void> {
  const cap = await checkCapacity(applySet.bytes);
  if (!cap.ok) throw new MergeCapacityError(cap.reason ?? '容量不足，已拒绝合并并保留原档');

  try {
    await db.transaction('rw', db.specimens, db.procedures, db.supplies, db.photos, async () => {
      await db.specimens.bulkPut(applySet.specimens);
      await db.procedures.bulkPut(applySet.procedures);
      await db.supplies.bulkPut(applySet.supplies);
      await db.photos.bulkPut(applySet.photos);
    });
  } catch (err) {
    if (err instanceof MergeCapacityError) throw err;
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      throw new MergeCapacityError('写入时超出浏览器容量，已回滚并保留原档；请清理空间后重试。');
    }
    throw err;
  }
}

/** 读取本地全量快照（计算合并计划用） */
export async function loadLocalData(): Promise<LocalData> {
  const [specimens, procedures, supplies, photos] = await Promise.all([
    db.specimens.toArray(),
    db.procedures.toArray(),
    db.supplies.toArray(),
    db.photos.toArray(),
  ]);
  return { specimens, procedures, supplies, photos };
}

/** 判断错误是否为容量类错误（用于展示重试） */
export function isCapacityError(err: unknown): boolean {
  if (err instanceof MergeCapacityError) return true;
  const name = (err as { name?: string })?.name ?? '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** 重新导出 Dexie 类型供页面判断 */
export { Dexie };
