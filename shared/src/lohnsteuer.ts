/**
 * Lohnsteuer nach dem amtlichen Programmablaufplan (PAP) des Bundesfinanzministeriums.
 *
 * Übertragung des BMF-Pseudocodes „Lohnsteuer2026.xml“ (Stand 23.10.2025) nach TypeScript.
 * Methoden- und Variablennamen entsprechen dem PAP, damit sich jede Zeile mit dem Original
 * vergleichen lässt. Gerechnet wird wie in Java-BigDecimal mit ganzen Zahlen (BigInt) –
 * keine Gleitkomma-Rundungsfehler. Geprüft gegen Testfälle des BMF-Steuerrechners
 * (siehe shared/test/lohnsteuer.test.ts).
 *
 * Alle Geldbeträge an der Schnittstelle in Cent (ganze Zahlen).
 */

// ------------------------------------------------------------------ Dezimalzahl wie java.math.BigDecimal
type Mode = 'down' | 'up';
const TEN = BigInt(10), ZERO_N = BigInt(0);
const pow10 = (n: number) => TEN ** BigInt(n);

class D {
  constructor(readonly n: bigint, readonly s: number) {}
  static of(v: number | string): D {
    const t = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(v)) : v;
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(t.trim());
    if (!m) throw new Error(`Keine Zahl: ${t}`);
    const frac = m[3] ?? '';
    let n = BigInt(`${m[1]}${m[2]}${frac}`), s = frac.length;
    const e = m[4] ? Number(m[4]) : 0;
    if (e > 0) { if (e >= s) { n *= pow10(e - s); s = 0; } else s -= e; } else s -= e;
    return new D(n, s);
  }
  private align(o: D): [bigint, bigint, number] {
    if (this.s === o.s) return [this.n, o.n, this.s];
    return this.s > o.s ? [this.n, o.n * pow10(this.s - o.s), this.s] : [this.n * pow10(o.s - this.s), o.n, o.s];
  }
  add(o: D) { const [a, b, s] = this.align(o); return new D(a + b, s); }
  subtract(o: D) { const [a, b, s] = this.align(o); return new D(a - b, s); }
  multiply(o: D) { return new D(this.n * o.n, this.s + o.s); }
  /** Division auf `scale` Stellen; ohne Angabe wie BigDecimal.divide(x) (exakt – im PAP stets abbrechend) */
  divide(o: D, scale?: number, mode: Mode = 'down'): D {
    if (scale === undefined) {
      const q = this.divide(o, Math.max(this.s, 0) + 30, 'down');
      return q.strip();
    }
    // Ergebnis = (this.n / 10^this.s) / (o.n / 10^o.s) auf scale Stellen
    let num = this.n * pow10(o.s), den = o.n * pow10(this.s);
    num *= pow10(scale);
    if (den < ZERO_N) { num = -num; den = -den; }
    return new D(D.roundDiv(num, den, mode), scale);
  }
  setScale(scale: number, mode: Mode): D {
    if (scale >= this.s) return new D(this.n * pow10(scale - this.s), scale);
    return new D(D.roundDiv(this.n, pow10(this.s - scale), mode), scale);
  }
  private static roundDiv(num: bigint, den: bigint, mode: Mode): bigint {
    const q = num / den, r = num % den; // BigInt rundet zur Null hin
    if (r === ZERO_N || mode === 'down') return q;
    return num < ZERO_N ? q - BigInt(1) : q + BigInt(1); // ROUND_UP: von der Null weg
  }
  private strip(): D { let { n, s } = this; while (s > 0 && n % TEN === ZERO_N) { n /= TEN; s--; } return new D(n, s); }
  compareTo(o: D): -1 | 0 | 1 { const [a, b] = this.align(o); return a === b ? 0 : a > b ? 1 : -1; }
  longValue(): number { return Number(this.n / pow10(this.s)); }
  toNumber(): number { return Number(this.n) / Number(pow10(this.s)); }
}
const V = (v: number) => D.of(v);
const ZERO = V(0), ONE = V(1);
const DOWN: Mode = 'down', UP: Mode = 'up';

