import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "校招雷达 | 高校招聘信息中转站", description: "汇总已接入高校的公开招聘信息，帮助毕业生更快发现机会。" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
