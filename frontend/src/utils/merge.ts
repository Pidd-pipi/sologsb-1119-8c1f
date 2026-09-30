/**
 * 双机档案合并引擎（纯函数，不触碰数据库，便于重试与单测）。
 *
 * 流程：解析对端档案 -> 容量预检（不足直接拒绝、原档不动）->
 * 标本按号对账 -> 工序按「标本 + 序号」配对、双改并列冲突 ->
 * 材料按批号对账（缺批号的领用挂起不生效）->
 * 影像按「标本 + 节点序号」重挂，挂不上的列入待处理 -> 产出 MergeReport 供确认页并排列出。
 * 只有全部冲突被裁决、游离影像有处理方案后，applyMerge 才在一个事务里入库；
 * 事务失败不写入任何数据，可重新选择文件重试，老结构档案升级后照常参与。
 */
import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import type { SupplyIssue, SupplyLot } from '../types/supply';
import type { PrepPhoto } from '../types/photo';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_MAGIC,
  ArchiveParseError,
  type ArchiveBundle,
  type IssueReconcile,
  type LotReconcile,
  type MergeReport,
  type OrphanPhoto,
  type ProcedureConflict,
  type SpecimenFieldDiff,
  type SpecimenMatch,
} from '../types/merge';

/** 影像存储安全余量：预估占用之外再留 20%，避免顶满配额 */
const QUOTA_SAFETY = 1.2;

/** 标本对账时需要并列比较的字段（id / createdAt 为内部字段，不参与） */
const SPECIMEN_FIELDS: { field: keyof Specimen; label: string }[] = [
  { field: 'taxon', label: '分类鉴定' },
  { field: 'horizon', label: '层位' },
  { field: 'locality', label: '产地' },
  { field: 'lithology', label: '围岩岩性' },
  { field: 'matrixHardness', label: '围岩硬度' },
  { field: 'dimensions', label: '尺寸' },
  { field: 'weight', label: '重量' },
  { field: 'storageBox', label: '匣位' },
  { field: 'status', label: '状态' },
];

/** 工序内容字段（用于判定两边是否都改过 / 是否一致），id 与外键不参与 */
const PROCEDURE_CONTENT_FIELDS: (keyof PrepProcedure)[] = [
  'stepType',
  'nodeName',
  'tools',
  'abrasive',
  'adhesive',
  'adhesiveConc',
  'durationMin',
  'tempC',
  'rh',
  'operator',
  'startedAt',
  'state',
  'finishedAt',
];

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 浅比较两个工序的业务内容是否一致（影像挂接单独处理） */
function procedureContentEqual(a: PrepProcedure, b: PrepProcedure): boolean {
  return PROCEDURE_CONTENT_FIELDS.every((f) => JSON.stringify(a[f]) === JSON.stringify(b[f]));
}

/** 估算一个 JSON 值的 UTF-8 字节占用（IndexedDB 结构化存储的保守上界） */
export function estimateBytes(value: unknown): number {
  const text = JSON.stringify(value);
  if (typeof Blob !== 'undefined') return new Blob([text]).size;
  // Node / 测试环境没有 Blob 时用 Buffer 兜底
  const g = globalThis as { Buffer?: { byteLength: (s: string, enc: string) => number } };
  if (g.Buffer) return g.Buffer.byteLength(text, 'utf8');
  return text.length;
}

