/**
 * 断网双机档案合并的对账模型。
 *
 * 现场发掘站断网，工序分别录在两台设备上；回馆后把对端导出的档案文件
 * 导入本机做合并。为避免「整份导入覆盖晚到一边」，本机数据绝不被整包覆盖：
 * - 标本按标本号认同一标本；
 * - 同一工序两边都改过 -> 冲突，并排列出，人工确认后才入库；
 * - 材料领用按批号对账，批号缺项未补齐前领用不生效；
 * - 影像与工序可能对不上，按「标本 + 节点序号」重挂，挂不上的列入待处理。
 */
import type { Specimen } from './specimen';
import type { PrepProcedure } from './procedure';
import type { SupplyIssue, SupplyLot } from './supply';
import type { PrepPhoto } from './photo';

/** 档案文件结构版本 */
export const ARCHIVE_FORMAT = 1;
export const ARCHIVE_MAGIC = 'gbfossilprep-archive';

/** 导出 / 导入的整包档案 */
export interface ArchiveBundle {
  magic: typeof ARCHIVE_MAGIC;
  format: number;
  /** 导出设备名（回显用，便于辨认是哪台机器） */
  device: string;
  exportedAt: number;
  specimens: Specimen[];
  procedures: PrepProcedure[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
}

/** 标本字段级差异（同一标本号、两边记录不一致） */
export interface SpecimenFieldDiff {
  field: keyof Specimen;
  label: string;
  local: unknown;
  incoming: unknown;
}

/** 标本对账行 */
export interface SpecimenMatch {
  specimenNo: string;
  status: 'local-only' | 'incoming-only' | 'identical' | 'changed';
  local?: Specimen;
  incoming?: Specimen;
  diffs: SpecimenFieldDiff[];
}

/** 工序冲突：同一标本的同一序号节点，两边都改过且内容不同 */
export interface ProcedureConflict {
  id: string;
  specimenNo: string;
  seq: number;
  local: PrepProcedure;
  incoming: PrepProcedure;
  /** 人工裁决：take-local / take-incoming，未裁决前不允许入库 */
  resolution?: ProcedureResolution;
}

export type ProcedureResolution = 'take-local' | 'take-incoming';

/** 对账后处于游离状态的影像（引用的工序在两边都找不到） */
export interface OrphanPhoto {
  photo: PrepPhoto;
  reason: 'no-specimen' | 'no-node';
  specimenNo?: string;
  seq?: number;
}

/** 按批号对账的一条领用记录 */
export interface IssueReconcile {
  key: string;
  lotNo: string;
  issue: SupplyIssue;
  status: 'apply' | 'duplicate' | 'blocked';
  /** blocked 时说明缺什么批号 */
  reason?: string;
}

/** 材料批号对账结果 */
export interface LotReconcile {
  lotNo: string;
  status: 'matched' | 'incoming-only' | 'local-only';
  local?: SupplyLot;
  incoming?: SupplyLot;
  issues: IssueReconcile[];
}

/** 一次合并的完整对账报告 */
export interface MergeReport {
  device: string;
  exportedAt: number;
  photoBytes: number;
  specimens: SpecimenMatch[];
  procedures: {
    addedFromIncoming: number;
    localOnlyKept: number;
    identical: number;
    conflicts: ProcedureConflict[];
  };
  lots: LotReconcile[];
  photos: {
    added: number;
    identical: number;
    orphans: OrphanPhoto[];
  };
  /** 是否存在容量 / 结构等硬性阻断（存在则一律拒绝合并、保留原档） */
  blocked: boolean;
  blockReasons: string[];
  /** 批号缺项：领用所引用、但两边都不存在该批次 */
  missingLotNos: string[];
  /** 是否还有未裁决的工序冲突 */
  hasUnresolvedConflicts: boolean;
  /** 是否还有挂不上的影像待人工处理 */
  hasOrphanPhotos: boolean;
}

/** 档案文件解析失败 */
export class ArchiveParseError extends Error {}
