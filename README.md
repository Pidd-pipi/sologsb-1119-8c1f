# sologsb-1119 化石修复工序档案（gbfossilprep）

面向博物馆化石修复技师的工序留痕工作台：标本从入库、清修、加固到交付逐节点留痕，登记工具与胶种用量，并做修复前后对照。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21819**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | MUI（Material UI）v5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），影像单独建表，含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1119/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── router/index.tsx
        ├── types/{specimen,procedure,supply,photo,merge}.ts
        ├── stores/{specimen,procedure,supply}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,MergePage,CompareView}.tsx
        └── utils/{db,unitConvert,id,merge,mergeApply}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕 | Specimen、PrepProcedure、PrepPhoto |
| `/procedures/new` | 新建工序节点：按类型动态出工具/磨料/胶种字段，序号跳号报错 | PrepProcedure、Specimen |
| `/supplies` | 工具材料台账：按种类分组、批号追溯、低量高亮、领用登记 | SupplyLot |
| `/merge` | 断网双机档案合并：导出/导入档案、逐项对账确认后原子入库 | 四张表 |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v2**（`localStorage['gbfossilprep:db-version']` 记录）。
- 四张表：`specimens`（标本）、`procedures`（修复工序）、`supplies`（工具材料批次 + 领用记录）、`photos`（修复影像 dataUrl 独立表）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 2 件示范标本、2 个工序节点、4 个材料批次与 2 张留痕影像，便于直接查看。

## 功能要点

- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **工序回退**：已完成节点可回退，回退后计入待办与回退计数。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展示该批次的领用明细。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。

## 断网双机档案合并（`/merge`）

发掘站断网时两台设备各自录工序，回馆后在「双机合并」页互导档案对账，**绝不整包覆盖晚到一边**：

1. 每台设备先「导出本机档案」（整包 JSON：标本 / 工序 / 材料批次 / 影像，含设备名与导出时间）。
2. 在主机上「选择对端档案文件」导入，系统先做**容量预检**（`navigator.storage.estimate`，预估含 20% 余量）；空间不足直接拒绝合并、原档完整保留。
3. 逐项对账并并列出来，确认后才入库：
   - **标本按标本号认同一件**；共有标本字段不一致时表格并列差异，逐字段随「保留本机 / 采用对端」整体取边，标本内键以本机为准。
   - **工序按「标本号 + 节点序号」配对**；同一节点两边都改过且内容不同即为冲突，并排比对类型/工具/胶种/温湿度/操作人/状态等，逐组「保留本机 / 采用对端」裁决，未全部裁决前入库按钮禁用。
   - **材料领用按批号对账**：同批号以本机批次与库存为主，只追加对端新领用并扣减在库；同「批号+时间+数量+领用人+标本」指纹视为重复跳过（重试幂等）；对端独有批号整批并入；领用引用的批号两边批次表都没有时列为**缺项**，该笔领用挂起不生效，补齐批次后重新导入即生效。
   - **影像按「标本号 + 节点序号」重挂**：对端外键（随机 id）经标本号翻译到本机，新增影像换发本机 id；两边都找不到归属的影像列入游离，逐张选择「挂到某标本」或「丢弃」，未处理完不能入库。
4. 确认后在**单个 Dexie 事务**内原子提交，任一步失败整体回滚、不留半截数据，可换文件或原文件重试；老结构档案（无文件头 / v1 字段）经规范化升级后照常参与合并。
5. 页面提供「载入示例档案」，可在只有一台机器时直接体验「字段差异 + 工序冲突 + 批号缺项 + 游离影像」的完整对账流程。

合并引擎为纯函数（`src/utils/merge.ts`），不触碰数据库；落库逻辑在 `src/utils/mergeApply.ts`。逻辑冒烟测试：

```bash
cd frontend
npm run test:merge   # 标本认同 / 工序冲突 / 批号对账 / 影像重挂 / 老档兼容 等 6 项
```
