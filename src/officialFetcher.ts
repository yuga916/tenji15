/**
 * 公式配布ファイルのダウンロード+LZH解凍。
 *
 * 対象:
 * - 番組表Bファイル   https://www1.mbrace.or.jp/od2/B/{YYYYMM}/b{YYMMDD}.lzh
 * - 競走成績Kファイル https://www1.mbrace.or.jp/od2/K/{YYYYMM}/k{YYMMDD}.lzh
 * - 1日1ファイル(全24場分)。取得は各1リクエストのみ(低負荷)
 * - LZH解凍は外部コマンド(lhasa / lha / 7z)に委譲。
 *   GitHub Actionsでは `sudo apt-get install -y lhasa` を事前実行する
 * - 中身はShift_JISテキスト。Node(full-ICU)のTextDecoderでデコード
 */
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE_URL = "https://www1.mbrace.or.jp/od2";

export function bFileUrl(dateISO: string): string {
  const [y, m, d] = dateISO.split("-");
  return `${BASE_URL}/B/${y}${m}/b${y.slice(2)}${m}${d}.lzh`;
}

export function kFileUrl(dateISO: string): string {
  const [y, m, d] = dateISO.split("-");
  return `${BASE_URL}/K/${y}${m}/k${y.slice(2)}${m}${d}.lzh`;
}

/** 配布ファイルがまだ公開されていない(404)ことを表すエラー */
export class NotPublishedError extends Error {
  constructor(url: string) {
    super(`未配布(404): ${url}`);
    this.name = "NotPublishedError";
  }
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "kyotei-chokuzen/0.1 (personal analysis; low-frequency; contact via site)" },
  });
  if (res.status === 404) throw new NotPublishedError(url);
  if (!res.ok) throw new Error(`ダウンロード失敗 ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function extractLzh(archivePath: string, outDir: string): void {
  const candidates: [string, string[]][] = [
    ["lhasa", ["-xw=" + outDir, archivePath]],
    ["lha", ["-xw=" + outDir, archivePath]],
    ["7z", ["x", `-o${outDir}`, "-y", archivePath]],
  ];
  const tried: string[] = [];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, { stdio: "pipe" });
    if (r.error) { tried.push(`${cmd}(未インストール)`); continue; }
    if (r.status === 0) return;
    tried.push(`${cmd}(exit ${r.status})`);
  }
  throw new Error(
    `LZH解凍に失敗しました。試行: ${tried.join(", ")}。` +
    `GitHub Actionsでは 'sudo apt-get install -y lhasa' を実行してください。`
  );
}

function decodeShiftJis(buf: Buffer): string {
  try {
    return new TextDecoder("shift_jis").decode(buf);
  } catch {
    throw new Error("Shift_JISデコードに失敗。Nodeがfull-ICUビルドか確認してください(公式配布のNode 22はOK)。");
  }
}

/** LZH配布ファイルをダウンロード→解凍→Shift_JISデコードして返す共通処理 */
async function fetchLzhText(url: string, label: string): Promise<string> {
  console.log(`[official] ${label}取得: ${url}`);
  const lzh = await download(url);

  const dir = await mkdtemp(path.join(tmpdir(), "tenji15-"));
  const archivePath = path.join(dir, "archive.lzh");
  await writeFile(archivePath, lzh);
  extractLzh(archivePath, dir);

  const files = (await readdir(dir)).filter((f) => /\.txt$/i.test(f));
  if (files.length === 0) throw new Error(`解凍後にTXTが見つかりません: ${dir}`);
  const buf = await readFile(path.join(dir, files[0]));
  return decodeShiftJis(buf);
}

/** 指定日の番組表テキスト(デコード済み)を取得 */
export async function fetchBFileText(dateISO: string): Promise<string> {
  return fetchLzhText(bFileUrl(dateISO), "番組表");
}

/** 指定日の競走成績テキスト(デコード済み)を取得。全レース確定後の夜〜翌日に配布される */
export async function fetchKFileText(dateISO: string): Promise<string> {
  return fetchLzhText(kFileUrl(dateISO), "競走成績");
}
