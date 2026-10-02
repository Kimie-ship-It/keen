import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { publicContact } from "../../../scripts/privacy-config.mjs";
import styles from "./privacy.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "隐私与来源处理 | 校招雷达" };

export default function PrivacyPage() {
  const email = publicContact();
  return <div className={styles.page}>
    <header className={styles.header}><Link href="/"><GraduationCap size={22} />校招雷达</Link><Link href="/">返回招聘大厅</Link></header>
    <main className={styles.main}>
      <h1>隐私与来源处理</h1><p className={styles.date}>更新日期：2026年10月1日</p>
      <section><h2>服务范围</h2><p>校招雷达目前是本地试运行的高校招聘信息汇总工具，已接入四所高校。展示公开公告的公司、标题、日期、招聘人数、地点和官方链接，不接收简历，不代投，不收取投递费用。未审核的信息标为“待人工核验”；行业标签由关键词推断，截止日期和工作地点可能不完整，请以官方公告为准。</p></section>
      <section><h2>浏览与收藏数据</h2><p>当前没有学生账号系统。收藏的公告编号保存在当前浏览器的本地存储中，关闭页面后仍可能保留。浏览器数据不会自动在设备之间同步。清除收藏会删除该网站在本浏览器保存的收藏编号，不会删除已经下载的文件。</p><p>搜索、筛选和打开招聘详情时，网站服务器会收到相应参数。导出收藏时，收藏编号会发送给服务器，以查询当前可公开的数据并生成 CSV。请不要在搜索框输入身份证号、手机号或其他敏感个人信息。</p></section>
      <section><h2>日志与第三方服务</h2><p>本服务由个人运营，面向中国大陆高校毕业生。应用故障记录只保存故障编号、时间、操作类别等排查信息，不主动记录搜索内容、简历或管理口令；本机最多保留14个故障日志文件。服务器、数据库和未来托管平台也可能产生连接和访问日志，不能据此承诺“完全不收集任何访问数据”。当前暂不公开联系方式。</p><p>招聘数据目前存储在 Supabase 数据库中，并生成本机加密业务备份，默认保留14份有效快照。当前服务涉及境外平台，正式公开服务前仍需核实实际服务地区、数据处理和适用要求。本说明不代表已完成合规审核。</p><p>点击官方公告后会离开本网站，投递信息由公告指向的高校或招聘单位接收，其规则和隐私说明由对方提供。</p></section>
      <section><h2>更正与来源下架</h2><p>来源高校、招聘单位或相关权利人可提出更正、单条隐藏或整所高校来源下架请求。请提供本网站公告链接、官方公告链接、涉及范围及问题说明；请勿发送简历、身份证照片或其他不必要的敏感材料。</p>{email ? <p>联系邮箱：<a href={`mailto:${encodeURIComponent(email)}`}>{email}</a></p> : <p className={styles.notice}>试运行阶段尚未配置对外联系邮箱，暂不通过本站收集投诉材料。正式公开前将补齐可用联系渠道。</p>}<p>管理员可以隐藏单条招聘，或下架整个高校来源。来源下架后，新请求的列表、详情、收藏导出及筛选选项不再提供该来源，后续采集在开始前检查并跳过。已经开始的采集、已打开的页面、浏览器缓存和已下载的 CSV 无法立即撤回；刷新页面或重新导出后以当前状态为准。</p><p>下架不等于彻底删除。历史数据库、审计记录及已有备份可能仍保留数据。删除请求需要另行评估并处理主库、采集副本和备份；目前没有自动全副本删除功能。恢复来源不会恢复单独隐藏的招聘。</p></section>
    </main>
    <footer className={styles.footer}>校招雷达 · 公开公告汇总，请以官方信息为准。</footer>
  </div>;
}
