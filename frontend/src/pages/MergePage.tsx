import { useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import MergeIcon from '@mui/icons-material/Merge';
import ScienceIcon from '@mui/icons-material/Science';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import {
  parseArchive,
  buildMergeReport,
  resolveConflict,
  formatBytes,
  type SpecimenResolution,
  type MergeChoices,
  type OrphanPhotoDecision,
} from '../utils/merge';
import {
  applyMerge,
  downloadArchive,
  exportArchive,
  getDeviceName,
  readSnapshot,
  setDeviceName,
  type MergeApplyResult,
} from '../utils/mergeApply';
import { makeSketchDataUrl } from '../types/photo';
import type { ArchiveBundle, MergeReport } from '../types/merge';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function procedureDigest(p: {
  stepType: string;
  nodeName: string;
  tools: string[];
  abrasive: string;
  adhesive: string;
  adhesiveConc: number;
  durationMin: number;
  tempC: number;
  rh: number;
  operator: string;
  state: string;
  startedAt: number;
}) {
  return [
    ['类型', p.stepType],
    ['节点', p.nodeName],
    ['工具', p.tools.join('、') || '—'],
    ['磨料', p.abrasive || '—'],
    ['胶种', p.adhesive ? `${p.adhesive}（${p.adhesiveConc}%）` : '—'],
    ['耗时', `${p.durationMin} min`],
    ['温湿度', `${p.tempC}℃ / ${p.rh}%`],
    ['操作人', p.operator],
    ['状态', p.state === 'done' ? '已完成' : p.state === 'rolledback' ? '已回退' : '待办'],
    ['开始', formatTime(p.startedAt)],
  ] as [string, string][];
}

/** 构造一份与本机数据「两边都改过」的示例对端档案，供无第二台设备时演示对账流程 */
function buildDemoBundle(): ArchiveBundle {
  return {
    magic: 'gbfossilprep-archive',
    format: 1,
    device: '发掘站乙机（示例）',
    exportedAt: Date.now(),
    specimens: [
      {
        id: 'demo-spm-1',
        specimenNo: 'FP-2024-0031',
        taxon: 'Sinokannemeyeria yingchiaoensis（山西肯氏兽）',
        horizon: '中三叠统二马营组',
        locality: '山西武乡',
        lithology: '紫红色粉砂质泥岩',
        matrixHardness: 2.5,
        dimensions: '320×210×150',
        weight: 4790,
        storageBox: 'A 区 3 匣 2 格',
        status: '已加固',
        createdAt: Date.now() - 9e8,
      },
      {
        id: 'demo-spm-2',
        specimenNo: 'FP-2024-0077',
        taxon: 'Eumetabolodon sp.（正齿兽）',
        horizon: '中三叠统',
        locality: '山西榆社',
        lithology: '灰绿色泥岩',
        matrixHardness: 3.1,
        dimensions: '96×70×42',
        weight: 620,
        storageBox: 'C 区 2 匣 1 格',
        status: '修复中',
        createdAt: Date.now() - 3 * 864e5,
      },
    ],
    procedures: [
      {
        id: 'demo-prc-1',
        specimenId: 'demo-spm-1',
        stepType: '加固',
        nodeName: '围岩裂隙渗透加固（乙机补录浓度）',
        seq: 2,
        tools: ['渗透滴管', '真空浸渗罐'],
        abrasive: '',
        adhesive: 'Paraloid B-72',
        adhesiveConc: 8,
        durationMin: 120,
        tempC: 24,
        rh: 42,
        photoBeforeIds: [],
        photoAfterIds: ['demo-pho-1'],
        operator: '周知行',
        startedAt: Date.now() - 2 * 864e5,
        state: 'done',
        finishedAt: Date.now() - 2 * 864e5 + 120 * 60000,
      },
      {
        id: 'demo-prc-2',
        specimenId: 'demo-spm-2',
        stepType: '清修',
        nodeName: '头甲表面粗清',
        seq: 1,
        tools: ['剔针', '软毛刷'],
        abrasive: '1200 目',
        adhesive: '',
        adhesiveConc: 0,
        durationMin: 70,
        tempC: 22,
        rh: 50,
        photoBeforeIds: [],
        photoAfterIds: [],
        operator: '周知行',
        startedAt: Date.now() - 864e5,
        state: 'pending',
      },
    ],
    supplies: [
      {
        id: 'demo-sup-1',
        name: 'Paraloid B-72',
        kind: '胶种',
        spec: '分析纯 500 g',
        lotNo: 'B72-20240312',
        qty: 3,
        unit: '瓶',
        openedAt: Date.now() - 40 * 864e5,
        shelfLifeMonths: 36,
        lowThreshold: 2,
        issues: [
          {
            id: 'demo-iss-1',
            lotNo: 'B72-20240312',
            qty: 2,
            operator: '周知行',
            specimenNo: 'FP-2024-0031',
            issuedAt: Date.now() - 2 * 864e5,
          },
        ],
      },
      {
        id: 'demo-sup-2',
        name: '环氧树脂 E44',
        kind: '胶种',
        spec: '工业级 1 kg',
        lotNo: 'E44-20240901',
        qty: 2,
        unit: '桶',
        openedAt: Date.now() - 20 * 864e5,
        shelfLifeMonths: 24,
        lowThreshold: 1,
        issues: [],
      },
    ],
    photos: [
      {
        id: 'demo-pho-1',
        specimenId: 'demo-spm-1',
        procedureId: 'demo-prc-1',
        stage: 'after',
        caption: '乙机 · 加固后裂隙复测',
        dataUrl: makeSketchDataUrl('加固后 · FP-2024-0031（乙机）', '#4a3f5a'),
        capturedAt: Date.now() - 2 * 864e5,
      },
      {
        id: 'demo-pho-orphan',
        specimenId: 'demo-spm-gone',
        procedureId: 'demo-prc-gone',
        stage: 'process',
        caption: '乙机 · 游离影像（引用记录缺失）',
        dataUrl: makeSketchDataUrl('游离影像示例', '#5a4a3f'),
        capturedAt: Date.now() - 864e5,
      },
    ],
  };
}

/** /merge 断网双机档案合并：导出本机档、导入对端档、逐项对账确认后原子入库 */
export default function MergePage() {
  const specimens = useSpecimenStore((s) => s.items);
  const procedures = useProcedureStore((s) => s.items);
  const lots = useSupplyStore((s) => s.items);
  const reloadSpecimens = useSpecimenStore((s) => s.load);
  const reloadProcedures = useProcedureStore((s) => s.load);
  const reloadSupplies = useSupplyStore((s) => s.load);

  const [device, setDevice] = useState(getDeviceName() || '本机（甲机）');
  const [report, setReport] = useState<MergeReport | null>(null);
  const [incoming, setIncoming] = useState<ArchiveBundle | null>(null);
  const [fileName, setFileName] = useState('');
  const [choices, setChoices] = useState<MergeChoices>({ specimenResolution: {}, orphanPhotos: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [result, setResult] = useState<MergeApplyResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const specimenNos = useMemo(() => specimens.map((s) => s.specimenNo), [specimens]);

  // 游离影像可挂的标本号：本机已有 + 本次随对端档案新增的
  const attachableSpecimenNos = useMemo(() => {
    const incomingOnly = report?.specimens.filter((m) => m.status === 'incoming-only').map((m) => m.specimenNo) ?? [];
    return Array.from(new Set([...specimenNos, ...incomingOnly]));
  }, [specimenNos, report]);

  const resetReview = () => {
    setReport(null);
    setIncoming(null);
    setFileName('');
    setChoices({ specimenResolution: {}, orphanPhotos: [] });
    setResult(null);
  };

  const handleExport = async () => {
    setDeviceName(device);
    const bundle = await exportArchive(device);
    downloadArchive(bundle);
    setToast(`已导出本机档案（${bundle.specimens.length} 件标本 / ${bundle.photos.length} 张影像），交予对端设备导入`);
  };

  const reviewBundle = async (bundle: ArchiveBundle, name: string) => {
    setError('');
    setBusy(true);
    try {
      const snapshot = await readSnapshot();
      const rep = await buildMergeReport(snapshot, bundle);
      setIncoming(bundle);
      setReport(rep);
      setFileName(name);
      setChoices({ specimenResolution: {}, orphanPhotos: [] });
      setResult(null);
    } catch (e) {
      setError((e as Error).message);
      resetReview();
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    const text = await file.text();
    try {
      const bundle = parseArchive(text);
      await reviewBundle(bundle, file.name);
    } catch (e) {
      setError((e as Error).message);
      resetReview();
    }
  };

  const setSpecimenSide = (no: string, side: SpecimenResolution) => {
    setChoices((c) => ({ ...c, specimenResolution: { ...c.specimenResolution, [no]: side } }));
  };

  const setConflictSide = (conflictId: string, resolution: 'take-local' | 'take-incoming') => {
    if (!report) return;
    setReport(resolveConflict(report, conflictId, resolution));
  };

  const setOrphanChoice = (photoId: string, decision: OrphanPhotoDecision, specimenNo?: string) => {
    setChoices((c) => {
      const rest = c.orphanPhotos.filter((x) => x.photoId !== photoId);
      return { ...c, orphanPhotos: [...rest, { photoId, decision, specimenNo }] };
    });
  };

  const canCommit =
    !!report &&
    !report.blocked &&
    !report.hasUnresolvedConflicts &&
    report.photos.orphans.every((o) => {
      const ch = choices.orphanPhotos.find((x) => x.photoId === o.photo.id);
      return ch && (ch.decision === 'discard' || (ch.decision === 'attach-specimen' && !!ch.specimenNo));
    });

  const handleCommit = async () => {
    if (!report || !incoming) return;
    setBusy(true);
    setError('');
    try {
      const snapshot = await readSnapshot();
      const r = await applyMerge(snapshot, incoming, report, choices);
      setResult(r);
      await Promise.all([reloadSpecimens(), reloadProcedures(), reloadSupplies()]);
      setToast('合并已入库');
    } catch (e) {
      // 事务失败：无任何写入，可直接重新确认或换文件重试
      setError(`合并未生效，原档完整保留：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const changedSpecimens = report?.specimens.filter((m) => m.status === 'changed') ?? [];
  const newSpecimens = report?.specimens.filter((m) => m.status === 'incoming-only') ?? [];

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <MergeIcon color="primary" />
        <Typography variant="h5" fontWeight={700}>
          断网双机档案合并
        </Typography>
        <Chip size="small" label={`本机 ${specimens.length} 件标本 · ${procedures.length} 个节点 · ${lots.length} 个批次`} />
      </Stack>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          ① 在两台设备上各导出一份档案
        </Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <TextField
            size="small"
            label="本机设备名（写入档案，便于辨认来源）"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            sx={{ minWidth: 260 }}
          />
          <Button variant="contained" startIcon={<DownloadIcon />} onClick={handleExport}>
            导出本机档案
          </Button>
          <Typography variant="caption" color="text.secondary">
            导出整包（标本 / 工序 / 材料批次 / 影像）为 JSON，用 U 盘或内网互传。
          </Typography>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          ② 导入对端设备档案并对账
        </Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} useFlexGap>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          <Button variant="contained" color="secondary" startIcon={<UploadFileIcon />} onClick={() => fileRef.current?.click()}>
            选择对端档案文件
          </Button>
          <Button
            startIcon={<ScienceIcon />}
            onClick={() => void reviewBundle(buildDemoBundle(), 'demo-archive.json')}
          >
            载入示例档案（演示用）
          </Button>
          {fileName ? <Chip size="small" label={fileName} onDelete={resetReview} /> : null}
        </Stack>
        <Alert severity="info" sx={{ mt: 1.5 }}>
          合并不会整包覆盖：标本按标本号认同一件；同一工序两边都改过会并排列出，逐组确认后才入库；
          材料领用按批号对账，批号缺项补齐前领用不生效；影像按「标本 + 节点序号」自动重挂。
          存储空间不足或合并中途失败都会整单回滚，原档不动，可重新选择文件重试。
        </Alert>
      </Paper>

      {error ? <Alert severity="error" onClose={() => setError('')}>{error}</Alert> : null}

      {result ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            合并完成
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Chip label={`新增标本 ${result.insertedSpecimens}`} />
            <Chip label={`更新标本 ${result.updatedSpecimens}`} />
            <Chip label={`新增工序节点 ${result.insertedProcedures}`} />
            <Chip label={`裁决冲突节点 ${result.resolvedConflicts}`} />
            <Chip label={`新增材料批次 ${result.insertedLots}`} />
            <Chip label={`生效领用 ${result.appliedIssues}`} color="success" variant="outlined" />
            <Chip label={`重复领用跳过 ${result.duplicateIssues}`} variant="outlined" />
            <Chip label={`缺批号挂起 ${result.blockedIssues}`} color="warning" />
            <Chip label={`新增影像 ${result.insertedPhotos}`} />
            <Chip label={`游离影像挂入 ${result.attachedOrphanPhotos}`} variant="outlined" />
            <Chip label={`丢弃影像 ${result.discardedPhotos}`} variant="outlined" />
          </Box>
          <Button sx={{ mt: 2 }} onClick={resetReview}>
            再合并一份档案
          </Button>
        </Paper>
      ) : null}

      {report && !result ? (
        <ReviewPanel
          report={report}
          choices={choices}
          specimenNos={attachableSpecimenNos}
          busy={busy}
          canCommit={!!canCommit}
          onSpecimenSide={setSpecimenSide}
          onConflictSide={setConflictSide}
          onOrphanChoice={setOrphanChoice}
          onCommit={handleCommit}
          newSpecimenCount={newSpecimens.length}
          changedSpecimens={changedSpecimens}
        />
      ) : null}

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

interface ReviewProps {
  report: MergeReport;
  choices: MergeChoices;
  specimenNos: string[];
  busy: boolean;
  canCommit: boolean;
  newSpecimenCount: number;
  changedSpecimens: MergeReport['specimens'];
  onSpecimenSide: (no: string, side: SpecimenResolution) => void;
  onConflictSide: (id: string, side: 'take-local' | 'take-incoming') => void;
  onOrphanChoice: (photoId: string, decision: OrphanPhotoDecision, specimenNo?: string) => void;
  onCommit: () => void;
}

function ReviewPanel(props: ReviewProps) {
  const { report, choices, specimenNos, busy, canCommit, onSpecimenSide, onConflictSide, onOrphanChoice, onCommit, newSpecimenCount, changedSpecimens } = props;
  const blockedIssues = report.lots.reduce((n, l) => n + l.issues.filter((i) => i.status === 'blocked').length, 0);

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" fontWeight={700}>
            对账结果
          </Typography>
          <Chip size="small" label={`来自：${report.device}`} />
          <Chip size="small" label={`导出时间：${formatTime(report.exportedAt)}`} />
          <Chip size="small" label={`影像体积约 ${formatBytes(report.photoBytes)}`} />
          <Box sx={{ flex: 1 }} />
          <Button variant="contained" color="primary" disabled={!canCommit || busy} onClick={onCommit}>
            {busy ? '入库中…' : '确认并入本机档案库'}
          </Button>
        </Stack>
        {!canCommit ? (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            请先完成下列人工确认：工序冲突逐组选边、挂不上的影像逐张决定去向。
          </Alert>
        ) : (
          <Alert severity="success" sx={{ mt: 1.5 }}>
            所有冲突均已裁决，入库将在单个事务中完成；失败自动回滚，不影响本机原档。
          </Alert>
        )}
      </Paper>

      {report.blocked ? (
        <Alert severity="error">
          {report.blockReasons.map((r) => (
            <div key={r}>{r}</div>
          ))}
        </Alert>
      ) : null}

      {/* 标本 */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={700}>标本</Typography>
          <Chip size="small" label={`新增 ${newSpecimenCount}`} color="success" variant="outlined" />
          <Chip size="small" label={`字段差异 ${changedSpecimens.length}`} color="warning" />
        </Stack>
        {changedSpecimens.length === 0 ? (
          <Typography variant="body2" color="text.secondary">共有标本的登记信息一致，无需取舍。</Typography>
        ) : (
          <Stack spacing={1.5}>
            {changedSpecimens.map((m) => {
              const side = choices.specimenResolution[m.specimenNo] ?? 'keep-local';
              return (
                <Box key={m.specimenNo}>
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                    <Typography variant="subtitle2">{m.specimenNo}</Typography>
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={side}
                      onChange={(_, v) => v && onSpecimenSide(m.specimenNo, v as SpecimenResolution)}
                    >
                      <ToggleButton value="keep-local">保留本机</ToggleButton>
                      <ToggleButton value="take-incoming">采用对端</ToggleButton>
                    </ToggleButtonGroup>
                  </Stack>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>字段</TableCell>
                        <TableCell>本机</TableCell>
                        <TableCell>对端（{report.device}）</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {m.diffs.map((d) => (
                        <TableRow key={d.field}>
                          <TableCell>{d.label}</TableCell>
                          <TableCell sx={side === 'keep-local' ? { bgcolor: 'success.light' } : undefined}>
                            {String(d.local ?? '—')}
                          </TableCell>
                          <TableCell sx={side === 'take-incoming' ? { bgcolor: 'info.light' } : undefined}>
                            {String(d.incoming ?? '—')}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              );
            })}
          </Stack>
        )}
      </Paper>

      {/* 工序 */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" fontWeight={700}>工序节点</Typography>
          <Chip size="small" label={`对端新增 ${report.procedures.addedFromIncoming}`} color="success" variant="outlined" />
          <Chip size="small" label={`本机独有保留 ${report.procedures.localOnlyKept}`} variant="outlined" />
          <Chip size="small" label={`一致 ${report.procedures.identical}`} variant="outlined" />
          <Chip size="small" color={report.procedures.conflicts.length ? 'error' : 'default'} label={`两边都改过 ${report.procedures.conflicts.length}`} />
        </Stack>
        {report.procedures.conflicts.length === 0 ? (
          <Typography variant="body2" color="text.secondary">没有同一节点两边都改的情况。</Typography>
        ) : (
          <Stack spacing={2}>
            {report.procedures.conflicts.map((c) => {
              const side = c.resolution ?? '';
              const localRows = procedureDigest(c.local);
              const incomingRows = procedureDigest(c.incoming);
              const rowKeys = Array.from(new Set([...localRows.map((r) => r[0]), ...incomingRows.map((r) => r[0])]));
              const lv = new Map(localRows);
              const rv = new Map(incomingRows);
              return (
                <Box key={c.id}>
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }} flexWrap="wrap" useFlexGap>
                    <Typography variant="subtitle2">
                      {c.specimenNo} · 节点 #{c.seq}
                    </Typography>
                    {!c.resolution ? <Chip size="small" color="error" label="待确认" /> : <Chip size="small" color="success" label="已选边" />}
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={side}
                      onChange={(_, v) => v && onConflictSide(c.id, v)}
                    >
                      <ToggleButton value="take-local">保留本机</ToggleButton>
                      <ToggleButton value="take-incoming">采用对端</ToggleButton>
                    </ToggleButtonGroup>
                  </Stack>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ width: 90 }}>项</TableCell>
                        <TableCell>本机</TableCell>
                        <TableCell>对端（{report.device}）</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rowKeys.map((k) => {
                        const a = lv.get(k) ?? '—';
                        const b = rv.get(k) ?? '—';
                        const diff = a !== b;
                        return (
                          <TableRow key={k} sx={diff ? { bgcolor: 'warning.light' } : undefined}>
                            <TableCell>{k}</TableCell>
                            <TableCell sx={side === 'take-local' && diff ? { outline: '2px solid #2e7d32' } : undefined}>{a}</TableCell>
                            <TableCell sx={side === 'take-incoming' && diff ? { outline: '2px solid #1565c0' } : undefined}>{b}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Box>
              );
            })}
          </Stack>
        )}
      </Paper>

      {/* 材料 */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" fontWeight={700}>材料领用（按批号对账）</Typography>
          <Chip size="small" label={`批号 ${report.lots.length} 个`} />
          {blockedIssues > 0 ? <Chip size="small" color="warning" label={`缺项领用挂起 ${blockedIssues} 笔`} /> : null}
          {report.missingLotNos.length > 0 ? (
            <Chip size="small" color="error" label={`缺批号：${report.missingLotNos.join('、')}`} />
          ) : null}
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>批号</TableCell>
              <TableCell>批次对账</TableCell>
              <TableCell>对端领用明细</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {report.lots.map((lr) => (
              <TableRow key={lr.lotNo} hover>
                <TableCell>{lr.lotNo}</TableCell>
                <TableCell>
                  {lr.status === 'matched' ? (
                    <Chip size="small" color="success" variant="outlined" label="两边都有 · 库存以本机为准" />
                  ) : lr.status === 'incoming-only' && lr.incoming ? (
                    <Chip size="small" color="info" variant="outlined" label="对端新批次 · 整批并入" />
                  ) : lr.incoming ? null : (
                    <Chip size="small" color="warning" label="两边都缺该批次" />
                  )}
                </TableCell>
                <TableCell>
                  {lr.issues.length === 0 ? (
                    <Typography variant="caption" color="text.secondary">无对端领用（批次本身仍会并入）</Typography>
                  ) : (
                    <Stack spacing={0.5}>
                      {lr.issues.map((ir) => (
                        <Box key={ir.key}>
                          {ir.status === 'apply' ? (
                            <Chip
                              size="small"
                              color="success"
                              variant="outlined"
                              label={`生效：${ir.issue.operator} 领 ${ir.issue.qty} → ${ir.issue.specimenNo}（${formatTime(ir.issue.issuedAt)}）`}
                            />
                          ) : ir.status === 'duplicate' ? (
                            <Chip size="small" variant="outlined" label={`已存在，跳过：${ir.issue.operator} 领 ${ir.issue.qty} → ${ir.issue.specimenNo}`} />
                          ) : (
                            <Chip size="small" color="warning" label={`挂起不生效：${ir.issue.operator} 领 ${ir.issue.qty}（${ir.reason}）`} />
                          )}
                        </Box>
                      ))}
                    </Stack>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          同一批号两边都有时，本机库存为主，只追加对端新领用并扣减在库；缺批号的领用先挂起，请到材料台账补齐该批次后重新导入档案，挂起记录即会生效。
        </Typography>
      </Paper>

      {/* 影像 */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" fontWeight={700}>影像</Typography>
          <Chip size="small" color="success" variant="outlined" label={`自动重挂新增 ${report.photos.added}`} />
          <Chip size="small" variant="outlined" label={`两边一致 ${report.photos.identical}`} />
          <Chip size="small" color={report.photos.orphans.length ? 'warning' : 'default'} label={`挂不上 ${report.photos.orphans.length}`} />
        </Stack>
        {report.photos.orphans.length === 0 ? (
          <Typography variant="body2" color="text.secondary">对端影像均能按标本与节点序号对上。</Typography>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' }, gap: 1.5 }}>
            {report.photos.orphans.map((o) => {
              const ch = choices.orphanPhotos.find((x) => x.photoId === o.photo.id);
              return (
                <Paper key={o.photo.id} variant="outlined" sx={{ p: 1 }}>
                  <Box component="img" src={o.photo.dataUrl} alt={o.photo.caption} sx={{ width: '100%', borderRadius: 1 }} />
                  <Typography variant="caption" display="block" noWrap title={o.photo.caption}>{o.photo.caption}</Typography>
                  <Alert severity="warning" sx={{ py: 0, my: 0.5 }}>
                    {o.reason === 'no-specimen'
                      ? '对端引用的标本在两边都找不到'
                      : `对得上标本 ${o.specimenNo ?? '?'}，但找不到节点${o.seq ? ` #${o.seq}` : ''}`}
                  </Alert>
                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={ch?.decision ?? ''}
                    onChange={(_, v: OrphanPhotoDecision) => onOrphanChoice(o.photo.id, v, ch?.specimenNo)}
                  >
                    <ToggleButton value="attach-specimen">挂到标本</ToggleButton>
                    <ToggleButton value="discard">丢弃不导入</ToggleButton>
                  </ToggleButtonGroup>
                  {ch?.decision === 'attach-specimen' ? (
                    <TextField
                      select
                      size="small"
                      fullWidth
                      sx={{ mt: 1 }}
                      label="选择标本"
                      value={ch.specimenNo ?? ''}
                      onChange={(e) => onOrphanChoice(o.photo.id, 'attach-specimen', e.target.value)}
                    >
                      {specimenNos.map((no) => (
                        <MenuItem key={no} value={no}>{no}</MenuItem>
                      ))}
                    </TextField>
                  ) : null}
                </Paper>
              );
            })}
          </Box>
        )}
      </Paper>

      <Divider />
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button variant="contained" size="large" disabled={!canCommit || busy} onClick={onCommit}>
          {busy ? '入库中…' : '确认并入本机档案库'}
        </Button>
      </Stack>
    </Stack>
  );
}
