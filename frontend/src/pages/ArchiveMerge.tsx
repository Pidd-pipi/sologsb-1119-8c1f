import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Divider from '@mui/material/Divider';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import MergeTypeIcon from '@mui/icons-material/MergeType';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import {
  applyMerge,
  buildApplySet,
  checkCapacity,
  computeMergePlan,
  diffProcedures,
  downloadArchive,
  EMPTY_RESOLUTIONS,
  exportArchive,
  formatBytes,
  hasUnresolved,
  loadLocalData,
  parseArchiveFile,
  type ArchiveFile,
  type CapacityInfo,
  type MergePlan,
  type MergeResolutions,
} from '../utils/archive';
import type { SpecimenDraft } from '../types/specimen';

type Phase = 'idle' | 'parsed' | 'applying' | 'done' | 'error';

/** /merge 档案合并：导出 / 导入比对 / 冲突并排确认 / 缺项补齐 / 容量预检 + 事务入库 */
export default function ArchiveMerge() {
  const reloadSpecimens = useSpecimenStore((s) => s.load);
  const reloadProcedures = useProcedureStore((s) => s.load);
  const reloadSupplies = useSupplyStore((s) => s.load);
  const fileRef = useRef<HTMLInputElement>(null);

  const [archive, setArchive] = useState<ArchiveFile | null>(null);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [resolutions, setResolutions] = useState<MergeResolutions>(EMPTY_RESOLUTIONS);
  const [capacity, setCapacity] = useState<CapacityInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [fileName, setFileName] = useState('');

  const applySet = useMemo(
    () => (plan ? buildApplySet(plan, resolutions) : null),
    [plan, resolutions],
  );

  const unresolved = useMemo(
    () => (plan ? hasUnresolved(plan, resolutions) : false),
    [plan, resolutions],
  );

  // 容量预检：随决议变化，按「待入库记录」实际大小估算；不足则拒绝并保留原档
  useEffect(() => {
    if (!plan || !applySet) {
      setCapacity(null);
      return;
    }
    let alive = true;
    void checkCapacity(applySet.bytes).then((cap) => {
      if (alive) setCapacity(cap);
    });
    return () => {
      alive = false;
    };
  }, [plan, applySet]);

  // 可用于「映射到现有标本」的标本号集合（本地 + 新增 + 缺项新建补齐）
  const availableSpecimenNos = useMemo(() => {
    if (!plan) return [];
    const set = new Set<string>();
    for (const s of plan.matchedSpecimens) set.add(s.specimenNo);
    for (const s of plan.newSpecimens) set.add(s.specimenNo);
    for (const res of Object.values(resolutions.issues)) {
      if (res?.type === 'create') set.add(res.draft.specimenNo.trim());
    }
    return Array.from(set);
  }, [plan, resolutions.issues]);

  // 可用于「映射到现有工序」的工序 key 集合
  const availableProcKeys = useMemo(() => {
    if (!plan) return [];
    return Object.keys(plan.procKeyMap);
  }, [plan]);

  const resetAll = () => {
    setArchive(null);
    setPlan(null);
    setResolutions(EMPTY_RESOLUTIONS);
    setCapacity(null);
    setPhase('idle');
    setError('');
    setFileName('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const onExport = async () => {
    try {
      const arch = await exportArchive();
      downloadArchive(arch);
      setToast('档案已导出');
    } catch {
      setError('导出失败，请重试');
    }
  };

  const onFile = async (file: File) => {
    setError('');
    setFileName(file.name);
    try {
      const arch = await parseArchiveFile(file);
      const local = await loadLocalData();
      const mergePlan = computeMergePlan(local, arch);
      setArchive(arch);
      setPlan(mergePlan);
      setResolutions(EMPTY_RESOLUTIONS);
      setPhase('parsed');
    } catch (e) {
      setError(e instanceof Error ? e.message : '档案解析失败');
      setArchive(null);
      setPlan(null);
      setPhase('error');
    }
  };

  const onApply = async () => {
    if (!plan || !applySet) return;
    setPhase('applying');
    setError('');
    try {
      await applyMerge(applySet);
      await Promise.all([reloadSpecimens(), reloadProcedures(), reloadSupplies()]);
      setPhase('done');
      setToast('合并完成，档案已入库');
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : '合并失败');
    }
  };

  const onRetry = async () => {
    if (!applySet) return;
    setPhase('applying');
    setError('');
    try {
      await applyMerge(applySet);
      await Promise.all([reloadSpecimens(), reloadProcedures(), reloadSupplies()]);
      setPhase('done');
      setToast('重试成功，档案已入库');
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : '合并失败');
    }
  };

  const conflictCount = plan?.procedureConflicts.length ?? 0;
  const orphanIssueCount = plan?.orphanIssues.length ?? 0;
  const orphanPhotoCount = plan?.orphanPhotos.length ?? 0;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          档案合并
        </Typography>
        <Chip size="small" variant="outlined" label="离线双机回馆合并" />
      </Stack>

      <Alert severity="info" icon={<MergeTypeIcon />}>
        发掘站断网录工序，回馆后用文件把两台设备的档案合并。按标本号认同一标本；同一工序两边都改过时并排确认后才入库；材料领用按批号对账；领用 / 影像引用缺失即为「缺项」，补齐前不生效；容量不足拒绝合并并保留原档，失败可重试。
      </Alert>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Typography variant="subtitle1" fontWeight={700}>
              ① 导出本机档案
            </Typography>
            <Typography variant="body2" color="text.secondary">
              把本机四张表（标本 / 工序 / 材料批次 / 影像）导出为一个 JSON 文件，拷到另一台设备比对。
            </Typography>
            <Box>
              <Button variant="contained" startIcon={<DownloadIcon />} onClick={onExport}>
                导出当前档案
              </Button>
            </Box>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Typography variant="subtitle1" fontWeight={700}>
              ② 导入另一台设备的档案
            </Typography>
            <Typography variant="body2" color="text.secondary">
              选择对方设备导出的 JSON 文件，先比对再确认入库，不会整份覆盖本机。
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Button variant="outlined" component="label" startIcon={<UploadFileIcon />}>
                选择档案文件
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onFile(f);
                  }}
                />
              </Button>
              {fileName ? (
                <Typography variant="caption" color="text.secondary" noWrap>
                  {fileName}
                </Typography>
              ) : null}
            </Stack>
          </Stack>
        </Paper>
      </Box>

      {error ? (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}

      {plan && archive ? (
        <>
          {/* 容量预检 */}
          {capacity ? (
            <Alert severity={capacity.ok ? 'info' : 'error'} icon={capacity.ok ? undefined : <WarningAmberIcon />}>
              {capacity.ok
                ? `容量预检通过：待入库约 ${formatBytes(applySet?.bytes ?? 0)}，浏览器可用约 ${formatBytes(capacity.available)}。`
                : capacity.reason}
            </Alert>
          ) : null}

          {/* 合并摘要 */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip size="small" label={`标本匹配 ${plan.matchedSpecimens.length}`} color="success" variant="outlined" />
              <Chip size="small" label={`新增标本 ${plan.newSpecimens.length}`} />
              <Chip size="small" label={`工序冲突 ${conflictCount}`} color={conflictCount ? 'warning' : 'default'} />
              <Chip size="small" label={`新增工序 ${plan.newProcedures.length}`} />
              <Chip size="small" label={`材料对账 ${plan.supplyReconciles.length}`} color="info" variant="outlined" />
              <Chip size="small" label={`新增批次 ${plan.newSupplies.length}`} />
              <Chip size="small" label={`新增影像 ${plan.newPhotos.length}`} />
              <Chip
                size="small"
                label={`缺项 ${orphanIssueCount + orphanPhotoCount}`}
                color={orphanIssueCount + orphanPhotoCount ? 'error' : 'default'}
              />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              档案版本 v{archive.version} · 导出时间 {new Date(archive.exportedAt).toLocaleString('zh-CN')}
              {archive.device ? ` · 设备 ${archive.device}` : ''}
            </Typography>
          </Paper>

          {/* 工序冲突：并排确认 */}
          {conflictCount > 0 ? (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                工序冲突（{conflictCount}）· 两边都改过，请并排确认保留哪一边
              </Typography>
              <Stack spacing={2}>
                {plan.procedureConflicts.map((c) => {
                  const rows = diffProcedures(c.local, c.imported);
                  const chosen = resolutions.conflicts[c.key];
                  return (
                    <Paper key={c.key} variant="outlined" sx={{ p: 1.5 }}>
                      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                        <Chip size="small" label={`${c.specimenNo} #${c.seq}`} color="primary" variant="outlined" />
                        <Typography variant="subtitle2" fontWeight={700}>
                          {c.local.stepType} · {c.local.nodeName}
                        </Typography>
                        <Box sx={{ flex: 1 }} />
                        {!chosen ? <Chip size="small" color="warning" label="待确认" /> : null}
                      </Stack>
                      <Table size="small" sx={{ mt: 1 }}>
                        <TableHead>
                          <TableRow>
                            <TableCell sx={{ width: 120 }}>字段</TableCell>
                            <TableCell>本机（保留本地）</TableCell>
                            <TableCell>导入（采用导入）</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {rows.map((r) => (
                            <TableRow key={r.field}>
                              <TableCell>{r.label}</TableCell>
                              <TableCell sx={{ color: chosen === 'local' ? 'success.main' : 'text.primary' }}>
                                {r.local}
                              </TableCell>
                              <TableCell sx={{ color: chosen === 'imported' ? 'success.main' : 'text.primary' }}>
                                {r.imported}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <RadioGroup
                        row
                        value={chosen ?? ''}
                        onChange={(e) =>
                          setResolutions((prev) => ({
                            ...prev,
                            conflicts: { ...prev.conflicts, [c.key]: e.target.value as 'local' | 'imported' },
                          }))
                        }
                      >
                        <FormControlLabel value="local" control={<Radio />} label="保留本机版本" />
                        <FormControlLabel value="imported" control={<Radio />} label="采用导入版本" />
                      </RadioGroup>
                    </Paper>
                  );
                })}
              </Stack>
            </Paper>
          ) : null}

          {/* 材料对账 */}
          {plan.supplyReconciles.length > 0 ? (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                材料领用对账（{plan.supplyReconciles.length}）· 按批号合并领用记录
              </Typography>
              <Stack spacing={1}>
                {plan.supplyReconciles.map((r) => (
                  <Paper key={r.lotNo} variant="outlined" sx={{ p: 1.5 }}>
                    <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                      <Chip size="small" label={`批号 ${r.lotNo}`} color="info" variant="outlined" />
                      <Typography variant="subtitle2" fontWeight={700}>
                        {r.merged.name}
                      </Typography>
                      <Box sx={{ flex: 1 }} />
                      <Chip size="small" label={`合并后在库 ${r.merged.qty} ${r.merged.unit}`} />
                      <Chip size="small" variant="outlined" label={`领用记录 ${r.merged.issues.length} 条`} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      本机 {r.local.qty} {r.local.unit}（{r.local.issues.length} 条领用） · 导入 {r.imported.qty}{' '}
                      {r.imported.unit}（{r.imported.issues.length} 条领用） → 对账后在库 {r.merged.qty} {r.merged.unit}
                      ，领用 {r.merged.issues.length} 条（按批号去重）。
                    </Typography>
                  </Paper>
                ))}
              </Stack>
            </Paper>
          ) : null}

          {/* 缺项补齐 */}
          {orphanIssueCount + orphanPhotoCount > 0 ? (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                缺项待补齐（{orphanIssueCount + orphanPhotoCount}）· 补齐前不生效
              </Typography>
              <Stack spacing={2}>
                {plan.orphanIssues.map((o) => (
                  <OrphanIssueRow
                    key={o.issueId}
                    lotNo={o.lotNo}
                    issue={o.issue}
                    availableSpecimenNos={availableSpecimenNos}
                    resolution={resolutions.issues[o.issueId]}
                    onChange={(res) =>
                      setResolutions((prev) => ({
                        ...prev,
                        issues: { ...prev.issues, [o.issueId]: res },
                      }))
                    }
                  />
                ))}
                {plan.orphanPhotos.map((o) => (
                  <OrphanPhotoRow
                    key={o.photoId}
                    photo={o.photo}
                    availableProcKeys={availableProcKeys}
                    resolution={resolutions.photos[o.photoId]}
                    onChange={(res) =>
                      setResolutions((prev) => ({
                        ...prev,
                        photos: { ...prev.photos, [o.photoId]: res },
                      }))
                    }
                  />
                ))}
              </Stack>
            </Paper>
          ) : null}

          {/* 新增预览 */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              入库预览
            </Typography>
            <Typography variant="body2" color="text.secondary">
              将新增标本 {applySet?.specimens.length ?? 0} 件、工序 {applySet?.procedures.length ?? 0} 条、材料批次{' '}
              {applySet?.supplies.length ?? 0} 个、影像 {applySet?.photos.length ?? 0} 张。
              {unresolved ? ' 仍有冲突 / 缺项未处理，暂不能入库。' : ' 已全部确认，可入库。'}
            </Typography>
          </Paper>

          {/* 操作 */}
          <Stack direction="row" spacing={1} alignItems="center">
            {phase === 'applying' ? (
              <Button variant="contained" disabled startIcon={<RefreshIcon />}>
                正在入库…
              </Button>
            ) : (
              <Button
                variant="contained"
                startIcon={<MergeTypeIcon />}
                disabled={unresolved || !capacity?.ok || phase === 'done'}
                onClick={onApply}
              >
                确认入库
              </Button>
            )}
            {phase === 'error' ? (
              <Button variant="outlined" color="warning" startIcon={<RefreshIcon />} onClick={onRetry}>
                重试
              </Button>
            ) : null}
            <Button onClick={resetAll}>清空重选</Button>
            {phase === 'done' ? (
              <Alert severity="success" sx={{ flex: 1 }}>
                合并完成，档案已入库。可继续导出或导入下一台设备。
              </Alert>
            ) : null}
          </Stack>
        </>
      ) : null}

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

/* --------------------------- 缺项行 --------------------------- */

function OrphanIssueRow({
  lotNo,
  issue,
  availableSpecimenNos,
  resolution,
  onChange,
}: {
  lotNo: string;
  issue: import('../types/supply').SupplyIssue;
  availableSpecimenNos: string[];
  resolution: import('../utils/archive').IssueResolution | undefined;
  onChange: (res: import('../utils/archive').IssueResolution) => void;
}) {
  const [mode, setMode] = useState<'none' | 'map' | 'create'>('none');
  const [mapTo, setMapTo] = useState('');
  const [draft, setDraft] = useState<SpecimenDraft>({
    specimenNo: issue.specimenNo,
    taxon: '',
    horizon: '',
    locality: '',
    lithology: '',
    matrixHardness: 3,
    dimensions: '200×150×80',
    weight: 1500,
    storageBox: '',
    status: '待清修',
  });

  const resolved = !!resolution;

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderColor: resolved ? 'success.main' : 'error.main' }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Chip size="small" color="error" label="缺项" />
        <Typography variant="subtitle2" fontWeight={700}>
          批号 {lotNo} · 领用 {issue.qty} 件
        </Typography>
        <Typography variant="body2" color="text.secondary">
          领用人 {issue.operator} · 原登记标本「{issue.specimenNo}」在合并后档案中不存在
        </Typography>
        <Box sx={{ flex: 1 }} />
        {resolved ? (
          <Chip
            size="small"
            color="success"
            label={
              resolution?.type === 'discard'
                ? '已放弃'
                : resolution?.type === 'map'
                  ? `已映射到 ${resolution.specimenNo}`
                  : `已新建 ${resolution?.type === 'create' ? resolution.draft.specimenNo : ''}`
            }
          />
        ) : null}
      </Stack>

      {!resolved ? (
        <Stack spacing={1} sx={{ mt: 1 }}>
          <RadioGroup row value={mode} onChange={(e) => setMode(e.target.value as 'map' | 'create')}>
            <FormControlLabel value="map" control={<Radio />} label="映射到现有标本" />
            <FormControlLabel value="create" control={<Radio />} label="新建标本补齐" />
          </RadioGroup>

          {mode === 'map' ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                select
                size="small"
                label="选择标本"
                value={mapTo}
                onChange={(e) => setMapTo(e.target.value)}
                sx={{ minWidth: 240 }}
              >
                {availableSpecimenNos.map((no) => (
                  <MenuItem key={no} value={no}>
                    {no}
                  </MenuItem>
                ))}
              </TextField>
              <Button
                size="small"
                variant="contained"
                disabled={!mapTo}
                onClick={() => onChange({ type: 'map', specimenNo: mapTo })}
              >
                确认映射
              </Button>
            </Stack>
          ) : null}

          {mode === 'create' ? (
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <TextField
                  size="small"
                  label="标本号"
                  value={draft.specimenNo}
                  onChange={(e) => setDraft({ ...draft, specimenNo: e.target.value })}
                  sx={{ minWidth: 180 }}
                />
                <TextField
                  size="small"
                  label="分类鉴定"
                  value={draft.taxon}
                  onChange={(e) => setDraft({ ...draft, taxon: e.target.value })}
                  sx={{ minWidth: 200 }}
                />
                <TextField
                  size="small"
                  label="产地"
                  value={draft.locality}
                  onChange={(e) => setDraft({ ...draft, locality: e.target.value })}
                  sx={{ minWidth: 140 }}
                />
                <TextField
                  size="small"
                  label="层位"
                  value={draft.horizon}
                  onChange={(e) => setDraft({ ...draft, horizon: e.target.value })}
                  sx={{ minWidth: 140 }}
                />
              </Stack>
              <Box>
                <Button
                  size="small"
                  variant="contained"
                  disabled={!draft.specimenNo.trim()}
                  onClick={() => onChange({ type: 'create', draft })}
                >
                  新建并补齐
                </Button>
              </Box>
            </Stack>
          ) : null}

          <Divider />
          <Box>
            <Button size="small" color="inherit" onClick={() => onChange({ type: 'discard' })}>
              放弃该条领用（不入库）
            </Button>
          </Box>
        </Stack>
      ) : null}
    </Paper>
  );
}

function OrphanPhotoRow({
  photo,
  availableProcKeys,
  resolution,
  onChange,
}: {
  photo: import('../types/photo').PrepPhoto;
  availableProcKeys: string[];
  resolution: import('../utils/archive').PhotoResolution | undefined;
  onChange: (res: import('../utils/archive').PhotoResolution) => void;
}) {
  const [mapTo, setMapTo] = useState('');
  const resolved = !!resolution;

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderColor: resolved ? 'success.main' : 'error.main' }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Chip size="small" color="error" label="缺项" />
        <Typography variant="subtitle2" fontWeight={700}>
          影像「{photo.caption}」
        </Typography>
        <Typography variant="body2" color="text.secondary">
          阶段 {photo.stage} · 引用的工序在合并后档案中不存在
        </Typography>
        <Box sx={{ flex: 1 }} />
        {resolved ? (
          <Chip
            size="small"
            color="success"
            label={resolution?.type === 'discard' ? '已放弃' : `已映射到 ${resolution?.type === 'map' ? resolution.procKey : ''}`}
          />
        ) : null}
      </Stack>

      {!resolved ? (
        <Stack spacing={1} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <TextField
              select
              size="small"
              label="映射到现有工序"
              value={mapTo}
              onChange={(e) => setMapTo(e.target.value)}
              sx={{ minWidth: 260 }}
            >
              {availableProcKeys.map((k) => (
                <MenuItem key={k} value={k}>
                  {k}
                </MenuItem>
              ))}
            </TextField>
            <Button
              size="small"
              variant="contained"
              disabled={!mapTo}
              onClick={() => onChange({ type: 'map', procKey: mapTo })}
            >
              确认映射
            </Button>
          </Stack>
          <Divider />
          <Box>
            <Button size="small" color="inherit" onClick={() => onChange({ type: 'discard' })}>
              放弃该影像（不入库）
            </Button>
          </Box>
        </Stack>
      ) : null}
    </Paper>
  );
}
