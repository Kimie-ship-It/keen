import { createHmac } from "node:crypto";

export async function notify(message, fetchImpl = fetch, now = Date.now) {
  const webhook = process.env.FEISHU_WEBHOOK_URL;
  if (!webhook) return;
  const url = new URL(webhook);
  if (url.protocol !== "https:" || url.hostname !== "open.feishu.cn" || !url.pathname.startsWith("/open-apis/bot/v2/hook/")) throw new Error("请输入飞书自定义机器人 HTTPS 地址");
  const payload = { msg_type: "text", content: { text: message.slice(0, 1000) } };
  const secret = process.env.FEISHU_SIGN_SECRET;
  if (secret) {
    const timestamp = String(Math.floor(now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = createHmac("sha256", timestamp + "\n" + secret).update("").digest("base64");
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`通知发送失败：HTTP ${response.status}`);
  const result = await response.json();
  const code = typeof result.code === "number" ? result.code : result.StatusCode;
  if (code !== 0) throw new Error(`飞书拒绝通知：${result.msg || result.StatusMessage || "请检查机器人权限和安全配置"}`);
}

export const notifyFailure = (error) => notify("校招雷达采集失败：" + String(error?.message || error).slice(0, 500));
