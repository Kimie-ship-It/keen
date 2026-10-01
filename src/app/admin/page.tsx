"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, EyeOff, RefreshCw } from "lucide-react";
import styles from "../page.module.css";

type Job = { source: string; sourceId: string; company: string; title: string; reviewStatus: string };
type ReviewEvent = { source: string; sourceId: string; oldStatus: string; newStatus: string; actor: string; createdAt: string };
type SourceControl = { id: string; source: string; restricted: boolean; reason: string; changedAt: string | null };
type SourceEvent = { id: number; source: string; action: string; reason: string; created_at: string };
const reasonLabels: Record<string, string> = { source_request: "来源方要求", privacy: "隐私问题", copyright: "内容权利问题", inaccurate: "信息有误", resolved: "问题已处理" };
const statusLabel: Record<string, string> = { pending: "待核验", approved: "核验通过", hidden: "隐藏" };

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [counts, setCounts] = useState<Array<{ status: string; count: number }>>([]);
  const [recentReviews, setRecentReviews] = useState<ReviewEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<SourceControl[]>([]);
  const [sourceEvents, setSourceEvents] = useState<SourceEvent[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function request(method: string, body?: object, query = "", endpoint = "reviews") {
    const response = await fetch(`/api/admin/${endpoint}${query}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "操作失败");
    return data;
  }
  async function load(offset = 0, append = false) {
    setBusy(true);
    try {
      const data = await request("GET", undefined, `?limit=100&offset=${offset}`);
      setJobs((current) => append ? [...current, ...data.jobs] : data.jobs);
      setCounts(data.counts);
      setRecentReviews(data.recentReviews);
      setHasMore(data.hasMore);
      const controls = await request("GET", undefined, "", "sources");
      setSources(controls.sources);
      setSourceEvents(controls.recent);
      setError("");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
    finally { setBusy(false); }
  }
  async function review(job: Job, status: string) {
    setBusy(true);
    try { await request("POST", { source: job.source, sourceId: job.sourceId, status }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "审核失败"); }
    finally { setBusy(false); }
  }
  async function changeSource(source: SourceControl) {
    const action = source.restricted ? "restore" : "restrict";
    const message = source.restricted ? `恢复${source.source}的公开展示和后续采集？单条隐藏记录不会恢复。` : `下架${source.source}的全部招聘并暂停后续采集？已打开的页面和已导出文件无法撤回。`;
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      const controls = await request("POST", { id: source.id, action, reason: source.restricted ? "resolved" : reasons[source.id] || "source_request" }, "", "sources");
      setSources(controls.sources);
      setSourceEvents(controls.recent);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "来源操作失败"); }
    finally { setBusy(false); }
  }

  return <div className={styles.appShell}><header className={styles.topbar}><div className={styles.topbarInner}><Link href="/">校招雷达 · 返回招聘大厅</Link></div></header><main className={styles.main}>
    <section className={styles.pageIntro}><div><span className={styles.sectionKicker}>OPERATIONS</span><h1>运营审核</h1><p>口令仅用于本次页面操作，不保存在浏览器。未核验记录仍可在招聘大厅看到，并标记为待核验。</p></div></section>
    <section className={styles.searchPanel}><div className={styles.searchInput}><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="输入管理口令" aria-label="管理口令" autoComplete="off" /></div><button className={styles.primaryButton} disabled={busy} onClick={() => void load()}><RefreshCw size={16} /> 读取待审核</button></section>
    {error && <p role="alert" className={styles.empty}>{error}</p>}
    {sources.length > 0 && <section className={styles.sourceControls}>
      <h2>高校来源</h2>
      <div className={styles.sourceControlList}>{sources.map((source) => <div className={styles.sourceControlRow} key={source.id}>
        <strong>{source.source}</strong>
        <span className={source.restricted ? styles.statusWarn : styles.statusGood}>{source.restricted ? "已下架 · 采集暂停" : "公开展示"}</span>
        <select aria-label={`${source.source}下架原因`} disabled={busy || source.restricted} value={source.restricted ? source.reason : reasons[source.id] || "source_request"} onChange={(event) => setReasons((current) => ({ ...current, [source.id]: event.target.value }))}>
          {Object.entries(reasonLabels).filter(([key]) => key !== "resolved").map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <label className={styles.sourceToggle}><input type="checkbox" checked={!source.restricted} disabled={busy} onChange={() => void changeSource(source)} aria-label={`${source.source}公开展示`} />公开展示</label>
      </div>)}</div>
      <div className={styles.sectionHead}><h2>最近来源操作</h2></div>
      <div className={styles.sourceHistory}>{sourceEvents.length ? sourceEvents.map((event) => <p key={event.id}>{new Date(event.created_at).toLocaleString("zh-CN")} · {event.source} · {event.action === "restrict" ? "下架" : "恢复"} · {reasonLabels[event.reason]}</p>) : <p>暂无来源操作</p>}</div>
    </section>}
    <div className={styles.sectionHead}><h2>待审核招聘</h2><span>{counts.map((item) => `${item.status}: ${item.count}`).join(" · ")}</span></div>
    <div className={styles.tableCard}><table><thead><tr><th>公司</th><th>招聘公告</th><th>来源</th><th>操作</th></tr></thead><tbody>{jobs.map((job) => <tr key={`${job.source}:${job.sourceId}`}><td>{job.company}</td><td>{job.title}</td><td>{job.source}</td><td><div className={styles.reviewActions}><button disabled={busy} className={styles.outlineButton} onClick={() => void review(job, "approved")}><Check size={15} /> 核验通过</button><button disabled={busy} className={styles.outlineButton} onClick={() => void review(job, "hidden")}><EyeOff size={15} /> 隐藏</button></div></td></tr>)}</tbody></table>{hasMore && <button className={styles.outlineButton} onClick={() => void load(jobs.length, true)} disabled={busy}><RefreshCw size={15} /> 加载更多</button>}</div>
    <div className={styles.sectionHead}><h2>最近审核记录</h2></div>
    <div className={styles.tableCard}><table><thead><tr><th>时间</th><th>来源</th><th>公告编号</th><th>状态变更</th><th>操作者</th></tr></thead><tbody>{recentReviews.map((event, index) => <tr key={`${event.createdAt}:${event.source}:${event.sourceId}:${index}`}><td>{new Date(event.createdAt).toLocaleString("zh-CN")}</td><td>{event.source}</td><td>{event.sourceId}</td><td>{statusLabel[event.oldStatus] || event.oldStatus} → {statusLabel[event.newStatus] || event.newStatus}</td><td>管理员</td></tr>)}</tbody></table></div>
  </main></div>;
}