// ------------------------------------------------------------------ Ein- und Ausgaben
export interface LohnsteuerInput {
  /** Lohnzahlungszeitraum: 1 Jahr, 2 Monat, 3 Woche, 4 Tag */
  LZZ: 1 | 2 | 3 | 4;
  /** Steuerpflichtiger laufender Arbeitslohn im Zeitraum (Cent) */
  RE4: number;
  STKL: 1 | 2 | 3 | 4 | 5 | 6;
  /** Zahl der Kinderfreibeträge (z. B. 0.5, 1, 1.5) */
  ZKF?: number;
  /** Kirchensteuerpflicht (Religionsgemeinschaft ≠ 0) */
  R?: number;
  /** Kassenindividueller Zusatzbeitrag in Prozent (z. B. 2.9) */
  KVZ?: number;
  /** 1 = Kinderlosenzuschlag Pflegeversicherung */
  PVZ?: 0 | 1;
  /** Zahl der Beitragsabschläge PV ab dem 2. Kind (0–4) */
  PVA?: number;
  /** 1 = Sachsen (Pflegeversicherung) */
  PVS?: 0 | 1;
  /** 0 = gesetzlich, 1 = privat krankenversichert */
  PKV?: 0 | 1;
  /** Monatsbeitrag private Basis-Kranken-/Pflegeversicherung (Cent) */
  PKPV?: number;
  /** Monatlicher Arbeitgeberzuschuss dazu (Cent) */
  PKPVAGZ?: number;
  /** 1 = nicht rentenversicherungspflichtig */
  KRV?: 0 | 1;
  /** 1 = nicht arbeitslosenversicherungspflichtig */
  ALV?: 0 | 1;
  /** Faktorverfahren (Steuerklasse IV): af=1 und f */
  af?: 0 | 1;
  f?: number;
  /** Freibetrag / Hinzurechnungsbetrag je Zeitraum (Cent) */
  LZZFREIB?: number;
  LZZHINZU?: number;
  /** Sonstiger Bezug (Cent) und voraussichtlicher Jahresarbeitslohn ohne ihn (Cent) */
  SONSTB?: number;
  JRE4?: number;
  JFREIB?: number;
  JHINZU?: number;
  JRE4ENT?: number;
  SONSTENT?: number;
  /** Altersentlastungsbetrag */
  ALTER1?: 0 | 1;
  AJAHR?: number;
  /** Versorgungsbezüge */
  VBEZ?: number; VBEZM?: number; VBEZS?: number; VBS?: number; VJAHR?: number; JVBEZ?: number; ZMVB?: number; STERBE?: number; MBV?: number;
}
export interface LohnsteuerResult {
  /** Lohnsteuer für den Zeitraum (Cent) */
  LSTLZZ: number;
  /** Solidaritätszuschlag für den Zeitraum (Cent) */
  SOLZLZZ: number;
  /** Bemessungsgrundlage Kirchensteuer (Cent) */
  BK: number;
  /** Lohnsteuer, Soli, Kirchensteuer-Basis für den sonstigen Bezug (Cent) */
  STS: number; SOLZS: number; BKS: number;
  VFRB: number; VFRBS1: number; VFRBS2: number; WVFRB: number; WVFRBO: number; WVFRBM: number;
}

export const LOHNSTEUER_YEARS = [2026] as const;

// ------------------------------------------------------------------ PAP 2026
const TAB1 = [0, 0.4, 0.384, 0.368, 0.352, 0.336, 0.32, 0.304, 0.288, 0.272, 0.256, 0.24, 0.224, 0.208, 0.192, 0.176, 0.16, 0.152, 0.144, 0.14, 0.136, 0.132, 0.128, 0.124, 0.12, 0.116, 0.112, 0.108, 0.104, 0.1, 0.096, 0.092, 0.088, 0.084, 0.08, 0.076, 0.072, 0.068, 0.064, 0.06, 0.056, 0.052, 0.048, 0.044, 0.04, 0.036, 0.032, 0.028, 0.024, 0.02, 0.016, 0.012, 0.008, 0.004, 0].map(V);
const TAB2 = [0, 3000, 2880, 2760, 2640, 2520, 2400, 2280, 2160, 2040, 1920, 1800, 1680, 1560, 1440, 1320, 1200, 1140, 1080, 1050, 1020, 990, 960, 930, 900, 870, 840, 810, 780, 750, 720, 690, 660, 630, 600, 570, 540, 510, 480, 450, 420, 390, 360, 330, 300, 270, 240, 210, 180, 150, 120, 90, 60, 30, 0].map(V);
const TAB3 = [0, 900, 864, 828, 792, 756, 720, 684, 648, 612, 576, 540, 504, 468, 432, 396, 360, 342, 324, 315, 306, 297, 288, 279, 270, 261, 252, 243, 234, 225, 216, 207, 198, 189, 180, 171, 162, 153, 144, 135, 126, 117, 108, 99, 90, 81, 72, 63, 54, 45, 36, 27, 18, 9, 0].map(V);
const TAB4 = TAB1;
const TAB5 = [0, 1900, 1824, 1748, 1672, 1596, 1520, 1444, 1368, 1292, 1216, 1140, 1064, 988, 912, 836, 760, 722, 684, 665, 646, 627, 608, 589, 570, 551, 532, 513, 494, 475, 456, 437, 418, 399, 380, 361, 342, 323, 304, 285, 266, 247, 228, 209, 190, 171, 152, 133, 114, 95, 76, 57, 38, 19, 0].map(V);
const ZAHL1 = V(1), ZAHL2 = V(2), ZAHL7 = V(7), ZAHL12 = V(12), ZAHL100 = V(100), ZAHL360 = V(360), ZAHL700 = V(700), ZAHL10000 = V(10000);

