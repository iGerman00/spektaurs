import i18nData from "./i18n_data.json";

const translations: Record<string, Record<string, string>> = i18nData as any;

let currentLang = "en";

export function getCurrentLanguage(): string {
  return currentLang;
}

export function setLanguage(lang: string) {
  if (!lang) {
    currentLang = "en";
    return;
  }
  if (translations[lang]) {
    currentLang = lang;
  } else {
    const normalized = lang.replace("-", "_");
    const base = normalized.split("_")[0];
    if (translations[normalized]) {
      currentLang = normalized;
    } else if (translations[base]) {
      currentLang = base;
    } else {
      currentLang = "en";
    }
  }
}

function normalizeKey(str: string): string {
  return str
    .replace(/&/g, "")
    .replace(/…/g, "")
    .replace(/\.\.\./g, "")
    .trim()
    .toLowerCase();
}

export function t(key: string): string {
  if (!key) return "";
  const dict = translations[currentLang] || {};
  const enDict = translations["en"] || {};

  // 1. Direct match
  if (dict[key] !== undefined) return dict[key];

  // 2. Try variations (with/without ampersand, ellipsis, colon)
  const stripped = key.replace(/&/g, "").replace(/…/g, "").trim();
  if (dict[stripped] !== undefined) return dict[stripped];
  if (dict["&" + stripped] !== undefined) return dict["&" + stripped].replace(/&/g, "");
  if (dict[stripped + "…"] !== undefined) return dict[stripped + "…"];
  if (dict[stripped + ":"] !== undefined) return dict[stripped + ":"];

  // 3. Common action alias lookups
  const lower = stripped.toLowerCase();
  if (lower === "open" || lower === "open…") {
    const val = dict["Open File"] || dict["Open…"] || dict["&Open"] || dict["Open"];
    if (val) return val.replace(/&/g, "");
  }
  if (lower === "save" || lower === "save spectrogram…") {
    const val = dict["Save Spectrogram"] || dict["Save Spectrogram…"] || dict["Save…"] || dict["&Save"] || dict["Save"];
    if (val) return val.replace(/&/g, "");
  }
  if (lower === "preferences" || lower === "preferences…") {
    const val = dict["Preferences…"] || dict["Preferences"];
    if (val) return val.replace(/&/g, "");
  }

  // 4. Normalized fuzzy search in current dictionary
  const normTarget = normalizeKey(key);
  for (const [k, v] of Object.entries(dict)) {
    if (normalizeKey(k) === normTarget) {
      return v.replace(/&/g, "");
    }
  }

  // 5. Extended UI strings table for major languages
  const extra = getExtraTranslations(currentLang);
  if (extra && extra[key] !== undefined) return extra[key];
  if (extra && extra[stripped] !== undefined) return extra[stripped];

  // 6. English fallback
  if (enDict[key] !== undefined) return enDict[key];
  return key.replace(/&/g, "");
}

