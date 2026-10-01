# 网站托管与 HTTPS

## 当前进度

首选 Vercel，代码来源为 GitHub 的 `Kimie-ship-It/keen`，网站数据库为 Supabase。Vercel 注册目前要求进一步验证，用户已提交验证申请；尚未建立托管项目、上传生产密钥或取得公网网址。账号审核通过之前，可完成本地配置与测试，不能把部署准备当作发布成功。

## 已准备的代码

- `vercel.json` 指定 Next.js 和 `npm run build:hosting`。
- 托管构建先检查 Supabase 模式、数据库配置、管理口令长度、TLS 校验和不允许公开的环境变量，再构建网站。检查失败时停止构建；不输出连接字符串。
- Vercel 运行时拒绝 SQLite，也拒绝 `SUPABASE_SSL_INSECURE=1`。
- Supabase 官方 CA 已作为公开证书模块随代码打包，仅用于 Supabase 主机；其他数据库保持系统默认信任链，显式 `SUPABASE_SSL_CA` 可以覆盖。证书来源及指纹见 `scripts/supabase-ca.mjs` 和测试；官方换证时应重新获取并验证，不能用关闭校验的方式解决。
- `.vercelignore` 排除本地环境文件、数据库、快照和日志，避免通过 CLI 上传运行数据。

## 账号通过后的步骤

1. 创建 Vercel 项目并导入 `Kimie-ship-It/keen`，根目录为仓库根目录，框架为 Next.js。GitHub 登录、应用授权和账号验证由用户本人完成，不安装未确认的付费服务。
2. 在 Production 的服务端环境变量中配置以下字段，真实值只从本机安全配置转入平台密钥存储，不发聊天、不提交 Git、不写文档。

| 字段 | 配置 |
| --- | --- |
| `CAMPUS_JOBS_STORAGE` | `supabase` |
| `SUPABASE_DB_URL` | 已验证的 Transaction Pooler 连接字符串 |
| `ADMIN_TOKEN` | 本机已生成的长随机管理口令 |
| `SUPABASE_SSL_INSECURE` | `0` |
| `SUPABASE_SSL_CA` | 默认留空，使用打包的官方公开 CA；有换证需求才配置 |
| `PRIVACY_CONTACT_EMAIL` | 确认有效的公开联系邮箱，非密钥；目前尚未配置 |

不要给以上密钥添加 `NEXT_PUBLIC_` 前缀，不把生产数据库和口令开放给不可信分支/拉取请求预览。预览使用独立测试数据库或暂不配置密钥，构建失败也不应绕过检查。飞书密钥和采集器参数不需要上传给只负责网站访问的托管项目。

3. 发起部署并确认构建与运行成功，取得平台实际返回的 HTTPS 地址，不猜测项目域名。
4. 用未登录浏览器验证学生能直接访问生产地址；检查证书、HTTP 跳转 HTTPS、列表、组合筛选、详情、官方跳转、收藏导出、手机布局和后台未授权访问。验证期间不要修改真实招聘的审核状态。
5. 完成公网接口检查后，才勾选清单中的 HTTPS 和真实线上访问验证，创建步骤备份并核对 GitHub 推送。

## 上线边界

- 当前每日采集仍由本机 Windows 任务运行，依赖开机和登录；网站托管不会自动把采集任务搬到云端。
- SQLite 备份不自动包含 Supabase 云端管理变化；八表 v2 加密快照覆盖审核与来源下架，但文件和密钥仍在本机。异地副本、独立项目恢复验收仍待完成，见 `docs/CLOUD-BACKUP-RECOVERY.md`。网站托管项目不需要上传备份密钥或恢复目标地址。
- 隐私说明和来源下架机制已实现，但正式公开前必须配置真实联系邮箱、确认运营主体和实际服务地区/适用要求，并核验投诉与删除请求人工处理流程；不要把下架当作彻底删除或合规审核结论。见 `docs/PRIVACY-SOURCE-CONTROLS.md`。
- 基础错误记录和本机每日健康检查已实现，见 `docs/ERROR-MONITORING.md`。Vercel 环境只输出脱敏控制台日志，不保存本机文件；上线后还需验收平台日志留存、独立 HTTPS 探活和实际远程告警，不能把本机检查当作云端监控已完成。不要给网站上传备份密钥以运行本机备份检查。
- 网站服务面向中国高校学生，发布后还需实际测试中国大陆网络访问；不能只凭本机可访问就承诺所有地区可用。
- 如果 Vercel 验证未通过或访问效果不满足要求，另行确认托管方案。不要为赶进度绕过账号验证，也不要未经用户确认创建付费资源。

## 本地验证命令

```powershell
npm run check:hosting
npm run check:supabase
npm test
npm run test:supabase
npm run lint
npm run build:hosting
```

这些检查证明本地上线准备和数据库连接状态，不证明公网已经部署。网站启动后再运行 `npm run test:runtime-http` 验证实际接口；真实公网地址取得后还要重新执行公网检查。
