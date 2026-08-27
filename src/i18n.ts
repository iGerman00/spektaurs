import i18nData from "./i18n_data.json";

const translations: Record<string, Record<string, string>> = i18nData;

let currentLang = "en";

export function getCurrentLanguage(): string {
  return currentLang;
}

export function setLanguage(lang: string) {
  currentLang = lang && translations[lang] ? lang : (lang.startsWith("en") ? "en" : lang);
}

export function t(key: string): string {
  const dict = translations[currentLang] || translations["en"] || {};
  return dict[key] || (translations["en"] && translations["en"][key]) || key;
}

export function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });
}
