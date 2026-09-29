"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, EyeOff, RefreshCw } from "lucide-react";
import styles from "../page.module.css";

type Job = { source: string; sourceId: string; company: string; title: string; reviewStatus: string };
type ReviewEvent = { source: string; sourceId: string; oldStatus: string; newStatus: string; actor: string; createdAt: string };
const statusLabel: Record<string, string> = { pending: "待核验", approved: "核验通过", hidden: "隐藏" };

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [counts, setCounts] = useState<Array<{ status: string; count: number }>>([]);
  const [recentReviews, setRecentReviews] = useState<ReviewEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function request(method: string, body?: object, query = "") {
    const response = await fetch(`/api/admin/reviews${query}`, {
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

  return <div className={styles.appShell}><header className={styles.topbar}><div className={styles.topbarInner}><Link href="/">校招雷达 · 返回招聘大厅</Link></div></header><main className={styles.main}>
    <section className={styles.pageIntro}><div><span className={styles.sectionKicker}>OPERATIONS</span><h1>运营审核</h1><p>口令仅用于本次页面操作，不保存在浏览器。未核验记录仍可在招聘大厅看到，并标记为待核验。</p></div></section>
    <section className={styles.searchPanel}><div className={styles.searchInput}><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="输入管理口令" aria-label="管理口令" autoComplete="off" /></div><button className={styles.primaryButton} disabled={busy} onClick={() => void load()}><RefreshCw size={16} /> 读取待审核</button></section>
    {error && <p role="alert" className={styles.empty}>{error}</p>}
    <div className={styles.sectionHead}><h2>待审核招聘</h2><span>{counts.map((item) => `${item.status}: ${item.count}`).join(" · ")}</span></div>
    <div className={styles.tableCard}><table><thead><tr><th>公司</th><th>招聘公告</th><th>来源</th><th>操作</th></tr></thead><tbody>{jobs.map((job) => <tr key={`${job.source}:${job.sourceId}`}><td>{job.company}</td><td>{job.title}</td><td>{job.source}</td><td><div className={styles.reviewActions}><button disabled={busy} className={styles.outlineButton} onClick={() => void review(job, "approved")}><Check size={15} /> 核验通过</button><button disabled={busy} className={styles.outlineButton} onClick={() => void review(job, "hidden")}><EyeOff size={15} /> 隐藏</button></div></td></tr>)}</tbody></table>{hasMore && <button className={styles.outlineButton} onClick={() => void load(jobs.length, true)} disabled={busy}><RefreshCw size={15} /> 加载更多</button>}</div>
    <div className={styles.sectionHead}><h2>最近审核记录</h2></div>
    <div className={styles.tableCard}><table><thead><tr><th>时间</th><th>来源</th><th>公告编号</th><th>状态变更</th><th>操作者</th></tr></thead><tbody>{recentReviews.map((event, index) => <tr key={`${event.createdAt}:${event.source}:${event.sourceId}:${index}`}><td>{new Date(event.createdAt).toLocaleString("zh-CN")}</td><td>{event.source}</td><td>{event.sourceId}</td><td>{statusLabel[event.oldStatus] || event.oldStatus} → {statusLabel[event.newStatus] || event.newStatus}</td><td>管理员</td></tr>)}</tbody></table></div>
  </main></div>;
}
