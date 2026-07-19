/**
 * 指定日の日別データを公式アーカイブから復元する(欠損日の修復用)。
 *
 * 番組表(B)からレースを再構築し、競走成績(K)が取得できれば結果も反映する。
 * 既にデータがある日は誤上書き防止のためスキップ(FORCE=1で強制)。
 *
 * 実行: RESTORE_DATE=2026-07-05 node --experimental-strip-types src/restoreDay.ts
 */
import { fetchBFileText, fetchKFileText, NotPublishedError } from "./officialFetcher.ts";
import { convertBText } from "./dataSource.ts";
import { parseKFile } from "./resultsParser.ts";
import { applyResults } from "./verify.ts";
import { saveDay, loadDay } from "./store.ts";

async function main() {
  const date = process.env.RESTORE_DATE || process.argv[2] || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("使い方: RESTORE_DATE=YYYY-MM-DD node --experimental-strip-types src/restoreDay.ts");
    process.exit(1);
  }

  const existing = await loadDay(date);
  if (existing && existing.length > 0 && process.env.FORCE !== "1") {
    console.log(`[restore] ${date} は既に${existing.length}レースあります(上書きするには FORCE=1)`);
    return;
  }

  console.log(`[restore] ${date} の番組表を取得中…`);
  const races = convertBText(await fetchBFileText(date), date);
  console.log(`[restore] 番組表から${races.length}レースを再構築`);

  try {
    const parsed = parseKFile(await fetchKFileText(date));
    const { updated, warnings } = applyResults(races, parsed);
    for (const w of warnings.slice(0, 5)) console.warn(`[restore] 警告: ${w}`);
    console.log(`[restore] 競走成績を反映: ${updated}レースをverified化`);
  } catch (e) {
    if (e instanceof NotPublishedError) console.warn(`[restore] ${date} の成績ファイルは未配布(番組のみ復元)`);
    else console.warn(`[restore] 成績の取得失敗(番組のみ復元): ${(e as Error).message}`);
  }

  const file = await saveDay(date, races);
  console.log(`[restore] 保存完了: ${file}`);
}

main().catch((e) => {
  console.error("[restore] 失敗:", e);
  process.exit(1);
});
