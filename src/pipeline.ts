/**
 * データ取得を1回実行して保存する(GitHub Actions / cron から呼ぶ入口)。
 * officialモードで取得に失敗した場合(未配布時刻・ネットワーク等)は、
 * サイトを壊さないため前回データ→mockの順でフォールバックする。
 */
import { createDataSource, MockDataSource } from "./dataSource.ts";
import { saveRaces, loadRaces } from "./store.ts";

export async function runPipelineOnce(dateISO?: string): Promise<void> {
  const date = dateISO ?? jstToday();
  const source = createDataSource();
  console.log(`[pipeline] データ取得: ${date} / ソース: ${source.label}`);

  try {
    const races = await source.fetchRaces(date);
    const file = await saveRaces(races);
    console.log(`[pipeline] ${races.length}レースを保存: ${file}`);
    return;
  } catch (e) {
    console.error(`[pipeline] 取得失敗: ${(e as Error).message}`);
  }

  // フォールバック1: 前回データがあればそのまま使う(ビルドを継続)
  try {
    const prev = await loadRaces();
    console.warn(`[pipeline] フォールバック: 前回データ${prev.length}レースを維持します`);
    return;
  } catch {
    /* 前回データなし */
  }

  // フォールバック2: mock
  console.warn("[pipeline] フォールバック: mockデータを使用します");
  const races = await new MockDataSource().fetchRaces(date);
  await saveRaces(races);
}

/** JSTの今日(YYYY-MM-DD)。Actionsのランナー(UTC)でも日付がズレないように */
function jstToday(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPipelineOnce(process.argv[2]).catch((e) => {
    console.error("[pipeline] 失敗:", e);
    process.exit(1);
  });
}
