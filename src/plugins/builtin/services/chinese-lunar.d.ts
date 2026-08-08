declare module 'chinese-lunar' {
  interface LunarDate {
    year: number;
    month: number;
    day: number;
    leap: boolean;
  }
  export function solarToLunar(date: Date): LunarDate;
}
