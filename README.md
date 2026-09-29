# 校招雷达

一个本地运行的高校招聘信息中转站原型。当前只接入北京航空航天大学就业网，将公开招聘信息采集到 SQLite，再由网站提供搜索、分页、收藏、来源状态和人工审核。

## 当前边界

- 已实现：北航招聘采集、增量去重、失败保留旧数据、每日本机定时任务、公开查询页、浏览器本地收藏、口令保护的审核接口。
- 数据规模：以本机数据库实时结果为准，不在文档中写死条数。
- 尚未实现：其他高校采集器、用户账号、简历投递、线上部署、真实飞书机器人送达验证。
- 网站中的“查看官方公告”只是跳转到高校原始页面，不代表已经打通投递。
- 未经人工审核的记录仍公开展示，并明确标为“待人工核验”；运营人员可以核验通过或隐藏。

## 本地启动

需要 Node.js 20 或更高版本。

```powershell
npm install
npm run setup:local
npm run dev
```

浏览器打开 `http://localhost:3000`。审核页位于 `http://localhost:3000/admin`，管理口令保存在本机 `.env.local`，不要提交或发送给他人。

## 采集数据

手动采集一次北航公开招聘信息：

```powershell
npm run collect:buaa
```

运行全部每日采集流程（包含可选通知）：

```powershell
npm run collect:daily
```

采集器会请求高校公开接口，按来源和招聘 ID 增量写入 `data/campus-jobs.db`。接口异常、空列表或中途失败时不会清空已有招聘记录。`data/buaa-recruitments.json` 是便于排查的本地快照，不是网站的数据源。

## 每日自动更新

在 Windows 上安装或更新每天 08:00 运行的计划任务：

```powershell
npm run schedule:install
```

任务名为 `CampusJobsRadar-Daily`，日志写入 `data/logs/collect-YYYY-MM-DD.log`。计划任务只在这台电脑可用；关机错过时间后，Windows 会在条件允许时补跑。当前任务使用 Windows 交互式登录会话，用户退出系统或账户无法交互时可能不会执行；这适合本机原型，不等同于服务器后台服务。

## 审核方式

1. 运行 `npm run setup:local` 生成管理口令。
2. 打开 `/admin`，输入 `.env.local` 中的 `ADMIN_TOKEN`。
3. 选择“核验通过”或“隐藏”。

管理页本身可以访问，但读取待审核数据和修改状态都必须通过管理口令。口令只保存在当前页面内存中，不写入浏览器存储。

## 配置

复制 `.env.example` 的字段含义即可，不要把真实值提交到版本库：

- `ADMIN_TOKEN`：至少 24 个字符的管理口令，推荐由 `npm run setup:local` 生成。
- `FEISHU_WEBHOOK_URL`：可选，飞书自定义机器人 webhook。
- `FEISHU_SIGN_SECRET`：可选，机器人签名密钥。
- `COLLECT_TIMEOUT_MS`：单次请求超时，默认 15000 毫秒。
- `COLLECT_RETRIES`：请求重试次数，默认 3 次。
- `COLLECT_INTERVAL_MS`：常驻采集模式的间隔，默认 1 小时。

未配置飞书 webhook 时采集照常运行，只是不发送日报和故障提醒。

## 验证

```powershell
npm test
npm run lint
npm run build
```

## 清单、备份和日志

- `docs/PROJECT-CHECKLIST.md`：项目总清单。每次开始任务先查看，完成并验证后再勾选。
- `docs/CHANGELOG.md`：重要变更日志，记录做了什么、为什么做以及验证结果。
- `npm run backup:step -- "步骤名称"`：创建一次步骤备份。它会提交当前代码到本地 Git，并把数据库和采集快照备份到项目外的 `campus-jobs-backups` 文件夹。
- `npm run backup:data`：手动创建运行数据备份。每日采集成功后也会自动执行，默认保留最近 14 份，可通过 `BACKUP_RETENTION_COUNT` 调整。
- `npm run backup:verify`：把最新备份恢复到临时目录并检查完整性和记录数量，不覆盖正在使用的数据库。
- `data/logs/`：采集运行日志，记录任务实际运行过程，不等同于代码备份。

备份分为两部分：Git 用于回退代码，数据库备份用于恢复运行数据。修改完成并通过测试后，应立即执行一次 `backup:step`。

## 主要目录

- `src/app/`：Next.js 页面与 API。
- `scripts/`：数据库、采集、通知和计划任务脚本。
- `tests/`：采集、查询、审核和通知测试。
- `data/`：本地数据库、快照和日志，均不应提交。

## 下一阶段

先抽象统一高校采集器协议，再小批量接入高校并记录每个来源的接口、频率限制和合规边界。上线前还需要部署数据库、定时任务、访问日志、备份恢复、隐私说明和高校来源下架机制。
