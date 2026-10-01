# 第二个独立数据库恢复验收

日期：2026-10-01（北京时间）。用户确认实际恢复，并自行建立 Supabase 免费项目 `hhhuhb`（项目引用 `tqkhfgpielhshfwcmftf`）。现有网站源项目为 `hogystsoivfmexdixdmi`，两者不同；未切换正式网站。

## 目标与备份

- 目标连接使用新项目的 Session Pooler，经本机隐藏输入窗口保存到未提交的 `.env.local` 中 `SUPABASE_RESTORE_DB_URL`；原 `SUPABASE_DB_URL` 保留。连接成功且 `assertSeparateRestoreTarget` 确认项目不同；TLS 验证开启。不在文档、代码、命令参数或聊天中记录密码。
- 使用从百度网盘下载到独立目录的 `20261001T101036628Z-60c0a06d.cjbackup`；824622 字节，SHA-256 为 `18DFD57EEC46835B0C8219761A08D0527ED8F4E88E155EC48FEE20034BD8E34E`。解密格式为八表 v2，创建时间 2026-10-01T10:10:36.628Z。
- 先确认目标无应用表，再在同一事务执行两份既有迁移。八张应用表存在、为空、RLS 全部开启；没有将旧七表 v1 快照用于公开恢复。

## 实际恢复与比对

对独立目标执行 `restore:supabase -- --confirm-empty-target`，程序拒绝同项目或非空目标，并在事务内锁表、写入、逐表核对内容及自增编号。实际结果：

| 表 | 快照与恢复行数 |
| --- | ---: |
| jobs | 4919 |
| job_locations | 13761 |
| job_industries | 9786 |
| source_runs | 38 |
| source_status | 4 |
| review_events | 0 |
| admin_auth_limits | 0 |
| source_controls | 0 |

程序报告 `contents=identical`、`identitySequences=verified`、`sourceRestrictions=included`、`liveSourceOverwritten=false`。恢复后单独查询源库与新库：两者均为 4919 条招聘、38 条来源运行、0 条来源限制。空表的审核、限速及下架历史已随快照结构恢复；此次备份中没有实际审核或下架记录，因此不能声称用真实非空历史做过跨项目验收。

## 独立网站检查

使用新库连接在本机临时端口 3003 启动测试站，运行现有 `test:runtime-http`：招聘列表、组合筛选、详情、收藏 CSV、管理页、未授权拒绝、授权审核列表、无效审核写入拒绝和 500 条收藏批量读取均通过；返回四校、4919 条原始招聘、4134 条合并招聘、4919 条待核验。测试后再次核对，源库与新库的招聘、来源运行、来源限制数量一致，限速表均为零条。测试站已经关闭，正式网站没有切换。

64 项本地测试、lint、生产构建均通过。此验收仅针对八张业务表及本地独立测试站，不代表 Supabase 平台账号/Auth/Storage/角色等完整恢复，也不是公网切换演练。下一步按清单执行 B02 每日自动异地上传；原库与新库均应保留，未经单独确认不切换正式网站。
