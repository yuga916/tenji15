/**
 * 女子選手の判定(💛マーク用)。
 * - 公式の「レーサー期別成績(ファン手帳)」データの性別欄(1:男 2:女)から、女子選手の登録番号一覧を作る
 *   https://www.boatrace.jp/owpc/pc/extra/data/download.html (レイアウト: layout.html)
 * - 取得は最大でも1日1回・成功後は14日間再取得しない(低負荷)
 * - 結果は data/female-racers.json に保存(ビルドはこのファイルを読むだけ)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { zenToHan } from "./officialParser.ts";

export const FEMALE_FILE = path.join("data", "female-racers.json");
const FAN_BASE = "https://www.boatrace.jp/static_extra/pc_static/download/data/kibetsu";

export interface FemaleData { source: string; updated: string; total: number; regNos: string[] }

/** 公開されている可能性のある期別成績ファイル(新しい順)。fanYY04 / fanYY10 */
export function fanFileCandidates(todayISO: string): string[] {
  const [y, m] = todayISO.split("-").map(Number);
  const out: string[] = [];
  for (let yy = y; yy >= y - 2 && out.length < 4; yy--) {
    for (const mm of [10, 4]) {
      if (yy === y && mm > m) continue;
      out.push(`${FAN_BASE}/fan${String(yy % 100).padStart(2, "0")}${String(mm).padStart(2, "0")}.lzh`);
      if (out.length >= 4) break;
    }
  }
  return out;
}

/**
 * ファン手帳テキストから女子選手の登録番号を抜き出す。
 * 1行=1選手: 登番(4) 名前漢字 名前カナ 支部 級(2) 年号(1) 生年月日(6) 性別(1) 年齢(2) …
 * 固定バイト位置はShift_JISデコード後にずれるため、「級+年号+生年月日6桁+性別」の並びを手がかりにする。
 */
export function parseFanFemale(text: string): { female: string[]; total: number } {
  const female: string[] = [];
  let total = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = zenToHan(raw);
    const m = line.match(/^(\d{4}).*?(?:A1|A2|B1|B2)[A-Z]\d{6}([12])\d{2}/);
    if (!m) continue;
    total++;
    if (m[2] === "2") female.push(m[1]);
  }
  return { female: [...new Set(female)].sort(), total };
}

export async function loadFemaleData(): Promise<FemaleData | null> {
  try {
    const d = JSON.parse(await readFile(FEMALE_FILE, "utf-8")) as FemaleData;
    return Array.isArray(d.regNos) ? d : null;
  } catch { return null; }
}

/** 必要なら期別成績を取得して女子選手一覧を更新(失敗しても既存ファイルを維持) */
export async function refreshFemaleRacers(todayISO: string, getMeta: () => Promise<Record<string, string>>, setMeta: (k: string, v: string) => Promise<void>): Promise<void> {
  const cur = await loadFemaleData();
  if (cur && Date.now() - new Date(cur.updated).getTime() < 14 * 86400000) return;
  const meta = await getMeta();
  if (meta["female-try"] === todayISO) return; // 失敗時も1日1回まで
  await setMeta("female-try", todayISO);
  const { fetchLzhUrlText } = await import("./officialFetcher.ts");
  for (const url of fanFileCandidates(todayISO)) {
    try {
      const text = await fetchLzhUrlText(url, "期別成績");
      const { female, total } = parseFanFemale(text);
      // 女子選手は全体の1〜2割程度。極端な値は読み取り失敗とみなして保存しない
      if (total < 1000 || female.length < 100 || female.length > total * 0.3) {
        console.warn(`[female] 読み取り結果が不自然なため保存しません: total=${total} female=${female.length} (${url})`);
        continue;
      }
      if (cur && cur.source === url && cur.regNos.length === female.length) {
        await writeFile(FEMALE_FILE, JSON.stringify({ ...cur, updated: new Date().toISOString() }) + "\n", "utf-8");
        return;
      }
      await mkdir(path.dirname(FEMALE_FILE), { recursive: true });
      const data: FemaleData = { source: url, updated: new Date().toISOString(), total, regNos: female };
      await writeFile(FEMALE_FILE, JSON.stringify(data) + "\n", "utf-8");
      console.log(`[female] 女子選手 ${female.length}/${total}名を保存 (${url})`);
      return;
    } catch (e) {
      console.warn(`[female] 取得失敗(次の候補へ): ${url} ${(e as Error).message}`);
    }
  }
}
