/** 競艇チョクゼン 内部スキーマ */

/** レースページのライフサイクル: 事前 → シグナル点灯(展示反映) → 答え合わせ(結果検証) */
export type RaceStatus = "pre" | "signal" | "verified";

export type SignalType = "gap" | "formation" | "extime" | "slit" | "bias" | "parts";
export type SignalImpact = "up" | "down" | "neutral";

export interface Entry {
  lane: number;            // 艇番 1-6
  regNo?: string;          // 登録番号(選手ページの生成キー。旧データはundefined)
  name: string;
  racerClass: string;      // A1/A2/B1/B2
  stAvg: number;           // 平均ST
  natWinRate: number;      // 全国勝率
  motorRate: number;       // モーター2連率 %
  course?: number;         // 進入コース(スタート展示後に確定)
  exTime?: number;         // 展示タイム
  exDev?: number;          // 展示偏差値(当日分布・節間自己比の合成)
  exSt?: number;           // 展示ST
  preProb: number;         // 事前AI勝率 0-1
  aiProb: number;          // 展示反映後AI勝率 0-1
  marketProb?: number;     // 直前オッズ逆算の市場勝率 0-1
}

export interface Signal {
  time: string;            // HH:mm
  type: SignalType;
  impact: SignalImpact;
  text: string;            // 例: "4号艇の展示偏差+2.1σ。AI勝率14%→27%に上昇、オッズは未反応"
  hit?: boolean;           // 結果検証後: シグナルは正しかったか
}

export interface KimariteProb {
  nige: number;            // 逃げ
  makuri: number;          // まくり(まくり差し含む)
  sashi: number;           // 差し
  other: number;           // その他(抜き・恵まれ)
}

export interface RaceResult {
  finish: number[];        // 着順の艇番 [1着, 2着, 3着]
  kimarite: string;        // 決まり手
  payout3t: number;        // 3連単払戻(円)
  popularity: number;      // 3連単人気
  review: string;          // 答え合わせ本文(直前サインがどう効いたか)
}

export interface Race {
  raceId: string;
  venue: string;           // 例: "住之江"
  venueSlug: string;       // 例: "suminoe"
  dateISO: string;
  raceNo: number;
  name: string;            // 例: "一般戦" "G1◯◯記念"
  grade?: string;          // G1/G2/G3(一般はundefined)
  status: RaceStatus;
  closeTime: string;       // 締切 HH:mm (JST)
  windDir: string;         // 風向
  windSpeed: number;       // m
  wave: number;            // cm
  inEscapeProbPre: number; // 事前イン逃げ確率 %
  inEscapeProb: number;    // 現在(展示反映後)のイン逃げ確率 %
  inNote: string;          // イン逃げ確率の解説
  kimarite: KimariteProb;
  kimariteNote: string;
  entries: Entry[];
  signals: Signal[];
  verdict: string;         // シグナルカードの結論文
  result?: RaceResult;     // status=verified のみ
  updatedAt: string;
  modelVersion: string;
}
