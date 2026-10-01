export async function onRequestError(error) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (typeof error?.digest === "string" && /^(NEXT_NOT_FOUND|NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK;404)/.test(error.digest)) return;
  const { reportError } = await import("../scripts/monitor.mjs");
  await reportError(error, { operation: "server.request" });
}