/** 解析对端导出的档案文本，并做最基本的结构校验与老格式兼容 */
export function parseArchive(text: string): ArchiveBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ArchiveParseError(`文件不是有效的 JSON：${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new ArchiveParseError('档案内容为空或结构不正确');
  const b = raw as Partial<ArchiveBundle>;
  // 兼容更老的、无 magic 头的导出：只要含业务表数组也接受（旧档案升级后继续参与）
  const looksLegacy = Array.isArray(b.specimens) || Array.isArray(b.procedures);
  if (b.magic && b.magic !== ARCHIVE_MAGIC) {
    throw new ArchiveParseError('文件标识不匹配，不是本系统导出的档案');
  }
  if (!looksLegacy) throw new ArchiveParseError('档案中找不到标本 / 工序数据');
  if (b.format !== undefined && b.format > ARCHIVE_FORMAT) {
    throw new ArchiveParseError(`档案结构版本 v${b.format} 高于本机支持的 v${ARCHIVE_FORMAT}，请先升级本应用`);
  }
  return normalizeBundle({
    magic: ARCHIVE_MAGIC,
    format: b.format ?? ARCHIVE_FORMAT,
    device: typeof b.device === 'string' && b.device ? b.device : '未知设备',
    exportedAt: typeof b.exportedAt === 'number' ? b.exportedAt : Date.now(),
    specimens: Array.isArray(b.specimens) ? b.specimens : [],
    procedures: Array.isArray(b.procedures) ? b.procedures : [],
    supplies: Array.isArray(b.supplies) ? b.supplies : [],
    photos: Array.isArray(b.photos) ? b.photos : [],
  });
}

/** 补齐老版本档案可能缺失的字段（与 IndexedDB v1→v2 迁移口径一致） */
function normalizeBundle(b: ArchiveBundle): ArchiveBundle {
  b.procedures.forEach((p) => {
    if (!p.state) p.state = 'pending';
    if (p.tools === undefined) p.tools = [];
    if (p.photoBeforeIds === undefined) p.photoBeforeIds = [];
    if (p.photoAfterIds === undefined) p.photoAfterIds = [];
    if (p.adhesiveConc === undefined) p.adhesiveConc = 0;
  });
  b.supplies.forEach((s) => {
    if (!s.issues) s.issues = [];
    if (s.lowThreshold === undefined) s.lowThreshold = 1;
    // 老领用记录没有批号冗余，回填所属批次批号，供按批号对账
    s.issues.forEach((i) => {
      if (!i.lotNo) i.lotNo = s.lotNo;
    });
  });
  return b;
}

/** 读取 navigator.storage.estimate()（不支持时返回 null，容量预检降级跳过） */
async function getStorageEstimate(): Promise<{ quota: number; usage: number } | null> {
  try {
    const nav = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } } })
      .navigator;
    const e = await nav?.storage?.estimate?.();
    if (e && typeof e.quota === 'number' && typeof e.usage === 'number') {
      return { quota: e.quota, usage: e.usage };
    }
  } catch {
    /* 隐私模式等场景拿不到配额，降级为不预检 */
  }
  return null;
}

interface LocalSnapshot {
  specimens: Specimen[];
  procedures: PrepProcedure[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
}

/**
 * 对账（不写库）。
 * @param local 本机四张表现有数据
 * @param incoming 对端档案
 */
export async function buildMergeReport(local: LocalSnapshot, incoming: ArchiveBundle): Promise<MergeReport> {
  const blockReasons: string[] = [];

  const localSpecimenNos = new Set(local.specimens.map((s) => s.specimenNo));
  const localLotNos = new Set(local.supplies.map((s) => s.lotNo));

  // ---- 1. 容量预检：估算对端独有 + 影像新增体积，不足直接拒绝（原档不动） ----
  const photoBytes = incoming.photos.reduce((sum, p) => sum + estimateBytes(p.dataUrl), 0);
  const incomingNewSpecimens = incoming.specimens.filter((s) => !localSpecimenNos.has(s.specimenNo));
  const incomingNewLots = incoming.supplies.filter((s) => !localLotNos.has(s.lotNo));
  const estNeed = Math.ceil(
    (estimateBytes(incomingNewSpecimens) +
      estimateBytes(incomingNewLots) +
      estimateBytes(incoming.procedures) +
      photoBytes) *
      QUOTA_SAFETY,
  );
  const est = await getStorageEstimate();
  if (est) {
    const free = est.quota - est.usage;
    if (estNeed > free) {
      blockReasons.push(
        `本地存储空间不足：预估需要约 ${formatBytes(estNeed)}，仅剩约 ${formatBytes(free)}。已拒绝合并，原档完整保留。`,
      );
    }
  }

  // ---- 2. 标本按标本号认同一标本 ----
  const localByNo = new Map(local.specimens.map((s) => [s.specimenNo, s]));
  const incomingByNo = new Map(incoming.specimens.map((s) => [s.specimenNo, s]));
  const allNos = Array.from(new Set([...localByNo.keys(), ...incomingByNo.keys()])).sort();

  const specimenMatches: SpecimenMatch[] = allNos.map((no) => {
    const l = localByNo.get(no);
    const r = incomingByNo.get(no);
    if (l && !r) return { specimenNo: no, status: 'local-only', local: l, incoming: undefined, diffs: [] };
    if (!l && r) return { specimenNo: no, status: 'incoming-only', local: undefined, incoming: r, diffs: [] };
    const diffs: SpecimenFieldDiff[] = [];
    if (l && r) {
      for (const { field, label } of SPECIMEN_FIELDS) {
        if (JSON.stringify(l[field]) !== JSON.stringify(r[field])) {
          diffs.push({ field, label, local: l[field], incoming: r[field] });
        }
      }
    }
    return {
      specimenNo: no,
      status: diffs.length ? 'changed' : 'identical',
      local: l,
      incoming: r,
      diffs,
    };
  });

  // ---- 3. 工序按「标本号 + 序号」配对（对端 specimenId 是对端库随机 id，必须翻译） ----
  const incomingIdToNo = new Map(incoming.specimens.map((s) => [s.id, s.specimenNo]));
  const localIdToNo = new Map(local.specimens.map((s) => [s.id, s.specimenNo]));

  const localProcByNoSeq = new Map<string, PrepProcedure>();
  local.procedures.forEach((p) => {
    const no = localIdToNo.get(p.specimenId);
    if (no) localProcByNoSeq.set(`${no}#${p.seq}`, p);
  });
  const incomingProcByNoSeq = new Map<string, PrepProcedure>();
  incoming.procedures.forEach((p) => {
    const no = incomingIdToNo.get(p.specimenId);
    if (no) incomingProcByNoSeq.set(`${no}#${p.seq}`, p);
  });

  const conflicts: ProcedureConflict[] = [];
  let addedFromIncoming = 0;
  let localOnlyKept = 0;
  let identicalProc = 0;

  incomingProcByNoSeq.forEach((ip, key) => {
    const lp = localProcByNoSeq.get(key);
    if (!lp) {
      addedFromIncoming += 1;
    } else if (procedureContentEqual(lp, ip)) {
      identicalProc += 1;
    } else {
      // 同一节点两边都改过且不一致 -> 冲突，并排列出待裁决
      const [no, seqStr] = key.split('#');
      conflicts.push({ id: lp.id, specimenNo: no, seq: Number(seqStr), local: lp, incoming: ip });
    }
  });
  localProcByNoSeq.forEach((_, key) => {
    if (!incomingProcByNoSeq.has(key)) localOnlyKept += 1;
  });

  // ---- 4. 材料按批号对账，领用逐笔去重 / 挂起 ----
  const localLotByNo = new Map(local.supplies.map((s) => [s.lotNo, s]));
  const incomingLotByNo = new Map(incoming.supplies.map((s) => [s.lotNo, s]));
  const allLotNos = Array.from(new Set([...localLotByNo.keys(), ...incomingLotByNo.keys()])).sort();

  // 领用指纹：批号 + 时间 + 数量 + 领用人 + 标本，重试合并时幂等不重复扣账
  const issueFingerprint = (lotNo: string, i: SupplyIssue) =>
    `${lotNo}|${i.issuedAt}|${i.qty}|${i.operator}|${i.specimenNo}`;
  const localIssueFps = new Set<string>();
  local.supplies.forEach((lot) => lot.issues.forEach((i) => localIssueFps.add(issueFingerprint(lot.lotNo, i))));

  const missingLotNos = new Set<string>();
  const lotReconciles: LotReconcile[] = allLotNos.map((lotNo) => {
    const l = localLotByNo.get(lotNo);
    const r = incomingLotByNo.get(lotNo);
    const status: LotReconcile['status'] = l && r ? 'matched' : l ? 'local-only' : 'incoming-only';
    // 只对账实际挂在该批号下的领用（领用记录自带的 lotNo 冗余可能指向别的批次）
    const issues: IssueReconcile[] = (r?.issues ?? [])
      .filter((i) => (i.lotNo || r!.lotNo) === lotNo)
      .map((issue) => {
        const fp = issueFingerprint(lotNo, issue);
        if (localIssueFps.has(fp)) return { key: fp, lotNo, issue: clone(issue), status: 'duplicate' };
        return { key: fp, lotNo, issue: clone(issue), status: 'apply' };
      });
    return { lotNo, status, local: l, incoming: r, issues };
  });

  // 兜账：领用引用的批号在两边批次表里都不存在（残缺 / 手工档案）-> 缺项挂起，补齐前不生效
  const referencedLotNos = new Set<string>();
  incoming.supplies.forEach((lot) => lot.issues.forEach((i) => referencedLotNos.add(i.lotNo || lot.lotNo)));
  referencedLotNos.forEach((lotNo) => {
    if (localLotByNo.has(lotNo) || incomingLotByNo.has(lotNo)) return;
    missingLotNos.add(lotNo);
    const sourceLot = incoming.supplies.find((x) => x.issues.some((i) => (i.lotNo || x.lotNo) === lotNo));
    const issues: IssueReconcile[] = [];
    sourceLot?.issues.forEach((issue) => {
      if ((issue.lotNo || sourceLot.lotNo) !== lotNo) return;
      issues.push({
        key: issueFingerprint(lotNo, issue),
        lotNo,
        issue: clone(issue),
        status: 'blocked',
        reason: `两边都没有批号「${lotNo}」的材料批次，补齐前本次领用不生效`,
      });
    });
    lotReconciles.push({ lotNo, status: 'incoming-only', local: undefined, incoming: undefined, issues });
  });

  // ---- 5. 影像按「标本号 + 节点序号」重挂，挂不上的列入游离待处理 ----
  const localPhotoFp = new Set(local.photos.map((p) => `${p.capturedAt}|${p.caption}|${p.stage}`));
  const incomingPhotoNode = new Map<string, { no: string; seq: number }>();
  incoming.procedures.forEach((p) => {
    const no = incomingIdToNo.get(p.specimenId);
    if (!no) return;
    [...p.photoBeforeIds, ...p.photoAfterIds].forEach((pid) => incomingPhotoNode.set(pid, { no, seq: p.seq }));
  });

  let photosAdded = 0;
  let photosIdentical = 0;
  const orphanPhotos: OrphanPhoto[] = [];
  incoming.photos.forEach((p) => {
    const fp = `${p.capturedAt}|${p.caption}|${p.stage}`;
    if (localPhotoFp.has(fp)) {
      photosIdentical += 1;
      return;
    }
    const no = incomingPhotoNode.get(p.id)?.no ?? incomingIdToNo.get(p.specimenId);
    const seq = incomingPhotoNode.get(p.id)?.seq;
    if (!no) {
      orphanPhotos.push({ photo: clone(p), reason: 'no-specimen' });
      return;
    }
    const nodeKnown = localProcByNoSeq.has(`${no}#${seq}`) || incomingProcByNoSeq.has(`${no}#${seq}`);
    const specimenKnown = localSpecimenNos.has(no) || incomingByNo.has(no);
    if (seq === undefined || !nodeKnown || !specimenKnown) {
      orphanPhotos.push({ photo: clone(p), reason: 'no-node', specimenNo: no, seq });
      return;
    }
    photosAdded += 1;
  });

  return {
    device: incoming.device,
    exportedAt: incoming.exportedAt,
    photoBytes,
    specimens: specimenMatches,
    procedures: { addedFromIncoming, localOnlyKept, identical: identicalProc, conflicts },
    lots: lotReconciles,
    photos: { added: photosAdded, identical: photosIdentical, orphans: orphanPhotos },
    blocked: blockReasons.length > 0,
    blockReasons,
    missingLotNos: Array.from(missingLotNos).sort(),
    hasUnresolvedConflicts: conflicts.some((c) => !c.resolution),
    hasOrphanPhotos: orphanPhotos.length > 0,
  };
}