class Pap2026 {
  // Eingaben
  af = 1; AJAHR = 0; ALTER1 = 0; ALV = 0; f = 1.0;
  JFREIB = ZERO; JHINZU = ZERO; JRE4 = ZERO; JRE4ENT = ZERO; JVBEZ = ZERO; KRV = 0; KVZ = ZERO; LZZ = 1;
  LZZFREIB = ZERO; LZZHINZU = ZERO; MBV = ZERO; PKPV = ZERO; PKPVAGZ = ZERO; PKV = 0; PVA = ZERO; PVS = 0; PVZ = 0; R = 0;
  RE4 = ZERO; SONSTB = ZERO; SONSTENT = ZERO; STERBE = ZERO; STKL = 1; VBEZ = ZERO; VBEZM = ZERO; VBEZS = ZERO; VBS = ZERO; VJAHR = 0; ZKF = ZERO; ZMVB = 0;
  // Ausgaben
  BK = ZERO; BKS = ZERO; LSTLZZ = ZERO; SOLZLZZ = ZERO; SOLZS = ZERO; STS = ZERO;
  VFRB = ZERO; VFRBS1 = ZERO; VFRBS2 = ZERO; WVFRB = ZERO; WVFRBO = ZERO; WVFRBM = ZERO;
  // Interne Felder
  ALTE = ZERO; ANP = ZERO; ANTEIL1 = ZERO; AVSATZAN = ZERO; BBGKVPV = ZERO; BBGRVALV = ZERO; BMG = ZERO; DIFF = ZERO; EFA = ZERO;
  FVB = ZERO; FVBSO = ZERO; FVBZ = ZERO; FVBZSO = ZERO; GFB = ZERO; HBALTE = ZERO; HFVB = ZERO; HFVBZ = ZERO; HFVBZSO = ZERO; HOCH = ZERO;
  J = 0; JBMG = ZERO; JLFREIB = ZERO; JLHINZU = ZERO; JW = ZERO; K = 0; KFB = ZERO; KVSATZAN = ZERO; KZTAB = 0; LSTJAHR = ZERO;
  LSTOSO = ZERO; LSTSO = ZERO; MIST = ZERO; PKPVAGZJ = ZERO; PVSATZAN = ZERO; RVSATZAN = ZERO; RW = ZERO; SAP = ZERO; SOLZFREI = ZERO;
  SOLZJ = ZERO; SOLZMIN = ZERO; SOLZSBMG = ZERO; SOLZSZVE = ZERO; ST = ZERO; ST1 = ZERO; ST2 = ZERO; VBEZB = ZERO; VBEZBSO = ZERO;
  VERGL = ZERO; VSPHB = ZERO; VSP = ZERO; VSPN = ZERO; VSPALV = ZERO; VSPKVPV = ZERO; VSPR = ZERO; W1STKL5 = ZERO; W2STKL5 = ZERO; W3STKL5 = ZERO;
  X = ZERO; Y = ZERO; ZRE4 = ZERO; ZRE4J = ZERO; ZRE4VP = ZERO; ZRE4VPR = ZERO; ZTABFB = ZERO; ZVBEZ = ZERO; ZVBEZJ = ZERO; ZVE = ZERO; ZX = ZERO; ZZX = ZERO;

  MAIN() {
    this.MPARA();
    this.MRE4JL();
    this.VBEZBSO = ZERO;
    this.MRE4();
    this.MRE4ABZ();
    this.MBERECH();
    this.MSONST();
  }

