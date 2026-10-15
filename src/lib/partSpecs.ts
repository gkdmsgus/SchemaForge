// Part limits used by the operating checks (src/lib/operatingCheck.ts). Every number was
// read from the maker's datasheet and checked a second time against the same document;
// `src` names the document and the row it came from. Change a number only together with
// its source.

export interface Num { v: number; src: string }

export interface LedSpec { part: string; vf_typ: Num; vf_max: Num; if_max: Num }
export interface DiodeSpec { vf_max: Num; if_max: Num; vrrm: Num }
export interface BjtSpec {
  ic_max: Num
  vceo: Num
  vbe_sat: Num
  /** VCE(sat) maxima, each guaranteed only at its IC and IB (so at IC/IB no larger than that ratio) */
  vce_sat: { ic: number; ib: number; v: number; src: string }[]
  /** guaranteed minimum gain at listed collector currents, measured at VCE = vce */
  hfe_min: { ic: number; hfe: number; vce: number; src: string }[]
}
export interface MosSpec {
  vgs_th_max: Num
  /** lowest gate voltage at which the datasheet guarantees RDS(on) */
  vgs_rated: Num
  rds_on: Num
  id_max: Num
  vgs_max: Num
}
export interface TimerSpec {
  vcc_min: Num; vcc_max: Num; voh_drop: Num; formula_src: string
  /** largest RA + RB that still oscillates (threshold current), at VCC 5 V and 15 V */
  rsum_max_5v: Num; rsum_max_15v: Num
}
export interface RegSpec { dropout_max: Num; vin_max: Num; cout_min?: Num }
export interface RelaySpec { r_coil: Num; r_tol: number; pickup_pct: Num; max_pct?: Num }
export interface ResSpec { p_max: Num }

const ON_2N3904 = 'onsemi 2N3903/D Rev.9, 2N3904 행'
const ON_MMBT = 'onsemi MMBT3904LT1/D Rev.15'
const ON_BC546 = 'onsemi BC546/D Rev.8, BC547 행'
const ON_NDS = 'onsemi NDS7002A/D Rev.11'
// Songle's SRD sheet (SRD-05VDC-SL-C naming) lists a 120% maximum, but only a third-party copy
// could be opened; Sanyou's official sheet is the one the KiCad footprint links to.
const SANYOU = 'Sanyou SRD-Series V3.2 데이터시트(KiCad 풋프린트가 가리키는 문서), Coil Data'
const TI_555 = 'TI NE555 데이터시트 SLFS022K'
const AMS_1117 = 'Advanced Monolithic AMS1117 데이터시트(ds1117)'
const TI_7805 = 'TI LM340/LM7805 데이터시트 SNOSBT0L'

const bjt3904 = (doc: string): BjtSpec => ({
  ic_max: { v: 0.2, src: `${doc}, MAXIMUM RATINGS: IC 연속 200 mA` },
  vceo: { v: 40, src: `${doc}, MAXIMUM RATINGS: VCEO 40 V` },
  vbe_sat: { v: 0.95, src: `${doc}: VBE(sat) 최대 0.95 V @ IC 50 mA, IB 5 mA` },
  vce_sat: [
    { ic: 0.01, ib: 0.001, v: 0.2, src: `${doc}: VCE(sat) 최대 0.2 V @ IC 10 mA, IB 1 mA` },
    { ic: 0.05, ib: 0.005, v: 0.3, src: `${doc}: VCE(sat) 최대 0.3 V @ IC 50 mA, IB 5 mA` },
  ],
  hfe_min: [
    { ic: 0.0001, hfe: 40, vce: 1, src: `${doc}: hFE 최소 40 @ IC 0.1 mA, VCE 1 V` },
    { ic: 0.001, hfe: 70, vce: 1, src: `${doc}: hFE 최소 70 @ IC 1 mA, VCE 1 V` },
    { ic: 0.01, hfe: 100, vce: 1, src: `${doc}: hFE 최소 100 @ IC 10 mA, VCE 1 V` },
    { ic: 0.05, hfe: 60, vce: 1, src: `${doc}: hFE 최소 60 @ IC 50 mA, VCE 1 V` },
    { ic: 0.1, hfe: 30, vce: 1, src: `${doc}: hFE 최소 30 @ IC 100 mA, VCE 1 V` },
  ],
})

