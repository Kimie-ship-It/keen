import { notFound } from "next/navigation";
import Link from "next/link";
import { ExternalLink, GraduationCap } from "lucide-react";
import { openRuntimeDatabase, closeRuntimeDatabase } from "../../../../../scripts/runtime-db.mjs";
import { getJobDetail } from "../../../../../scripts/jobs-service.mjs";
import styles from "./detail.module.css";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ source: string; sourceId: string }> };
type SourceLink = { source: string; sourceId: string; publishedAt: string; detailUrl: string };

function officialLink(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function decodeRouteValue(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export default async function JobDetailPage({ params }: PageProps) {
  const route = await params;
  const db = await openRuntimeDatabase();
  try {
    const job = (await getJobDetail(db, { source: decodeRouteValue(route.source), sourceId: decodeRouteValue(route.sourceId) }));
    if (!job) notFound();
    const links: SourceLink[] = job.sourceLinks.filter((link: SourceLink) => officialLink(link.detailUrl));
    return <div className={styles.pageShell}>
      <header className={styles.topbar}><Link className={styles.brand} href="/"><span className={styles.brandMark}><GraduationCap size={18} /></span><span><strong>校招雷达</strong><small>高校招聘信息中转站</small></span></Link><Link className={styles.backLink} href="/">返回招聘大厅</Link></header>
      <main className={styles.main}>
        <div className={styles.breadcrumb}><Link href="/">招聘大厅</Link><span>/</span><span>招聘详情</span></div>
        <article className={styles.detailCard}>
          <div className={styles.detailTop}><div className={styles.logo}>{job.company.slice(0, 1) || "招"}</div><div><span className={styles.kicker}>{job.sourceCount > 1 ? `${job.sourceCount} 所高校共同发布` : job.source}</span><h1>{job.title}</h1><p className={styles.company}>{job.company}</p></div></div>
          <div className={styles.metaGrid}>
            <div><span>来源高校</span><strong>{job.source}</strong></div>
            <div><span>发布时间</span><strong>{job.publishedAt || "未注明"}</strong></div>
            <div><span>截止日期</span><strong>{job.deadline?.slice(0, 10) || "未注明"}</strong></div>
            <div><span>招聘人数</span><strong>{job.recruitingNumbers || "见官方公告"}</strong></div>
            <div><span>工作地点</span><strong>{job.locations.length ? job.locations.join("、") : "未注明"}</strong></div>
            <div><span>行业标签</span><strong>{job.industries?.length ? job.industries.join("、") : "未分类"}</strong></div>
          </div>
          <section className={styles.notice}><strong>{job.reviewStatus === "approved" ? "已人工核验" : "待人工核验"}</strong><p>岗位要求、完整职位描述和投递方式请以高校官方公告为准。本页面只汇总公开信息，不代替高校或企业接收简历。</p></section>
          <section className={styles.sources}><div><span className={styles.kicker}>OFFICIAL SOURCES</span><h2>官方公告入口</h2></div>{links.map((link: SourceLink) => <a className={styles.primaryButton} key={`${link.source}:${link.sourceId}`} href={officialLink(link.detailUrl)} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />查看{link.source}公告</a>)}</section>
        </article>
      </main>
      <footer className={styles.footer}><span>校招雷达</span><span>数据来源于公开高校就业信息，请以官方公告为准。</span><Link href="/privacy">隐私与来源处理</Link></footer>
    </div>;
  } finally {
    closeRuntimeDatabase(db);
  }
}
