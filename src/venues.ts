/** 全24場マスタ: 場コード(JCD)→名称・スラッグ・イン逃げ基準値 */

export interface VenueInfo {
  jcd: string;      // "01"〜"24"
  name: string;     // 例: "住之江"
  slug: string;
  inEscapeBase: number; // 1コース1着率の概算基準値%（公開データの一般的水準。蓄積データで更新予定）
}

export const VENUES: VenueInfo[] = [
  { jcd: "01", name: "桐生", slug: "kiryu", inEscapeBase: 50 },
  { jcd: "02", name: "戸田", slug: "toda", inEscapeBase: 44 },
  { jcd: "03", name: "江戸川", slug: "edogawa", inEscapeBase: 45 },
  { jcd: "04", name: "平和島", slug: "heiwajima", inEscapeBase: 45 },
  { jcd: "05", name: "多摩川", slug: "tamagawa", inEscapeBase: 52 },
  { jcd: "06", name: "浜名湖", slug: "hamanako", inEscapeBase: 52 },
  { jcd: "07", name: "蒲郡", slug: "gamagori", inEscapeBase: 55 },
  { jcd: "08", name: "常滑", slug: "tokoname", inEscapeBase: 54 },
  { jcd: "09", name: "津", slug: "tsu", inEscapeBase: 54 },
  { jcd: "10", name: "三国", slug: "mikuni", inEscapeBase: 53 },
  { jcd: "11", name: "びわこ", slug: "biwako", inEscapeBase: 49 },
  { jcd: "12", name: "住之江", slug: "suminoe", inEscapeBase: 56 },
  { jcd: "13", name: "尼崎", slug: "amagasaki", inEscapeBase: 56 },
  { jcd: "14", name: "鳴門", slug: "naruto", inEscapeBase: 50 },
  { jcd: "15", name: "丸亀", slug: "marugame", inEscapeBase: 55 },
  { jcd: "16", name: "児島", slug: "kojima", inEscapeBase: 55 },
  { jcd: "17", name: "宮島", slug: "miyajima", inEscapeBase: 53 },
  { jcd: "18", name: "徳山", slug: "tokuyama", inEscapeBase: 62 },
  { jcd: "19", name: "下関", slug: "shimonoseki", inEscapeBase: 58 },
  { jcd: "20", name: "若松", slug: "wakamatsu", inEscapeBase: 56 },
  { jcd: "21", name: "芦屋", slug: "ashiya", inEscapeBase: 60 },
  { jcd: "22", name: "福岡", slug: "fukuoka", inEscapeBase: 52 },
  { jcd: "23", name: "唐津", slug: "karatsu", inEscapeBase: 53 },
  { jcd: "24", name: "大村", slug: "omura", inEscapeBase: 65 },
];

export const venueByJcd = new Map(VENUES.map((v) => [v.jcd, v]));

export const venueBySlug = new Map(VENUES.map((v) => [v.slug, v]));
