import { invoke } from "@tauri-apps/api/core";
import { State, WindowFn, Palette } from "./types";
import { t, setLanguage, applyI18n } from "./i18n";

export function showToast(msg: string) {
  const toastEl = document.getElementById("toast");
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 3000);
}

export async function openPreferences(
  state: State,
  onSaved: () => void,
  onLiveShortcutToggle: (show: boolean) => void
) {
  const dlg = document.getElementById("prefs-dialog") as HTMLDialogElement;
  const langSelect = document.getElementById("language-select") as HTMLSelectElement;
  const checkUpdate = document.getElementById("check-update") as HTMLInputElement;
  const showPreview = document.getElementById("show-preview") as HTMLInputElement;
  const showShortcuts = document.getElementById("show-shortcuts") as HTMLInputElement;
  const prefWindow = document.getElementById("pref-window") as HTMLSelectElement;
  const prefDft = document.getElementById("pref-dft") as HTMLSelectElement;
  const prefPalette = document.getElementById("pref-palette") as HTMLSelectElement;
  const prefLow = document.getElementById("pref-low") as HTMLInputElement;
  const prefHigh = document.getElementById("pref-high") as HTMLInputElement;
  const prefSaveRes = document.getElementById("pref-save-res") as HTMLSelectElement;

  langSelect.innerHTML = "";
  const langs: [string, string][] = await invoke("get_available_languages");
  const curLang: string = await invoke("get_language");
  const checkVal: boolean = await invoke("get_check_update");
  const defaults: any = await invoke("get_default_settings");

  checkUpdate.checked = checkVal;
  if (showPreview) showPreview.checked = defaults.show_preview !== false;
  if (showShortcuts) {
    showShortcuts.checked = defaults.show_shortcuts !== false;
    showShortcuts.onchange = () => {
      onLiveShortcutToggle(showShortcuts.checked);
    };
  }

  prefWindow.value = defaults.window_function;
  prefDft.value = String(defaults.fft_bits);
  prefPalette.value = defaults.palette;
  prefLow.value = String(defaults.lrange);
  prefHigh.value = String(defaults.urange);
  prefSaveRes.value = defaults.save_resolution || "window";

  setLanguage(curLang || "en");
  applyI18n();

  langs.forEach(([code, name]) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = name || t("(system default)");
    if (code === curLang) opt.selected = true;
    langSelect.appendChild(opt);
  });
  langSelect.onchange = () => {
    setLanguage(langSelect.value || "en");
    applyI18n();
  };

  dlg.showModal();

  const handler = async () => {
    const sel = langSelect.value;
    await invoke("set_language", { value: sel });
    await invoke("set_check_update", { value: checkUpdate.checked });

    const shortcutsOn = showShortcuts ? showShortcuts.checked : true;
    await invoke("set_default_settings", {
      settings: {
        window_function: prefWindow.value,
        fft_bits: parseInt(prefDft.value),
        palette: prefPalette.value,
        lrange: parseInt(prefLow.value),
        urange: parseInt(prefHigh.value),
        show_preview: showPreview ? showPreview.checked : true,
        show_shortcuts: shortcutsOn,
        save_resolution: prefSaveRes.value,
      },
    });

    onLiveShortcutToggle(shortcutsOn);
    setLanguage(sel || "en");
    applyI18n();

    // If no file currently loaded, apply default settings directly to state
    if (!state.path) {
      state.windowFunction = prefWindow.value as WindowFn;
      state.fftBits = parseInt(prefDft.value);
      state.palette = prefPalette.value as Palette;
      state.lrange = parseInt(prefLow.value);
      state.urange = parseInt(prefHigh.value);
    }
    onSaved();

    showToast(t("Preferences") + " saved");
    dlg.removeEventListener("close", handler);
  };

  dlg.addEventListener("close", handler, { once: true });
}

export async function openAbout() {
  const dlg = document.getElementById("about-dialog") as HTMLDialogElement;
  const info: any = await invoke("get_app_info");

  const verEl = document.getElementById("about-version");
  if (verEl) verEl.textContent = info.version;

  const descEl = document.getElementById("about-desc");
  if (descEl) descEl.textContent = t(info.description) || info.description;

  const copyEl = document.getElementById("about-copyright");
  if (copyEl) copyEl.textContent = info.copyright;

  const artEl = document.getElementById("about-artist");
  if (artEl) artEl.textContent = info.artist;

  const ul = document.getElementById("about-devs");
  if (ul) {
    ul.innerHTML = "";
    info.developers.forEach((d: string) => {
      const li = document.createElement("li");
      li.textContent = d;
      ul.appendChild(li);
    });
  }

  dlg.showModal();
}
