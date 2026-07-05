/** データ取得を1回実行して保存する(GitHub Actions / cron から呼ぶ入口) */
import { createDataSource } from "./dataSource.ts";
import { saveRaces } from "./store.ts";

export async function runPipelineOnce(dateISO?: string): Promise<void> {
  const date = dateISO ?? new Date().toISOString().slice(0, 10);
  const source = createDataSource();
  console.log(`[pipeline] データ取得: ${date} / ソース: ${source.label}`);
  const races = await source.fetchRaces(date);
  const file = await saveRaces(races);
  console.log(`[pipeline] ${races.length}レースを保存: ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPipelineOnce(process.argv[2]).catch((e) => {
    console.error("[pipeline] 失敗:", e);
    process.exit(1);
  });
}
