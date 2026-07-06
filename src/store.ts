/**
 * データ保存層。
 * 日別JSON(data/days/YYYY-MM-DD.json)で蓄積し、答え合わせ済みレースを
 * ストックコンテンツとして残す。GitHub Actionsではdata/daysをリポジトリに
 * コミットして永続化する。
 */
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Race } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DAYS_DIR = path.join(DATA_DIR, "days");

const dayFile = (dateISO: string) => path.join(DAYS_DIR, `${dateISO}.json`);

export async function saveDay(dateISO: string, races: Race[]): Promise<string> {
  await mkdir(DAYS_DIR, { recursive: true });
  const file = dayFile(dateISO);
  await writeFile(file, JSON.stringify(races, null, 2), "utf-8");
  return file;
}

export async function loadDay(dateISO: string): Promise<Race[] | null> {
  try {
    return JSON.parse(await readFile(dayFile(dateISO), "utf-8"));
  } catch {
    return null;
  }
}

/** 保存済みの日付一覧(昇順) */
export async function listDays(): Promise<string[]> {
  try {
    return (await readdir(DAYS_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

/** 全日付のレースを読み込む(日付昇順)。日別データがなければ旧形式にフォールバック */
export async function loadAllRaces(): Promise<Race[]> {
  const days = await listDays();
  if (days.length > 0) {
    const all: Race[] = [];
    for (const d of days) {
      const races = await loadDay(d);
      if (races) all.push(...races);
    }
    return all;
  }
  return loadRaces(); // 旧形式(latest-races.json)
}

/** 旧形式(latest-races.json)→日別ファイルへの移行。移行済み・データなしなら何もしない */
export async function migrateLegacy(): Promise<void> {
  const days = await listDays();
  if (days.length > 0) return;
  try {
    const races = await loadRaces();
    const byDate = new Map<string, Race[]>();
    for (const r of races) {
      const list = byDate.get(r.dateISO) ?? [];
      list.push(r);
      byDate.set(r.dateISO, list);
    }
    for (const [d, list] of byDate) await saveDay(d, list);
    if (byDate.size > 0) console.log(`[store] 旧形式から${byDate.size}日分を日別ファイルへ移行しました`);
  } catch {
    /* 旧データなし */
  }
}

/* ---- 旧形式(互換のため残置) ---- */
export async function saveRaces(races: Race[]): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "latest-races.json");
  await writeFile(file, JSON.stringify(races, null, 2), "utf-8");
  return file;
}

export async function loadRaces(): Promise<Race[]> {
  const file = path.join(DATA_DIR, "latest-races.json");
  return JSON.parse(await readFile(file, "utf-8"));
}
