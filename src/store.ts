/** データ保存層。デモはJSONファイル、将来はDBに置き換え可能。 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Race } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

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
