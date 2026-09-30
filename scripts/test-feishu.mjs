import "./config.mjs";
import { notify } from "./notify.mjs";

if (!process.env.FEISHU_WEBHOOK_URL) throw new Error("尚未配置 FEISHU_WEBHOOK_URL，请先运行 npm run setup:feishu");

await notify(`校招雷达真实通知测试成功。测试时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`);
console.log("飞书测试消息发送成功，请在目标群确认已经收到。 ");