  MPARA() {
    this.BBGRVALV = V(101400);
    this.AVSATZAN = V(0.013);
    this.RVSATZAN = V(0.093);
    this.BBGKVPV = V(69750);
    this.KVSATZAN = this.KVZ.divide(ZAHL2).divide(ZAHL100).add(V(0.07));
    this.PVSATZAN = this.PVS === 1 ? V(0.023) : V(0.018);
    if (this.PVZ === 1) this.PVSATZAN = this.PVSATZAN.add(V(0.006));
    else this.PVSATZAN = this.PVSATZAN.subtract(this.PVA.multiply(V(0.0025)));
    this.W1STKL5 = V(14071);
    this.W2STKL5 = V(34939);
    this.W3STKL5 = V(222260);
    this.GFB = V(12348);
    this.SOLZFREI = V(20350);
  }

  MRE4JL() {
    const t = (x: D) => {
      if (this.LZZ === 1) return x.divide(ZAHL100, 2, DOWN);
      if (this.LZZ === 2) return x.multiply(ZAHL12).divide(ZAHL100, 2, DOWN);
      if (this.LZZ === 3) return x.multiply(ZAHL360).divide(ZAHL700, 2, DOWN);
      return x.multiply(ZAHL360).divide(ZAHL100, 2, DOWN);
    };
    this.ZRE4J = t(this.RE4); this.ZVBEZJ = t(this.VBEZ); this.JLFREIB = t(this.LZZFREIB); this.JLHINZU = t(this.LZZHINZU);
    if (this.af === 0) this.f = 1;
  }

  MRE4() {
    if (this.ZVBEZJ.compareTo(ZERO) === 0) {
      this.FVBZ = ZERO; this.FVB = ZERO; this.FVBZSO = ZERO; this.FVBSO = ZERO;
    } else {
      this.J = this.VJAHR < 2006 ? 1 : this.VJAHR < 2058 ? this.VJAHR - 2004 : 54;
      const J = this.J;
      if (this.LZZ === 1) {
        this.VBEZB = this.VBEZM.multiply(V(this.ZMVB)).add(this.VBEZS);
        this.HFVB = TAB2[J]!.divide(ZAHL12).multiply(V(this.ZMVB)).setScale(0, UP);
        this.FVBZ = TAB3[J]!.divide(ZAHL12).multiply(V(this.ZMVB)).setScale(0, UP);
      } else {
        this.VBEZB = this.VBEZM.multiply(ZAHL12).add(this.VBEZS).setScale(2, DOWN);
        this.HFVB = TAB2[J]!;
        this.FVBZ = TAB3[J]!;
      }
      this.FVB = this.VBEZB.multiply(TAB1[J]!).divide(ZAHL100).setScale(2, UP);
      if (this.FVB.compareTo(this.HFVB) === 1) this.FVB = this.HFVB;
      if (this.FVB.compareTo(this.ZVBEZJ) === 1) this.FVB = this.ZVBEZJ;
      this.FVBSO = this.FVB.add(this.VBEZBSO.multiply(TAB1[J]!).divide(ZAHL100)).setScale(2, UP);
      if (this.FVBSO.compareTo(TAB2[J]!) === 1) this.FVBSO = TAB2[J]!;
      this.HFVBZSO = this.VBEZB.add(this.VBEZBSO).divide(ZAHL100).subtract(this.FVBSO).setScale(2, DOWN);
      this.FVBZSO = this.FVBZ.add(this.VBEZBSO.divide(ZAHL100)).setScale(0, UP);
      if (this.FVBZSO.compareTo(this.HFVBZSO) === 1) this.FVBZSO = this.HFVBZSO.setScale(0, UP);
      if (this.FVBZSO.compareTo(TAB3[J]!) === 1) this.FVBZSO = TAB3[J]!;
      this.HFVBZ = this.VBEZB.divide(ZAHL100).subtract(this.FVB).setScale(2, DOWN);
      if (this.FVBZ.compareTo(this.HFVBZ) === 1) this.FVBZ = this.HFVBZ.setScale(0, UP);
    }
    this.MRE4ALTE();
  }

  MRE4ALTE() {
    if (this.ALTER1 === 0) { this.ALTE = ZERO; return; }
    this.K = this.AJAHR < 2006 ? 1 : this.AJAHR < 2058 ? this.AJAHR - 2004 : 54;
    this.BMG = this.ZRE4J.subtract(this.ZVBEZJ);
    this.ALTE = this.BMG.multiply(TAB4[this.K]!).setScale(0, UP);
    this.HBALTE = TAB5[this.K]!;
    if (this.ALTE.compareTo(this.HBALTE) === 1) this.ALTE = this.HBALTE;
  }