/** 确认页为某个工序冲突选择保留哪一边 */
export function resolveConflict(
  report: MergeReport,
  conflictId: string,
  resolution: ProcedureConflict['resolution'],
): MergeReport {
  const conflicts = report.procedures.conflicts.map((c) =>
    c.id === conflictId ? { ...c, resolution } : c,
  );
  return {
    ...report,
    procedures: { ...report.procedures, conflicts },
    hasUnresolvedConflicts: conflicts.some((c) => !c.resolution),
  };
}

/** 同一标本字段两边不一致时的取边（默认保留本机，绝不整包覆盖晚到一边） */
export type SpecimenResolution = 'keep-local' | 'take-incoming';

/** 游离影像处理方式：挂到标本级留痕（不挂节点）或丢弃不导入 */
export type OrphanPhotoDecision = 'attach-specimen' | 'discard';

export interface OrphanPhotoChoice {
  photoId: string;
  decision: OrphanPhotoDecision;
  /** decision=attach-specimen 时挂到哪个标本号下 */
  specimenNo?: string;
}

/** 确认页的全部人工选择 */
export interface MergeChoices {
  specimenResolution: Record<string, SpecimenResolution>;
  orphanPhotos: OrphanPhotoChoice[];
}

/** 入库结果（回显用） */
export interface MergeApplyResult {
  insertedSpecimens: number;
  updatedSpecimens: number;
  insertedProcedures: number;
  resolvedConflicts: number;
  insertedLots: number;
  appliedIssues: number;
  duplicateIssues: number;
  blockedIssues: number;
  insertedPhotos: number;
  attachedOrphanPhotos: number;
  discardedPhotos: number;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
