import { franc } from "franc-min";
import { iso6393, iso6393To1 } from "iso-639-3";

const FALLBACK_MAP: Record<string, string> = {
  cmn: "zh",
  yue: "zh",
  arz: "ar",
  hbs: "sr",
};

export function detectLanguage(text: string): string {
  if (!text || text.trim().length === 0) {
    return "en";
  }

  const detected = franc(text, { minLength: 5 });

  if (detected === "und") {
    return "en";
  }

  const twoLetter = iso6393To1[detected];
  if (twoLetter) return twoLetter;

  return FALLBACK_MAP[detected] || "en";
}

export function getLanguageName(code: string): string {
  let lang = iso6393.find((l: any) => l.iso6391 === code);
  if (!lang) {
    lang = iso6393.find((l: any) => l.iso6393 === code);
  }
  return lang?.name || "English";
}