  MRE4ABZ() {
    this.ZRE4 = this.ZRE4J.subtract(this.FVB).subtract(this.ALTE).subtract(this.JLFREIB).add(this.JLHINZU).setScale(2, DOWN);
    if (this.ZRE4.compareTo(ZERO) === -1) this.ZRE4 = ZERO;
    this.ZRE4VP = this.ZRE4J;
    this.ZVBEZ = this.ZVBEZJ.subtract(this.FVB).setScale(2, DOWN);
    if (this.ZVBEZ.compareTo(ZERO) === -1) this.ZVBEZ = ZERO;
  }

  MBERECH() {
    this.MZTABFB();
    this.VFRB = this.ANP.add(this.FVB.add(this.FVBZ)).multiply(ZAHL100).setScale(0, DOWN);
    this.MLSTJAHR();
    this.WVFRB = this.ZVE.subtract(this.GFB).multiply(ZAHL100).setScale(0, DOWN);
    if (this.WVFRB.compareTo(ZERO) === -1) this.WVFRB = ZERO;
    this.LSTJAHR = this.ST.multiply(V(this.f)).setScale(0, DOWN);
    this.UPLSTLZZ();
    if (this.ZKF.compareTo(ZERO) === 1) {
      this.ZTABFB = this.ZTABFB.add(this.KFB);
      this.MRE4ABZ();
      this.MLSTJAHR();
      this.JBMG = this.ST.multiply(V(this.f)).setScale(0, DOWN);
    } else {
      this.JBMG = this.LSTJAHR;
    }
    this.MSOLZ();
  }

  MZTABFB() {
    this.ANP = ZERO;
    if (this.ZVBEZ.compareTo(ZERO) >= 0 && this.ZVBEZ.compareTo(this.FVBZ) === -1) this.FVBZ = V(this.ZVBEZ.longValue());
    if (this.STKL < 6) {
      if (this.ZVBEZ.compareTo(ZERO) === 1) {
        if (this.ZVBEZ.subtract(this.FVBZ).compareTo(V(102)) === -1) this.ANP = this.ZVBEZ.subtract(this.FVBZ).setScale(0, UP);
        else this.ANP = V(102);
      }
    } else {
      this.FVBZ = ZERO; this.FVBZSO = ZERO;
    }
    if (this.STKL < 6) {
      if (this.ZRE4.compareTo(this.ZVBEZ) === 1) {
        if (this.ZRE4.subtract(this.ZVBEZ).compareTo(V(1230)) === -1) this.ANP = this.ANP.add(this.ZRE4).subtract(this.ZVBEZ).setScale(0, UP);
        else this.ANP = this.ANP.add(V(1230));
      }
    }
    this.KZTAB = 1;
    if (this.STKL === 1) { this.SAP = V(36); this.KFB = this.ZKF.multiply(V(9756)).setScale(0, DOWN); }
    else if (this.STKL === 2) { this.EFA = V(4260); this.SAP = V(36); this.KFB = this.ZKF.multiply(V(9756)).setScale(0, DOWN); }
    else if (this.STKL === 3) { this.KZTAB = 2; this.SAP = V(36); this.KFB = this.ZKF.multiply(V(9756)).setScale(0, DOWN); }
    else if (this.STKL === 4) { this.SAP = V(36); this.KFB = this.ZKF.multiply(V(4878)).setScale(0, DOWN); }
    else if (this.STKL === 5) { this.SAP = V(36); this.KFB = ZERO; }
    else this.KFB = ZERO;
    this.ZTABFB = this.EFA.add(this.ANP).add(this.SAP).add(this.FVBZ).setScale(2, DOWN);
  }

  MLSTJAHR() {
    this.UPEVP();
    this.ZVE = this.ZRE4.subtract(this.ZTABFB).subtract(this.VSP);
    this.UPMLST();
  }

  UPLSTLZZ() {
    this.JW = this.LSTJAHR.multiply(ZAHL100);
    this.UPANTEIL();
    this.LSTLZZ = this.ANTEIL1;
  }

  UPMLST() {
    if (this.ZVE.compareTo(ZAHL1) === -1) { this.ZVE = ZERO; this.X = ZERO; }
    else this.X = this.ZVE.divide(V(this.KZTAB)).setScale(0, DOWN);
    if (this.STKL < 5) this.UPTAB26();
    else this.MST5_6();
  }

