"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, Clock3, ExternalLink, GraduationCap, LayoutDashboard, RefreshCw, Search, X } from "lucide-react";
import styles from "./page.module.css";

type SourceLink = { source: string; sourceId: string; publishedAt: string; detailUrl: string };
type Job = { source: string; sourceId: string; company: string; title: string; jobType: string; publishedAt: string; deadline: string; recruitingNumbers: string; detailUrl: string; firstSeenAt: string; reviewStatus: string; sourceCount: number; duplicateCount: number; sourceLinks: SourceLink[] };
type Stats = { total: number; uniqueTotal: number; sources: number; todayNew: number; dueSoon: number };
type Source = { source: string; total: number; lastStatus: string | null; lastFinishedAt: string | null; lastSuccessfulAt: string | null; lastFailureAt: string | null; isStale: boolean };
type Run = { source: string; status: string; finishedAt: string; fetchedCount: number; newCount: number };
type Freshness = { lastSuccessfulAt: string | null; isStale: boolean; staleAfterHours: number; staleSources: number; failedSources: number };
type Data = { jobs: Job[]; matchCount: number; stats: Stats; sources: Source[]; runs: Run[]; freshness: Freshness };
const initial: Data = { jobs: [], matchCount: 0, stats: { total: 0, uniqueTotal: 0, sources: 0, todayNew: 0, dueSoon: 0 }, sources: [], runs: [], freshness: { lastSuccessfulAt: null, isStale: true, staleAfterHours: 36, staleSources: 0, failedSources: 0 } };

function sourceStatus(source: Source) {
  if (source.lastStatus === "failed") return "最近采集失败";
  if (source.lastStatus === "running") return "采集中";
  if (source.isStale) return "更新超时";
  return source.lastStatus === "success" ? "更新正常" : "尚未成功采集";
}

function officialLink(url: string) {
  try { const parsed = new URL(url); return parsed.protocol === "https:" ? parsed.href : ""; } catch { return ""; }
}

