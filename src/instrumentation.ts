export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const globalState = globalThis as typeof globalThis & { oilFoxTimer?: ReturnType<typeof setInterval> };
  if (globalState.oilFoxTimer) return;
  const { syncOilFox } = await import("@/lib/oilfox-sync");
  const run = () => syncOilFox(false).catch((error) => console.error("OilFox sync failed:", error instanceof Error ? error.message : "unknown error"));
  setTimeout(run, 10_000);
  globalState.oilFoxTimer = setInterval(run, 60 * 60_000);
}