  UPEVP() {
    if (this.KRV === 1) this.VSPR = ZERO;
    else {
      this.ZRE4VPR = this.ZRE4VP.compareTo(this.BBGRVALV) === 1 ? this.BBGRVALV : this.ZRE4VP;
      this.VSPR = this.ZRE4VPR.multiply(this.RVSATZAN).setScale(2, DOWN);
    }
    this.MVSPKVPV();
    if (this.ALV !== 1 && this.STKL !== 6) this.MVSPHB();
  }

  MVSPKVPV() {
    this.ZRE4VPR = this.ZRE4VP.compareTo(this.BBGKVPV) === 1 ? this.BBGKVPV : this.ZRE4VP;
    if (this.PKV > 0) {
      if (this.STKL === 6) this.VSPKVPV = ZERO;
      else {
        this.PKPVAGZJ = this.PKPVAGZ.multiply(ZAHL12).divide(ZAHL100).setScale(2, DOWN);
        this.VSPKVPV = this.PKPV.multiply(ZAHL12).divide(ZAHL100).setScale(2, DOWN);
        this.VSPKVPV = this.VSPKVPV.subtract(this.PKPVAGZJ);
        if (this.VSPKVPV.compareTo(ZERO) === -1) this.VSPKVPV = ZERO;
      }
    } else {
      this.VSPKVPV = this.ZRE4VPR.multiply(this.KVSATZAN.add(this.PVSATZAN)).setScale(2, DOWN);
    }
    this.VSP = this.VSPKVPV.add(this.VSPR).setScale(0, UP);
  }

  MVSPHB() {
    this.ZRE4VPR = this.ZRE4VP.compareTo(this.BBGRVALV) === 1 ? this.BBGRVALV : this.ZRE4VP;
    this.VSPALV = this.AVSATZAN.multiply(this.ZRE4VPR).setScale(2, DOWN);
    this.VSPHB = this.VSPALV.add(this.VSPKVPV).setScale(2, DOWN);
    if (this.VSPHB.compareTo(V(1900)) === 1) this.VSPHB = V(1900);
    this.VSPN = this.VSPR.add(this.VSPHB).setScale(0, UP);
    if (this.VSPN.compareTo(this.VSP) === 1) this.VSP = this.VSPN;
  }

  MST5_6() {
    this.ZZX = this.X;
    if (this.ZZX.compareTo(this.W2STKL5) === 1) {
      this.ZX = this.W2STKL5;
      this.UP5_6();
      if (this.ZZX.compareTo(this.W3STKL5) === 1) {
        this.ST = this.ST.add(this.W3STKL5.subtract(this.W2STKL5).multiply(V(0.42))).setScale(0, DOWN);
        this.ST = this.ST.add(this.ZZX.subtract(this.W3STKL5).multiply(V(0.45))).setScale(0, DOWN);
      } else {
        this.ST = this.ST.add(this.ZZX.subtract(this.W2STKL5).multiply(V(0.42))).setScale(0, DOWN);
      }
    } else {
      this.ZX = this.ZZX;
      this.UP5_6();
      if (this.ZZX.compareTo(this.W1STKL5) === 1) {
        this.VERGL = this.ST;
        this.ZX = this.W1STKL5;
        this.UP5_6();
        this.HOCH = this.ST.add(this.ZZX.subtract(this.W1STKL5).multiply(V(0.42))).setScale(0, DOWN);
        this.ST = this.HOCH.compareTo(this.VERGL) === -1 ? this.HOCH : this.VERGL;
      }
    }
  }

  UP5_6() {
    this.X = this.ZX.multiply(V(1.25)).setScale(0, DOWN);
    this.UPTAB26();
    this.ST1 = this.ST;
    this.X = this.ZX.multiply(V(0.75)).setScale(0, DOWN);
    this.UPTAB26();
    this.ST2 = this.ST;
    this.DIFF = this.ST1.subtract(this.ST2).multiply(ZAHL2);
    this.MIST = this.ZX.multiply(V(0.14)).setScale(0, DOWN);
    this.ST = this.MIST.compareTo(this.DIFF) === 1 ? this.MIST : this.DIFF;
  }

  MSOLZ() {
    this.SOLZFREI = this.SOLZFREI.multiply(V(this.KZTAB));
    if (this.JBMG.compareTo(this.SOLZFREI) === 1) {
      this.SOLZJ = this.JBMG.multiply(V(5.5)).divide(ZAHL100).setScale(2, DOWN);
      this.SOLZMIN = this.JBMG.subtract(this.SOLZFREI).multiply(V(11.9)).divide(ZAHL100).setScale(2, DOWN);
      if (this.SOLZMIN.compareTo(this.SOLZJ) === -1) this.SOLZJ = this.SOLZMIN;
      this.JW = this.SOLZJ.multiply(ZAHL100).setScale(0, DOWN);
      this.UPANTEIL();
      this.SOLZLZZ = this.ANTEIL1;
    } else {
      this.SOLZLZZ = ZERO;
    }
    if (this.R > 0) {
      this.JW = this.JBMG.multiply(ZAHL100);
      this.UPANTEIL();
      this.BK = this.ANTEIL1;
    } else {
      this.BK = ZERO;
    }
  }