function getExtraTranslations(lang: string): Record<string, string> | undefined {
  const table: Record<string, Record<string, string>> = {
    ru: {
      "File": "Файл",
      "Edit": "Правка",
      "Help": "Справка",
      "Open": "Открыть",
      "Open…": "Открыть…",
      "Save": "Сохранить",
      "Save Spectrogram…": "Сохранить спектрограмму…",
      "Preferences": "Параметры",
      "Preferences…": "Параметры…",
      "Exit": "Выход",
      "About": "О программе",
      "About Spektaurs": "О программе Spektaurs",
      "About… (Shift+F1)": "О программе…",
      "General": "Общие",
      "Language:": "Язык:",
      "Check for updates": "Проверять обновления",
      "Show preview while analysing": "Показывать предпросмотр при анализе",
      "Show keyboard shortcuts bar": "Показывать строку горячих клавиш",
      "Analysis Defaults": "Параметры анализа по умолчанию",
      "Window:": "Окно:",
      "DFT size:": "Размер ДПФ:",
      "Palette:": "Палитра:",
      "Low (dB):": "Низ (дБ):",
      "High (dB):": "Верх (дБ):",
      "Export": "Экспорт",
      "Save resolution:": "Разрешение сохранения:",
      "Window size": "Размер окна",
      "Original (samples×bands)": "Оригинал (отсчёты × полосы)",
      "Analysing…": "Анализ…",
      "Decoding…": "Декодирование…",
      "Drop an audio file here or use File → Open": "Перетащите аудиофайл сюда или выберите Файл → Открыть",
      "channel %d / %d": "канал %d / %d",
      "channel": "канал",
      "stream": "поток",
      "window": "окно",
      "palette": "палитра",
      "low": "низ",
      "high": "верх",
      "reset": "сброс",
      "Middle-click": "Средняя кнопка",
      "Scroll": "Колесо",
      "Keys:": "Клавиши:",
      "Acoustic Spectrum Analyser": "Акустический анализатор спектра",
      "Developers": "Разработчики",
      "Artist": "Художник",
      "Translators": "Переводчики",
      "Close": "Закрыть",
      "OK": "ОК",
      "Mono": "Моно",
      "Stereo": "Стерео",
      "channels": "каналов",
      "%d bits": "%d бит",
      "%d bit": "%d бит",
    },
    de: {
      "File": "Datei",
      "Edit": "Bearbeiten",
      "Help": "Hilfe",
      "Open": "Öffnen",
      "Open…": "Öffnen…",
      "Save": "Speichern",
      "Save Spectrogram…": "Spektrogramm speichern…",
      "Preferences": "Einstellungen",
      "Preferences…": "Einstellungen…",
      "Exit": "Beenden",
      "About Spektaurs": "Über Spektaurs",
      "General": "Allgemein",
      "Language:": "Sprache:",
      "Check for updates": "Nach Aktualisierungen suchen",
      "Show preview while analysing": "Vorschau während der Analyse anzeigen",
      "Show keyboard shortcuts bar": "Tastenkürzel-Leiste anzeigen",
      "Analysis Defaults": "Standard-Analyseeinstellungen",
      "Window:": "Fenster:",
      "DFT size:": "DFT-Größe:",
      "Palette:": "Palette:",
      "Low (dB):": "Unten (dB):",
      "High (dB):": "Oben (dB):",
      "Export": "Exportieren",
      "Save resolution:": "Speicherauflösung:",
      "Window size": "Fenstergröße",
      "Original (samples×bands)": "Original (Abtastwerte × Bänder)",
      "Analysing…": "Analysieren…",
      "Decoding…": "Dekodieren…",
      "Drop an audio file here or use File → Open": "Audiodatei hier ablegen oder Datei → Öffnen wählen",
      "Close": "Schließen",
      "OK": "OK",
    },
    fr: {
      "File": "Fichier",
      "Edit": "Édition",
      "Help": "Aide",
      "Open": "Ouvrir",
      "Open…": "Ouvrir…",
      "Save": "Enregistrer",
      "Save Spectrogram…": "Enregistrer le spectrogramme…",
      "Preferences": "Préférences",
      "Preferences…": "Préférences…",
      "Exit": "Quitter",
      "About Spektaurs": "À propos de Spektaurs",
      "General": "Général",
      "Language:": "Langue :",
      "Check for updates": "Vérifier les mises à jour",
      "Show preview while analysing": "Afficher l'aperçu pendant l'analyse",
      "Show keyboard shortcuts bar": "Afficher la barre des raccourcis",
      "Analysis Defaults": "Paramètres d'analyse par défaut",
      "Window:": "Fenêtre :",
      "DFT size:": "Taille TFD :",
      "Palette:": "Palette :",
      "Low (dB):": "Bas (dB) :",
      "High (dB):": "Haut (dB) :",
      "Export": "Exporter",
      "Save resolution:": "Résolution d'enregistrement :",
      "Window size": "Taille de la fenêtre",
      "Original (samples×bands)": "Original (échantillons × bandes)",
      "Analysing…": "Analyse en cours…",
      "Decoding…": "Décodage en cours…",
      "Drop an audio file here or use File → Open": "Déposez un fichier audio ici ou utilisez Fichier → Ouvrir",
      "Close": "Fermer",
      "OK": "OK",
    },
    es: {
      "File": "Archivo",
      "Edit": "Editar",
      "Help": "Ayuda",
      "Open": "Abrir",
      "Open…": "Abrir…",
      "Save": "Guardar",
      "Save Spectrogram…": "Guardar espectrograma…",
      "Preferences": "Preferencias",
      "Preferences…": "Preferencias…",
      "Exit": "Salir",
      "About Spektaurs": "Acerca de Spektaurs",
      "General": "General",
      "Language:": "Idioma:",
      "Check for updates": "Buscar actualizaciones",
      "Show preview while analysing": "Mostrar vista previa durante el análisis",
      "Show keyboard shortcuts bar": "Mostrar barra de atajos de teclado",
      "Analysis Defaults": "Valores predeterminados de análisis",
      "Window:": "Ventana:",
      "DFT size:": "Tamaño DFT:",
      "Palette:": "Paleta:",
      "Low (dB):": "Bajo (dB):",
      "High (dB):": "Alto (dB):",
      "Export": "Exportar",
      "Save resolution:": "Resolución de guardado:",
      "Window size": "Tamaño de ventana",
      "Original (samples×bands)": "Original (muestras × bandas)",
      "Analysing…": "Analizando…",
      "Decoding…": "Decodificando…",
      "Drop an audio file here or use File → Open": "Arrastre un archivo de audio aquí o use Archivo → Abrir",
      "Close": "Cerrar",
      "OK": "Aceptar",
    }
  };
  return table[lang];
}

export function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });

  const hintEl = document.getElementById("hint");
  if (hintEl) {
    hintEl.innerHTML = `${t("Keys:")} <b>C</b>/Shift+<b>C</b> ${t("channel")} &nbsp; <b>S</b>/Shift+<b>S</b> ${t("stream")} &nbsp; <b>F</b>/Shift+<b>F</b> ${t("window")} &nbsp; <b>W</b>/Shift+<b>W</b> DFT &nbsp; <b>P</b>/Shift+<b>P</b> ${t("palette")} &nbsp; <b>L</b>/Shift+<b>L</b> ${t("low")} &nbsp; <b>U</b>/Shift+<b>U</b> ${t("high")} &nbsp; <b>R</b> / <b>${t("Middle-click")}</b> ${t("reset")} &nbsp; <b>${t("Scroll")}</b> ${t("low")} &nbsp; Shift+<b>${t("Scroll")}</b> ${t("high")}`;
  }
}
