// Lembra a pasta de gravação entre uma prova e outra.
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub folder: PathBuf,
}

// Fica em %APPDATA%: baixar uma versão nova do programa em outra pasta não esquece a escolha.
pub fn config_path() -> Option<PathBuf> {
    if let Some(dir) = dirs::config_dir() {
        return Some(dir.join("Oblita").join("host.json"));
    }
    Some(std::env::current_exe().ok()?.with_file_name("oblita-host.json"))
}

pub fn default_folder() -> PathBuf {
    dirs::document_dir().or_else(dirs::home_dir).unwrap_or_else(std::env::temp_dir).join("Oblita")
}

pub fn load(path: &Path, default_folder: PathBuf) -> Config {
    let folder = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("folder")?.as_str().map(PathBuf::from))
        .filter(|folder| folder.is_absolute());
    Config { folder: folder.unwrap_or(default_folder) }
}

pub fn save(path: &Path, config: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::json!({ "folder": config.folder.display().to_string() }).to_string();
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oblita-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_or_broken_file_falls_back_to_default() {
        let dir = temp("broken");
        let file = dir.join("host.json");
        assert_eq!(load(&file, PathBuf::from("/padrao")).folder, PathBuf::from("/padrao"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, b"{ isto nao e json").unwrap();
        assert_eq!(load(&file, PathBuf::from("/padrao")).folder, PathBuf::from("/padrao"));
        std::fs::write(&file, br#"{"folder": 3}"#).unwrap();
        assert_eq!(load(&file, PathBuf::from("/padrao")).folder, PathBuf::from("/padrao"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_folder_comes_back() {
        let dir = temp("roundtrip");
        let file = dir.join("sub").join("host.json");
        // Caminho absoluto de verdade também no Windows, onde "/Provas" não tem unidade.
        let config = Config { folder: std::env::temp_dir().join("Provas").join("Turma A ç") };
        save(&file, &config).unwrap();
        assert_eq!(load(&file, PathBuf::from("/padrao")), config);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