  UPANTEIL() {
    if (this.LZZ === 1) this.ANTEIL1 = this.JW;
    else if (this.LZZ === 2) this.ANTEIL1 = this.JW.divide(ZAHL12, 0, DOWN);
    else if (this.LZZ === 3) this.ANTEIL1 = this.JW.multiply(ZAHL7).divide(ZAHL360, 0, DOWN);
    else this.ANTEIL1 = this.JW.divide(ZAHL360, 0, DOWN);
  }

  MSONST() {
    this.LZZ = 1;
    if (this.ZMVB === 0) this.ZMVB = 12;
    if (this.SONSTB.compareTo(ZERO) === 0 && this.MBV.compareTo(ZERO) === 0) {
      this.LSTSO = ZERO; this.STS = ZERO; this.SOLZS = ZERO; this.BKS = ZERO;
      return;
    }
    this.MOSONST();
    this.ZRE4J = this.JRE4.add(this.SONSTB).divide(ZAHL100).setScale(2, DOWN);
    this.ZVBEZJ = this.JVBEZ.add(this.VBS).divide(ZAHL100).setScale(2, DOWN);
    this.VBEZBSO = this.STERBE;
    this.MRE4SONST();
    this.MLSTJAHR();
    this.WVFRBM = this.ZVE.subtract(this.GFB).multiply(ZAHL100).setScale(2, DOWN);
    if (this.WVFRBM.compareTo(ZERO) === -1) this.WVFRBM = ZERO;
    this.LSTSO = this.ST.multiply(ZAHL100);
    this.STS = this.LSTSO.subtract(this.LSTOSO).multiply(V(this.f)).divide(ZAHL100, 0, DOWN).multiply(ZAHL100);
    this.STSMIN();
  }

  STSMIN() {
    if (this.STS.compareTo(ZERO) === -1) {
      if (this.MBV.compareTo(ZERO) !== 0) {
        this.LSTLZZ = this.LSTLZZ.add(this.STS);
        if (this.LSTLZZ.compareTo(ZERO) === -1) this.LSTLZZ = ZERO;
        this.SOLZLZZ = this.SOLZLZZ.add(this.STS.multiply(V(5.5).divide(ZAHL100))).setScale(0, DOWN);
        if (this.SOLZLZZ.compareTo(ZERO) === -1) this.SOLZLZZ = ZERO;
        this.BK = this.BK.add(this.STS);
        if (this.BK.compareTo(ZERO) === -1) this.BK = ZERO;
      }
      this.STS = ZERO;
      this.SOLZS = ZERO;
    } else {
      this.MSOLZSTS();
    }
    this.BKS = this.R > 0 ? this.STS : ZERO;
  }

  MSOLZSTS() {
    this.SOLZSZVE = this.ZKF.compareTo(ZERO) === 1 ? this.ZVE.subtract(this.KFB) : this.ZVE;
    if (this.SOLZSZVE.compareTo(ONE) === -1) { this.SOLZSZVE = ZERO; this.X = ZERO; }
    else this.X = this.SOLZSZVE.divide(V(this.KZTAB), 0, DOWN);
    if (this.STKL < 5) this.UPTAB26();
    else this.MST5_6();
    this.SOLZSBMG = this.ST.multiply(V(this.f)).setScale(0, DOWN);
    if (this.SOLZSBMG.compareTo(this.SOLZFREI) === 1) this.SOLZS = this.STS.multiply(V(5.5)).divide(ZAHL100, 0, DOWN);
    else this.SOLZS = ZERO;
  }