export default function Home() {
  const [view, setView] = useState<"jobs" | "schools" | "status">("jobs");
  const [data, setData] = useState<Data>(initial);
  const [query, setQuery] = useState("");
  const [selectedSource, setSelectedSource] = useState("");
  const [selected, setSelected] = useState<Job | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async (search: string, source: string, offset = 0) => {
    const id = requestId.current + 1;
    requestId.current = id;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    try {
      const response = await fetch(`/api/jobs?limit=100&offset=${offset}&q=${encodeURIComponent(search)}&source=${encodeURIComponent(source)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("读取招聘数据失败");
      const result: Data = await response.json();
      if (id !== requestId.current) return;
      setData((previous) => ({ ...result, jobs: offset ? [...previous.jobs, ...result.jobs] : result.jobs }));
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : "读取失败");
    } finally {
      if (id === requestId.current) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => {
    queueMicrotask(() => {
      try { const stored = JSON.parse(localStorage.getItem("campus-jobs:saved") || "[]"); if (Array.isArray(stored)) setSaved(stored); } catch { /* Ignore invalid local data. */ }
      setReady(true);
    });
  }, []);
  useEffect(() => { const timer = setTimeout(() => { void refresh(query, selectedSource, 0); }, 250); return () => clearTimeout(timer); }, [query, selectedSource, refresh]);
  useEffect(() => { if (ready) localStorage.setItem("campus-jobs:saved", JSON.stringify(saved)); }, [saved, ready]);
  const toggleSaved = (id: string) => setSaved((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  const filtered = data.jobs;
  const latest = data.runs[0];
  const freshnessMessage = data.freshness.failedSources
    ? `${data.freshness.failedSources} 所高校最近采集失败${data.freshness.staleSources ? `，${data.freshness.staleSources} 所高校超过 ${data.freshness.staleAfterHours} 小时未成功更新` : ""}；请核对官方公告`
    : data.freshness.staleSources ? `${data.freshness.staleSources} 所高校超过 ${data.freshness.staleAfterHours} 小时未成功更新，请核对官方公告` : "数据更新正常";

  return <div className={styles.appShell}>
    <header className={styles.topbar}><div className={styles.topbarInner}>
      <button className={styles.brand} onClick={() => setView("jobs")}><span className={styles.brandMark}><GraduationCap size={18} /></span><span><strong>校招雷达</strong><small>高校招聘信息中转站</small></span></button>
      <nav className={styles.nav} aria-label="主导航">
        <button className={view === "jobs" ? styles.navActive : ""} onClick={() => setView("jobs")}><Search size={16} /> 招聘大厅</button>
        <button className={view === "schools" ? styles.navActive : ""} onClick={() => setView("schools")}><GraduationCap size={16} /> 高校来源</button>
        <button className={view === "status" ? styles.navActive : ""} onClick={() => setView("status")}><LayoutDashboard size={16} /> 采集状态</button>
      </nav>
      <button className={styles.iconButton} onClick={() => void refresh(query, selectedSource, 0)} title="刷新数据" aria-label="刷新数据"><RefreshCw size={18} /></button>
    </div></header>
    <main className={styles.main}>
      {error && <p role="alert" className={styles.empty}>{error}，请稍后重试。</p>}
      {view === "jobs" && <>
        <section className={styles.hero}><div><div className={styles.eyebrow}>公开高校就业信息</div><h1>找到下一站，<em>从校招开始</em></h1><p>招聘详情与投递方式请以高校官方公告为准。</p></div><div className={styles.heroStats}><div><strong>{data.stats.sources}</strong><span>已接入高校</span></div><div><strong>{data.stats.todayNew || 0}</strong><span>今日发现</span></div><div><strong>{data.stats.dueSoon || 0}</strong><span>7天内截止</span></div></div></section>
        <section className={`${styles.freshnessNotice} ${data.freshness.isStale ? styles.freshnessWarn : ""}`} role={data.freshness.isStale ? "alert" : undefined}><Clock3 size={16} /><span>{data.freshness.lastSuccessfulAt ? `最近一所高校成功更新：${new Date(data.freshness.lastSuccessfulAt).toLocaleString("zh-CN")}` : "尚无成功采集记录"}</span><strong>{data.freshness.isStale && !data.sources.length ? "暂无可用的高校采集记录，请核对官方公告" : freshnessMessage}</strong></section>
        <section className={styles.searchPanel}>
          <div className={styles.searchInput}><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索公司或招聘标题" aria-label="搜索公司或招聘标题" /></div>
          <div className={styles.filters}>
            <select value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)} aria-label="按高校筛选">
              <option value="">全部高校</option>
              {data.sources.map((source) => <option key={source.source} value={source.source}>{source.source}</option>)}
            </select>
          </div>
        </section>
        <div className={styles.sectionHead}><div><span className={styles.sectionKicker}>LATEST POSTS</span><h2>最新招聘</h2></div><div className={styles.resultMeta}>显示 {filtered.length} / {data.matchCount} 条，合并前 {data.stats.total} 条原始记录</div></div>
        <section className={styles.jobList}>{filtered.map((job) => {
          const id = `${job.source}:${job.sourceId}`;
          return <article className={styles.jobCard} key={id}><div className={styles.jobLogo}>{job.company.slice(0, 1)}</div><div className={styles.jobBody}>
            <div className={styles.jobTitleRow}><div><h3><button className={styles.textButton} onClick={() => setSelected(job)}>{job.title}</button></h3><p className={styles.company}>{job.company}</p></div><button className={styles.saveButton} onClick={() => toggleSaved(id)} title={saved.includes(id) ? "取消收藏" : "收藏"} aria-label={saved.includes(id) ? "取消收藏" : "收藏"}><Bookmark size={18} fill={saved.includes(id) ? "currentColor" : "none"} /></button></div>
            <div className={styles.metaRow}><span><GraduationCap size={14} /> {job.source}</span><span><Clock3 size={14} /> 发布 {job.publishedAt || "未注明"}</span><span>{job.reviewStatus === "approved" ? "已人工核验" : "待人工核验"}</span></div>
            <div className={styles.cardBottom}><span className={styles.source}>招聘人数：{job.recruitingNumbers || "见公告"}</span><span>截止：{job.deadline?.slice(0, 10) || "见公告"}</span><button className={styles.textButton} onClick={() => setSelected(job)}>查看详情</button></div>
            {job.sourceCount > 1 && <span className={styles.duplicateNote}>已合并 {job.sourceCount} 所高校的 {job.duplicateCount} 条记录</span>}
          </div></article>;
        })}{!loading && !filtered.length && <div className={styles.empty}>暂无匹配的招聘信息</div>}{filtered.length < data.matchCount && <button className={styles.outlineButton} onClick={() => void refresh(query, selectedSource, filtered.length)} disabled={loading}>加载更多</button>}</section>
      </>}
      {view === "schools" && <section className={styles.dashboardPage}><div className={styles.pageIntro}><div><span className={styles.sectionKicker}>SOURCES</span><h1>高校来源</h1><p>显示已采集或已尝试采集的高校，招聘信息请以官方公告为准。</p></div></div><div className={styles.sourceSummary}><div><strong>{data.stats.sources}</strong><span>已有招聘数据</span></div><div><strong>{data.stats.total}</strong><span>累计招聘</span></div></div><div className={styles.tableCard}><table><thead><tr><th>高校</th><th>招聘记录</th><th>最近成功</th><th>最近采集</th><th>状态</th></tr></thead><tbody>{data.sources.map((source) => <tr key={source.source}><td><strong>{source.source}</strong></td><td>{source.total}</td><td>{source.lastSuccessfulAt ? new Date(source.lastSuccessfulAt).toLocaleString("zh-CN") : "尚无"}</td><td>{source.lastFinishedAt ? new Date(source.lastFinishedAt).toLocaleString("zh-CN") : source.lastStatus === "running" ? "采集中" : "未知"}</td><td className={source.lastStatus === "failed" || source.isStale ? styles.statusWarn : styles.statusGood}>{sourceStatus(source)}</td></tr>)}</tbody></table></div></section>}
      {view === "status" && <section className={styles.dashboardPage}><div className={styles.pageIntro}><div><span className={styles.sectionKicker}>COLLECTION</span><h1>采集状态</h1><p>公开运行记录。采集任务由独立进程执行，本页面不提供管理权限。</p></div></div><div className={styles.sourceSummary}><div><strong>{data.stats.total}</strong><span>已存入数据库</span></div><div><strong>{latest?.newCount ?? 0}</strong><span>最近一次新增</span></div><div><strong>{data.freshness.failedSources + data.sources.filter((source) => source.isStale && source.lastStatus !== "failed").length}</strong><span>需关注高校</span></div></div><div className={styles.sectionHead}><h2>高校更新状态</h2></div><div className={styles.tableCard}><table><thead><tr><th>高校</th><th>最近成功</th><th>最近失败</th><th>状态</th></tr></thead><tbody>{data.sources.map((source) => <tr key={source.source}><td>{source.source}</td><td>{source.lastSuccessfulAt ? new Date(source.lastSuccessfulAt).toLocaleString("zh-CN") : "尚无"}</td><td>{source.lastFailureAt ? new Date(source.lastFailureAt).toLocaleString("zh-CN") : "无"}</td><td className={source.lastStatus === "failed" || source.isStale ? styles.statusWarn : styles.statusGood}>{sourceStatus(source)}</td></tr>)}</tbody></table></div><div className={styles.sectionHead}><h2>最近运行记录</h2></div><div className={styles.tableCard}><table><thead><tr><th>高校</th><th>完成时间</th><th>状态</th><th>采集数</th><th>新增数</th></tr></thead><tbody>{data.runs.map((run, index) => <tr key={index}><td>{run.source}</td><td>{run.finishedAt ? new Date(run.finishedAt).toLocaleString("zh-CN") : "运行中"}</td><td>{run.status === "success" ? "成功" : run.status === "failed" ? "失败" : "运行中"}</td><td>{run.fetchedCount}</td><td>{run.newCount}</td></tr>)}</tbody></table></div></section>}
    </main>
    <footer className={styles.footer}><span>校招雷达</span><span>数据来源于公开高校就业信息，请以官方公告为准。</span></footer>
    {selected && <div className={styles.modalBackdrop} onClick={() => setSelected(null)}><div className={styles.modal} role="dialog" aria-modal="true" aria-label={selected.title} onClick={(event) => event.stopPropagation()}><button className={styles.modalClose} onClick={() => setSelected(null)} aria-label="关闭"><X size={19} /></button><div className={styles.modalTop}><div className={styles.jobLogoLarge}>{selected.company.slice(0, 1)}</div><div><span className={styles.sectionKicker}>{selected.sourceCount > 1 ? `${selected.sourceCount} 所高校共同发布` : selected.source}</span><h2>{selected.title}</h2><p>{selected.company}</p></div></div><div className={styles.modalMeta}><div><span>发布时间</span><strong>{selected.publishedAt || "未注明"}</strong></div><div><span>截止日期</span><strong>{selected.deadline?.slice(0, 10) || "见公告"}</strong></div><div><span>招聘人数</span><strong>{selected.recruitingNumbers || "见公告"}</strong></div></div><p className={styles.modalSummary}>岗位、学历、工作地点与投递入口请到来源高校的官方公告核实。</p><div className={styles.modalActions}><button className={styles.outlineButton} onClick={() => toggleSaved(`${selected.source}:${selected.sourceId}`)}><Bookmark size={16} /> {saved.includes(`${selected.source}:${selected.sourceId}`) ? "已收藏" : "收藏"}</button>{selected.sourceLinks.map((link) => <a key={`${link.source}:${link.sourceId}`} className={styles.primaryButton} href={officialLink(link.detailUrl)} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /> {selected.sourceLinks.length > 1 ? `查看${link.source}公告` : "查看官方公告"}</a>)}</div></div></div>}
  </div>;
}