export const SPECS = {
  led: {
    // two red LEDs the footprints stand for; the lower VF is used when the style is unknown
    red_tht: {
      part: 'Kingbright WP7113ID (5 mm 빨강)',
      vf_typ: { v: 1.9, src: 'Kingbright WP7113ID: VF 일반 1.9 V @ IF 10 mA' },
      vf_max: { v: 2.3, src: 'Kingbright WP7113ID: VF 최대 2.3 V @ IF 10 mA' },
      if_max: { v: 0.03, src: 'Kingbright WP7113ID, 절대 최대 정격: DC 순방향 전류 30 mA' },
    },
    red_smd: {
      part: 'Kingbright APT2012EC (0805 빨강)',
      vf_typ: { v: 2.0, src: 'Kingbright APT2012EC: VF 일반 2.0 V @ IF 20 mA' },
      vf_max: { v: 2.5, src: 'Kingbright APT2012EC: VF 최대 2.5 V @ IF 20 mA' },
      if_max: { v: 0.03, src: 'Kingbright APT2012EC, 절대 최대 정격: DC 순방향 전류 30 mA' },
    },
  } satisfies Record<string, LedSpec>,

  diode: {
    '1N4148': {
      vf_max: { v: 1.0, src: 'Vishay 1N4148 (81857): VF 최대 1 V @ IF 10 mA' },
      if_max: { v: 0.3, src: 'Vishay 1N4148: 순방향 연속 전류 300 mA' },
      vrrm: { v: 100, src: 'Vishay 1N4148: 반복 최대 역전압 VRRM 100 V' },
    },
  } as Record<string, DiodeSpec>,

  bjt: {
    '2N3904': bjt3904(ON_2N3904),
    MMBT3904: bjt3904(ON_MMBT),
    BC547: {
      ic_max: { v: 0.1, src: `${ON_BC546}, MAXIMUM RATINGS: IC 연속 100 mA` },
      vceo: { v: 45, src: `${ON_BC546}, MAXIMUM RATINGS: VCEO 45 V` },
      vbe_sat: { v: 0.77, src: `${ON_BC546}: VBE(sat)는 일반값만 있어 VBE(on) 최대 0.77 V @ IC 10 mA로 계산` },
      vce_sat: [
        { ic: 0.01, ib: 0.0005, v: 0.25, src: `${ON_BC546}: VCE(sat) 최대 0.25 V @ IC 10 mA, IB 0.5 mA` },
        { ic: 0.1, ib: 0.005, v: 0.6, src: `${ON_BC546}: VCE(sat) 최대 0.6 V @ IC 100 mA, IB 5 mA` },
      ],
      // measured at VCE 5 V: says nothing about a saturated switch
      hfe_min: [{ ic: 0.002, hfe: 110, vce: 5, src: `${ON_BC546}: hFE 최소 110 @ IC 2 mA, VCE 5 V (더 큰 전류의 최소값은 없음)` }],
    },
  } as Record<string, BjtSpec>,

  mos: {
    '2N7002': {
      vgs_th_max: { v: 2.5, src: `${ON_NDS}, 2N7002 행: VGS(th) 최대 2.5 V @ ID 250 µA` },
      vgs_rated: { v: 5, src: `${ON_NDS}, 2N7002 행: RDS(on) 보장 최저 게이트 전압 5 V` },
      rds_on: { v: 7.5, src: `${ON_NDS}, 2N7002 행: RDS(on) 최대 7.5 Ω @ VGS 5 V, ID 50 mA` },
      id_max: { v: 0.115, src: `${ON_NDS}, 2N7002: 드레인 연속 전류 115 mA` },
      vgs_max: { v: 20, src: `${ON_NDS}, 절대 최대 정격: 게이트-소스 전압 연속 ±20 V` },
    },
    NDS7002A: {
      vgs_th_max: { v: 2.5, src: `${ON_NDS}, NDS7002A 행: VGS(th) 최대 2.5 V @ ID 250 µA` },
      vgs_rated: { v: 5, src: `${ON_NDS}, NDS7002A 행: RDS(on) 보장 최저 게이트 전압 5 V` },
      rds_on: { v: 3, src: `${ON_NDS}, NDS7002A 행: RDS(on) 최대 3 Ω @ VGS 5 V, ID 50 mA` },
      id_max: { v: 0.28, src: `${ON_NDS}, NDS7002A: 드레인 연속 전류 280 mA` },
      vgs_max: { v: 20, src: `${ON_NDS}, 절대 최대 정격: 게이트-소스 전압 연속 ±20 V` },
    },
    '2N7000': {
      vgs_th_max: { v: 3.0, src: `${ON_NDS}, 2N7000 행: VGS(th) 최대 3 V @ ID 1 mA` },
      vgs_rated: { v: 4.5, src: `${ON_NDS}, 2N7000 행: RDS(on) 보장 최저 게이트 전압 4.5 V` },
      rds_on: { v: 5.3, src: `${ON_NDS}, 2N7000 행: RDS(on) 최대 5.3 Ω @ VGS 4.5 V, ID 75 mA` },
      id_max: { v: 0.2, src: `${ON_NDS}, 2N7000: 드레인 연속 전류 200 mA` },
      vgs_max: { v: 20, src: `${ON_NDS}, 절대 최대 정격: 게이트-소스 전압 연속 ±20 V` },
    },
  } as Record<string, MosSpec>,

  timer: {
    NE555: {
      vcc_min: { v: 4.5, src: `${TI_555}, 5.3 권장 동작 조건: VCC 4.5~16 V` },
      vcc_max: { v: 16, src: `${TI_555}, 5.3 권장 동작 조건: VCC 4.5~16 V` },
      voh_drop: { v: 1.7, src: `${TI_555}, 5.5: VOH 일반 3.3 V @ VCC 5 V, IOH −100 mA (15 V에서도 13.3 V, 둘 다 VCC − 1.7 V). 100 mA 조건이라 LED 전류 정도에서는 실제 강하가 이보다 작음` },
      formula_src: `${TI_555}, 6.3.2 비안정 동작: 식 (4) f ≈ 1.44 / ((RA + 2RB) × C), 식 (6) 출력 켜짐 비율 ≈ (RA + RB) / (RA + 2RB)`,
      rsum_max_5v: { v: 3.4e6, src: `${TI_555}, 5.5 THRES 전류 각주: RA + RB 최대 3.4 MΩ @ VCC 5 V` },
      rsum_max_15v: { v: 10e6, src: `${TI_555}, 5.5 THRES 전류 각주: RA + RB 최대 10 MΩ @ VCC 15 V` },
    },
  } as Record<string, TimerSpec>,

  reg: {
    AMS1117: {
      dropout_max: { v: 1.3, src: `${AMS_1117}: 드롭아웃(VIN − VOUT) 최대 1.3 V @ IOUT 0.8 A (일반 1.1 V, 전류가 작으면 줄어듦)` },
      vin_max: { v: 15, src: `${AMS_1117}, 절대 최대 정격: 입력 전압 15 V` },
      cout_min: { v: 22e-6, src: `${AMS_1117}, Application Hints: 출력에 22 µF 고체 탄탈 커패시터면 모든 조건에서 안정` },
    },
    // 7805 only: TI prints a typical dropout (2 V @ 1 A) but no maximum, so the guaranteed
    // "input needed to keep regulation" (7.5 V min for the 5 V part) sets the headroom
    L7805: {
      dropout_max: { v: 2.5, src: `${TI_7805}, 표 6.6: 레귤레이션 유지에 필요한 입력 최소 7.5 V (IO ≤ 1 A, TJ 25 °C) → 출력 5 V보다 2.5 V 이상. 드롭아웃은 일반 2 V @ 1 A만 있고 최대값 없음` },
      vin_max: { v: 35, src: `${TI_7805}, 6.1 절대 최대 정격: DC 입력 35 V` },
    },
  } as Record<'AMS1117' | 'L7805', RegSpec | null>,

  relay: {
    5: {
      r_coil: { v: 70, src: `${SANYOU}: 5 VDC 코일 저항 70 Ω (±10%)` },
      r_tol: 0.1,
      pickup_pct: { v: 75, src: `${SANYOU}: 동작(pick-up) 전압 최대 정격의 75%` },
      max_pct: { v: 130, src: `${SANYOU}: 최대 허용 코일 전압 정격의 130%` },
    },
    12: {
      r_coil: { v: 400, src: `${SANYOU}: 12 VDC 코일 저항 400 Ω (±10%)` },
      r_tol: 0.1,
      pickup_pct: { v: 75, src: `${SANYOU}: 동작(pick-up) 전압 최대 정격의 75%` },
      max_pct: { v: 130, src: `${SANYOU}: 최대 허용 코일 전압 정격의 130%` },
    },
  } as Record<number, RelaySpec>,

  res: {
    smd: { p_max: { v: 0.125, src: 'Yageo RC0805 부품 스펙시트(RC0805FR-071K5L): 정격 전력 0.125 W @ 70 °C' } },
    tht: { p_max: { v: 0.25, src: 'Yageo CFR-25 데이터시트: 정격 전력 0.25 W @ 70 °C (몸체 길이 6.3 mm, 지름 2.4 mm로 KiCad R_Axial_DIN0207_L6.3mm_D2.5mm 풋프린트 크기)' } },
  } satisfies Record<'smd' | 'tht', ResSpec>,
}

/** The transistor the footprint's pinout was taken from (server/pcb/footprints_table.py). */
export const assumedBjt = (style: 'smd' | 'tht' | null) => (style === 'tht' ? '2N3904' : style === 'smd' ? 'MMBT3904' : '2N3904')
export const assumedMos = (style: 'smd' | 'tht' | null) => (style === 'tht' ? '2N7000' : '2N7002')

/** Red LED data for the board style; before a PCB exists the lower VF (higher current) is used. */
export const redLed = (style: 'smd' | 'tht' | null): LedSpec =>
  style === 'smd' ? SPECS.led.red_smd : SPECS.led.red_tht