  MOSONST() {
    this.ZRE4J = this.JRE4.divide(ZAHL100).setScale(2, DOWN);
    this.ZVBEZJ = this.JVBEZ.divide(ZAHL100).setScale(2, DOWN);
    this.JLFREIB = this.JFREIB.divide(ZAHL100, 2, DOWN);
    this.JLHINZU = this.JHINZU.divide(ZAHL100, 2, DOWN);
    this.MRE4();
    this.MRE4ABZ();
    this.ZRE4VP = this.ZRE4VP.subtract(this.JRE4ENT.divide(ZAHL100));
    this.MZTABFB();
    this.VFRBS1 = this.ANP.add(this.FVB.add(this.FVBZ)).multiply(ZAHL100).setScale(2, DOWN);
    this.MLSTJAHR();
    this.WVFRBO = this.ZVE.subtract(this.GFB).multiply(ZAHL100).setScale(2, DOWN);
    if (this.WVFRBO.compareTo(ZERO) === -1) this.WVFRBO = ZERO;
    this.LSTOSO = this.ST.multiply(ZAHL100);
  }

  MRE4SONST() {
    this.MRE4();
    this.FVB = this.FVBSO;
    this.MRE4ABZ();
    this.ZRE4VP = this.ZRE4VP.add(this.MBV.divide(ZAHL100)).subtract(this.JRE4ENT.divide(ZAHL100)).subtract(this.SONSTENT.divide(ZAHL100));
    this.FVBZ = this.FVBZSO;
    this.MZTABFB();
    this.VFRBS2 = this.ANP.add(this.FVB).add(this.FVBZ).multiply(ZAHL100).subtract(this.VFRBS1);
  }

  UPTAB26() {
    const X = this.X;
    if (X.compareTo(this.GFB.add(ZAHL1)) === -1) this.ST = ZERO;
    else if (X.compareTo(V(17800)) === -1) {
      this.Y = X.subtract(this.GFB).divide(ZAHL10000, 6, DOWN);
      this.RW = this.Y.multiply(V(914.51));
      this.RW = this.RW.add(V(1400));
      this.ST = this.RW.multiply(this.Y).setScale(0, DOWN);
    } else if (X.compareTo(V(69879)) === -1) {
      this.Y = X.subtract(V(17799)).divide(ZAHL10000, 6, DOWN);
      this.RW = this.Y.multiply(V(173.1));
      this.RW = this.RW.add(V(2397));
      this.RW = this.RW.multiply(this.Y);
      this.ST = this.RW.add(V(1034.87)).setScale(0, DOWN);
    } else if (X.compareTo(V(277826)) === -1) {
      this.ST = X.multiply(V(0.42)).subtract(V(11135.63)).setScale(0, DOWN);
    } else {
      this.ST = X.multiply(V(0.45)).subtract(V(19470.38)).setScale(0, DOWN);
    }
    this.ST = this.ST.multiply(V(this.KZTAB));
  }
}

const BIG_INPUTS = ['JFREIB', 'JHINZU', 'JRE4', 'JRE4ENT', 'JVBEZ', 'KVZ', 'LZZFREIB', 'LZZHINZU', 'MBV', 'PKPV', 'PKPVAGZ', 'PVA', 'RE4', 'SONSTB', 'SONSTENT', 'STERBE', 'VBEZ', 'VBEZM', 'VBEZS', 'VBS', 'ZKF'] as const;
const INT_INPUTS = ['af', 'AJAHR', 'ALTER1', 'ALV', 'KRV', 'LZZ', 'PKV', 'PVS', 'PVZ', 'R', 'STKL', 'VJAHR', 'ZMVB'] as const;

/** Lohnsteuer, Solidaritätszuschlag und Kirchensteuer-Bemessungsgrundlage nach PAP (Beträge in Cent) */
export function lohnsteuer(year: number, input: LohnsteuerInput): LohnsteuerResult {
  if (year !== 2026) throw new Error(`Für ${year} ist der amtliche Rechenweg (PAP) nicht hinterlegt.`);
  const p = new Pap2026();
  const rec = p as unknown as Record<string, unknown>;
  const raw = input as unknown as Record<string, number | undefined>;
  for (const k of BIG_INPUTS) if (raw[k] !== undefined) rec[k] = D.of(raw[k]!);
  for (const k of INT_INPUTS) if (raw[k] !== undefined) rec[k] = Math.trunc(raw[k]!);
  if (input.f !== undefined) p.f = input.f;
  p.MAIN();
  const n = (d: D) => d.toNumber();
  return { LSTLZZ: n(p.LSTLZZ), SOLZLZZ: n(p.SOLZLZZ), BK: n(p.BK), STS: n(p.STS), SOLZS: n(p.SOLZS), BKS: n(p.BKS),
    VFRB: n(p.VFRB), VFRBS1: n(p.VFRBS1), VFRBS2: n(p.VFRBS2), WVFRB: n(p.WVFRB), WVFRBO: n(p.WVFRBO), WVFRBM: n(p.WVFRBM) };
}
