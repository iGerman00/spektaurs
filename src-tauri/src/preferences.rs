use crate::platform;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PrefsFile {
    // Flat ini style mapped to json: we store as map for flexibility but also typed fields
    #[serde(default)]
    update_check: Option<bool>,
    #[serde(default)]
    update_last: Option<i64>,
    #[serde(default)]
    general_language: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

impl Default for PrefsFile {
    fn default() -> Self {
        Self {
            update_check: Some(true),
            update_last: Some(0),
            general_language: Some(String::new()),
            extra: HashMap::new(),
        }
    }
}

pub struct Preferences {
    path: PathBuf,
    cache: Mutex<PrefsFile>,
}

static INSTANCE: OnceLock<Preferences> = OnceLock::new();

impl Preferences {
    pub fn global() -> &'static Preferences {
        INSTANCE.get_or_init(|| {
            let path = platform::config_path("spek");
            let prefs = Preferences {
                path: path.clone(),
                cache: Mutex::new(PrefsFile::default()),
            };
            prefs.load();
            prefs
        })
    }

    fn load(&self) {
        let mut cache = self.cache.lock().unwrap();
        // Try to read file: original uses wxFileConfig ini format.
        // Our Rust port stores JSON, but we also try to parse legacy ini if present.
        if let Ok(data) = fs::read_to_string(&self.path) {
            // Try json first
            if let Ok(parsed) = serde_json::from_str::<PrefsFile>(&data) {
                *cache = parsed;
                return;
            }
            // Try ini-like: parse key=value under sections
            // Format: [/update] check=1 , [/general] language=en , etc? But wxFileConfig flat uses "/update/check"
            // We'll do simple line parser
            let mut pf = PrefsFile::default();
            for line in data.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    let k = k.trim();
                    let v = v.trim();
                    match k {
                        "/update/check" | "update/check" | "check" => {
                            pf.update_check = Some(v == "1" || v.to_lowercase() == "true")
                        }
                        "/update/last" | "update/last" | "last" => {
                            pf.update_last = v.parse::<i64>().ok()
                        }
                        "/general/language" | "general/language" | "language" => {
                            pf.general_language = Some(v.trim_matches('"').to_string())
                        }
                        _ => {}
                    }
                }
            }
            // Only overwrite if we found something non-default? Keep parsed
            // Merge: if file had values, use them
            if cache.update_check.is_none() && pf.update_check.is_some() {
                cache.update_check = pf.update_check;
            }
            if pf.update_check.is_some() {
                cache.update_check = pf.update_check;
            }
            if pf.update_last.is_some() {
                cache.update_last = pf.update_last;
            }
            if pf.general_language.is_some() {
                cache.general_language = pf.general_language;
            }
        }
        // Ensure defaults
        if cache.update_check.is_none() {
            cache.update_check = Some(true);
        }
        if cache.update_last.is_none() {
            cache.update_last = Some(0);
        }
        if cache.general_language.is_none() {
            cache.general_language = Some(String::new());
        }
    }

    fn save(&self) {
        let cache = self.cache.lock().unwrap();
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // Write as JSON for our implementation, plus also keep ini compat?
        // We'll write simple ini-like format that wxFileConfig would understand, but also JSON readable.
        // Use JSON for simplicity - original expects ini, but our port controls both
        // We'll write JSON but also support reading ini so migration works.
        if let Ok(json) = serde_json::to_string_pretty(&*cache) {
            let _ = fs::write(&self.path, json);
        }
        // Also write legacy .conf fallback? Not needed
    }

    pub fn get_check_update(&self) -> bool {
        let cache = self.cache.lock().unwrap();
        cache.update_check.unwrap_or(true)
    }

    pub fn set_check_update(&self, value: bool) {
        {
            let mut cache = self.cache.lock().unwrap();
            cache.update_check = Some(value);
        }
        self.save();
    }

    pub fn get_last_update(&self) -> i64 {
        let cache = self.cache.lock().unwrap();
        cache.update_last.unwrap_or(0)
    }

    pub fn set_last_update(&self, value: i64) {
        {
            let mut cache = self.cache.lock().unwrap();
            cache.update_last = Some(value);
        }
        self.save();
    }

    pub fn get_language(&self) -> String {
        let cache = self.cache.lock().unwrap();
        cache.general_language.clone().unwrap_or_default()
    }

    pub fn set_language(&self, value: String) {
        {
            let mut cache = self.cache.lock().unwrap();
            cache.general_language = Some(value);
        }
        self.save();
    }

    pub fn get_all(&self) -> serde_json::Value {
        let cache = self.cache.lock().unwrap();
        serde_json::to_value(&*cache).unwrap_or(serde_json::Value::Null)
    }
}

// For Tauri commands convenience wrappers that don't require &self
pub fn get_check_update() -> bool {
    Preferences::global().get_check_update()
}
pub fn set_check_update(v: bool) {
    Preferences::global().set_check_update(v)
}
pub fn get_last_update() -> i64 {
    Preferences::global().get_last_update()
}
pub fn set_last_update(v: i64) {
    Preferences::global().set_last_update(v)
}
pub fn get_language() -> String {
    Preferences::global().get_language()
}
pub fn set_language(v: String) {
    Preferences::global().set_language(v)
}
