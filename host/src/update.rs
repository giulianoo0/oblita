// Atualização automática pela release `host-latest` do GitHub.
// Tudo em segundo plano e calado sem internet, que é o normal numa prova. Nunca reinicia o programa
// aberto: a versão nova vale na próxima vez que ele abrir.
//
// - O CI grava o commit no programa (OBLITA_BUILD) e publica `oblita-host.version` com o mesmo commit.
//   Sem essa variável (build local) a versão é "dev" e nada é atualizado.
// - Ao abrir e depois a cada hora: baixa o `.version`; se for outro commit, baixa o .exe ao lado do
//   atual e confere que é um .exe daquele commit.
// - Sem aluno nem painel conectado, troca o arquivo na hora: o .exe em uso vira `.old.exe` (o Windows
//   deixa renomear um .exe aberto) e o novo toma o lugar. Com prova em andamento ele fica guardado
//   como `.new.exe` e é trocado quando a sala esvaziar, ou na próxima abertura, antes de abrir as portas.
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};

use crate::app::App;

pub const BUILD: Option<&str> = option_env!("OBLITA_BUILD");
const BASE_URL: &str = "https://github.com/giulianoo0/oblita/releases/download/host-latest";
const EXE_ASSET: &str = "oblita-host.exe";
const VERSION_ASSET: &str = "oblita-host.version";

const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
const IDLE_POLL: Duration = Duration::from_secs(60);
// Sem internet a conexão falha logo; numa rede que engole pacotes, desiste em poucos segundos.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const EXE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
// O programa tem o site dentro: bem mais que isto. Menos que isto é página de erro ou download cortado.
const MIN_EXE: u64 = 512 * 1024;
const MAX_EXE: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    // Build local, sem commit: nunca atualiza.
    Dev,
    // --no-update, --porta, CI ou fora do Windows.
    Off,
    Current,
    // Abriu agora numa versão que acabou de ser trocada.
    Updated,
    // Versão nova no disco, vale ao reabrir.
    Ready(String),
}

static STATE: Mutex<State> = Mutex::new(State::Current);

fn set_state(state: State) {
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = state;
}

pub fn state() -> State {
    STATE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn short(version: &str) -> &str {
    version.get(..7).unwrap_or(version)
}

// black_box: o commit inteiro tem que estar no .exe, porque é por ele que validate_exe reconhece
// um download desta versão. Sem isto o LTO guardaria só os 7 caracteres mostrados na tela.
pub fn version_label() -> String {
    match std::hint::black_box(BUILD) {
        Some(build) => short(build).to_string(),
        None => "dev".to_string(),
    }
}

// ---- lógica pura

// O `.version` tem só o commit. Qualquer outra coisa (página de erro, proxy da escola) é ignorada.
pub fn parse_version(text: &str) -> Option<String> {
    let text = text.trim();
    let ok = (7..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit());
    ok.then(|| text.to_ascii_lowercase())
}

// `known` é a versão já baixada e à espera de reabrir: não baixa de novo.
pub fn needs_update(own: Option<&str>, remote: &str, known: Option<&str>) -> bool {
    match own {
        None => false,
        Some(own) => !own.eq_ignore_ascii_case(remote) && known.is_none_or(|k| !k.eq_ignore_ascii_case(remote)),
    }
}

// O .exe baixado tem que ser um .exe do Windows e trazer dentro o commit do `.version`: assim um
// download cortado, uma página de erro ou um .exe antigo publicado no meio da troca não passam.
pub fn validate_exe(bytes: &[u8], expected: &str) -> Result<(), &'static str> {
    if (bytes.len() as u64) < MIN_EXE {
        return Err("arquivo pequeno demais");
    }
    if !bytes.starts_with(b"MZ") {
        return Err("não é um programa do Windows");
    }
    let needle = expected.as_bytes();
    if needle.is_empty() || !bytes.windows(needle.len()).any(|w| w == needle) {
        return Err("não é a versão anunciada");
    }
    Ok(())
}

// Trocar o arquivo nunca mexe no programa aberto, mas só com a sala vazia: nada de disco nem de
// surpresa durante a prova.
pub fn may_apply(students: usize, panel: bool, files_open: usize) -> bool {
    students == 0 && !panel && files_open == 0
}

pub enum Disabled {
    Dev,
    Off,
}

pub fn enabled_for(windows: bool, build: Option<&str>, args: &[String], env_off: bool) -> Result<(), Disabled> {
    if build.is_none() {
        return Err(Disabled::Dev);
    }
    // --porta é teste com outro programa aberto; o CI testa o .exe que vai publicar e não pode trocá-lo.
    let off_flag = args.iter().skip(1).any(|a| a == "--no-update" || a == "--porta");
    if !windows || off_flag || env_off {
        return Err(Disabled::Off);
    }
    Ok(())
}

fn enabled(args: &[String]) -> Result<(), Disabled> {
    let env_off = std::env::var_os("OBLITA_NO_UPDATE").is_some() || std::env::var_os("CI").is_some();
    enabled_for(cfg!(windows), BUILD, args, env_off)
}

pub struct Paths {
    pub exe: PathBuf,
    pub old: PathBuf,
    pub new: PathBuf,
    pub new_version: PathBuf,
    pub download: PathBuf,
}

impl Paths {
    pub fn for_exe(exe: &Path) -> Paths {
        let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("oblita-host").to_string();
        let near = |suffix: &str| exe.with_file_name(format!("{stem}{suffix}"));
        Paths {
            exe: exe.to_path_buf(),
            old: near(".old.exe"),
            new: near(".new.exe"),
            new_version: near(".new.version"),
            download: near(".download.tmp"),
        }
    }

    // A versão guardada só vale com o .exe ao lado e sendo outra que a deste programa.
    fn staged(&self, own: &str) -> Option<String> {
        let version = parse_version(&fs::read_to_string(&self.new_version).ok()?)?;
        (self.new.is_file() && !version.eq_ignore_ascii_case(own)).then_some(version)
    }

    fn drop_staged(&self) {
        let _ = fs::remove_file(&self.new);
        let _ = fs::remove_file(&self.new_version);
    }
}

// O .exe em uso vira `.old.exe` e o novo toma o lugar. Se a segunda parte falhar, desfaz a primeira.
pub fn swap(paths: &Paths) -> io::Result<()> {
    let _ = fs::remove_file(&paths.old);
    fs::rename(&paths.exe, &paths.old)?;
    if let Err(error) = fs::rename(&paths.new, &paths.exe) {
        let _ = fs::rename(&paths.old, &paths.exe);
        return Err(error);
    }
    let _ = fs::remove_file(&paths.new_version);
    Ok(())
}

// ---- ao abrir, antes de tudo

// Uma versão ficou guardada porque havia prova quando ela chegou. Agora nada está aberto (nem as
// portas): troca o arquivo e roda o novo no lugar deste, que só espera ele terminar. Devolve o
// código de saída do novo, ou None para seguir com este.
pub fn relaunch_if_staged(args: &[String]) -> Option<i32> {
    enabled(args).ok()?;
    let own = BUILD?;
    let paths = Paths::for_exe(&std::env::current_exe().ok()?);
    let version = paths.staged(own)?;
    let valid = fs::read(&paths.new).ok().is_some_and(|bytes| validate_exe(&bytes, &version).is_ok());
    if !valid {
        paths.drop_staged();
        return None;
    }
    swap(&paths).ok()?;
    let status = std::process::Command::new(&paths.exe).args(args.iter().skip(1)).status().ok()?;
    Some(status.code().unwrap_or(1))
}

// ---- em segundo plano

pub fn start(app: Arc<App>, args: &[String]) {
    match enabled(args) {
        Err(Disabled::Dev) => {
            set_state(State::Dev);
            return;
        }
        Err(Disabled::Off) => {
            set_state(State::Off);
            return;
        }
        Ok(()) => {}
    }
    let Some(own) = BUILD else { return };
    let Ok(exe) = std::env::current_exe() else { return };
    let paths = Paths::for_exe(&exe);
    let _ = std::thread::Builder::new().name("update".into()).spawn(move || background(app, own, paths));
}

fn background(app: Arc<App>, own: &'static str, paths: Paths) {
    // Sobrou da troca anterior: se existe, este programa acabou de ser atualizado. Com o programa
    // antigo ainda esperando o novo (troca ao abrir), o Windows não deixa apagar; fica para a próxima.
    if paths.old.exists() {
        set_state(State::Updated);
        log!("Programa atualizado para a versão {}.", short(own));
        let _ = fs::remove_file(&paths.old);
    }
    let _ = fs::remove_file(&paths.download);
    let mut staged = paths.staged(own);
    if staged.is_none() {
        paths.drop_staged();
    }
    let mut ready: Option<String> = None;
    let mut last_check: Option<Instant> = None;
    loop {
        if let Some(version) = staged.clone() {
            let idle = may_apply(app.students.load(Ordering::Relaxed), app.panel.load(Ordering::Relaxed), app.files_open.load(Ordering::Relaxed));
            if ready.is_some() {
                // Já houve uma troca nesta sessão: o `.old.exe` é este programa, que o Windows não
                // deixa sobrescrever. A mais nova fica guardada e entra na próxima abertura.
                staged = None;
            } else if idle {
                match swap(&paths) {
                    Ok(()) => {
                        log!("Nova versão {} instalada: vale na próxima vez que o programa abrir.", short(&version));
                        ready = Some(version.clone());
                        set_state(State::Ready(version));
                    }
                    // Pasta só de leitura, antivírus segurando o arquivo: tenta na próxima abertura.
                    Err(error) => log!("A versão nova {} não pôde ser instalada ({error}); tenta de novo ao reabrir.", short(&version)),
                }
                staged = None;
            }
        }
        if last_check.is_none_or(|at| at.elapsed() >= CHECK_EVERY) {
            last_check = Some(Instant::now());
            let known = ready.as_deref().or(staged.as_deref());
            if let Some(version) = check(own, known, &paths) {
                if ready.is_none() {
                    log!("Nova versão {} baixada. Nada muda durante a prova: ela vale quando o programa abrir de novo.", short(&version));
                }
                set_state(State::Ready(version.clone()));
                staged = Some(version);
            }
        }
        std::thread::sleep(IDLE_POLL);
    }
}

// Devolve a versão que ficou guardada em `.new.exe`. Sem internet, devolve None sem dizer nada.
fn check(own: &str, known: Option<&str>, paths: &Paths) -> Option<String> {
    let remote = fetch_version().ok()?;
    if !needs_update(Some(own), &remote, known) {
        return None;
    }
    if let Err(error) = download(&remote, paths) {
        let _ = fs::remove_file(&paths.download);
        if let DownloadError::Invalid(why) = error {
            log!("Atualização {} recusada: {why}.", short(&remote));
        }
        return None;
    }
    Some(remote)
}

fn agent(total: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_global(Some(total))
        .https_only(true)
        .build()
        .into()
}

fn fetch_version() -> Result<String, ureq::Error> {
    let mut response = agent(VERSION_TIMEOUT).get(format!("{BASE_URL}/{VERSION_ASSET}")).call()?;
    let text = response.body_mut().with_config().limit(1024).read_to_string()?;
    parse_version(&text).ok_or(ureq::Error::Other("versão ilegível".into()))
}

enum DownloadError {
    Network,
    Invalid(&'static str),
}

fn download(version: &str, paths: &Paths) -> Result<(), DownloadError> {
    let response = agent(EXE_TIMEOUT).get(format!("{BASE_URL}/{EXE_ASSET}")).call().map_err(|_| DownloadError::Network)?;
    let mut reader = response.into_body().into_reader().take(MAX_EXE + 1);
    let mut file = fs::File::create(&paths.download).map_err(|_| DownloadError::Network)?;
    io::copy(&mut reader, &mut file).map_err(|_| DownloadError::Network)?;
    file.flush().and_then(|()| file.sync_all()).map_err(|_| DownloadError::Network)?;
    drop(file);
    let bytes = fs::read(&paths.download).map_err(|_| DownloadError::Network)?;
    if bytes.len() as u64 > MAX_EXE {
        return Err(DownloadError::Invalid("arquivo grande demais"));
    }
    validate_exe(&bytes, version).map_err(DownloadError::Invalid)?;
    drop(bytes);
    // Primeiro o .exe, depois a versão: sem a versão, o .exe guardado é descartado ao abrir.
    fs::rename(&paths.download, &paths.new).map_err(|_| DownloadError::Network)?;
    let temp = paths.new_version.with_extension("version.tmp");
    fs::write(&temp, version).and_then(|()| fs::rename(&temp, &paths.new_version)).map_err(|_| DownloadError::Network)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "8ca47bf0123456789abcdef0123456789abcdef0";

    fn exe_with(sha: &str, size: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; size];
        bytes[..2].copy_from_slice(b"MZ");
        let at = size / 2;
        bytes[at..at + sha.len()].copy_from_slice(sha.as_bytes());
        bytes
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oblita-update-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn version_file_is_only_a_commit() {
        assert_eq!(parse_version(" 8CA47BF\r\n").as_deref(), Some("8ca47bf"));
        assert_eq!(parse_version(SHA).as_deref(), Some(SHA));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("<!DOCTYPE html>"), None);
        assert_eq!(parse_version("Not Found"), None);
    }

    #[test]
    fn updates_only_to_another_commit_and_never_in_dev() {
        assert!(needs_update(Some(SHA), "1111111111", None));
        assert!(!needs_update(Some(SHA), SHA, None));
        assert!(!needs_update(Some(SHA), &SHA.to_uppercase(), None));
        assert!(!needs_update(None, "1111111111", None));
        // Já baixada e à espera de reabrir: não baixa de novo, mas uma mais nova ainda vale.
        assert!(!needs_update(Some(SHA), "1111111111", Some("1111111111")));
        assert!(needs_update(Some(SHA), "2222222222", Some("1111111111")));
    }

    #[test]
    fn download_must_be_a_windows_exe_of_the_announced_commit() {
        assert_eq!(validate_exe(&exe_with(SHA, 1024 * 1024), SHA), Ok(()));
        assert!(validate_exe(&exe_with(SHA, 1000), SHA).is_err());
        let mut not_exe = exe_with(SHA, 1024 * 1024);
        not_exe[0] = b'<';
        assert!(validate_exe(&not_exe, SHA).is_err());
        assert!(validate_exe(&exe_with("0000000000000000000000000000000000000000", 1024 * 1024), SHA).is_err());
        assert!(validate_exe(&exe_with(SHA, 1024 * 1024), "").is_err());
    }

    #[test]
    fn applies_only_with_the_room_empty() {
        assert!(may_apply(0, false, 0));
        assert!(!may_apply(1, false, 0));
        assert!(!may_apply(0, true, 0));
        assert!(!may_apply(0, false, 1));
    }

    #[test]
    fn dev_build_flags_and_ci_turn_it_off() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(enabled_for(true, Some(SHA), &args(&["oblita-host"]), false).is_ok());
        assert!(matches!(enabled_for(true, None, &args(&["oblita-host"]), false), Err(Disabled::Dev)));
        assert!(matches!(enabled_for(true, Some(SHA), &args(&["oblita-host", "--no-update"]), false), Err(Disabled::Off)));
        assert!(matches!(enabled_for(true, Some(SHA), &args(&["oblita-host", "--porta", "17791"]), false), Err(Disabled::Off)));
        assert!(matches!(enabled_for(true, Some(SHA), &args(&["oblita-host"]), true), Err(Disabled::Off)));
        assert!(matches!(enabled_for(false, Some(SHA), &args(&["oblita-host"]), false), Err(Disabled::Off)));
    }

    #[test]
    fn swap_puts_the_new_file_in_place_and_keeps_the_old_one_aside() {
        let dir = temp_dir("swap");
        let paths = Paths::for_exe(&dir.join("oblita-host.exe"));
        assert_eq!(paths.old, dir.join("oblita-host.old.exe"));
        assert_eq!(paths.new, dir.join("oblita-host.new.exe"));
        fs::write(&paths.exe, b"velho").unwrap();
        fs::write(&paths.new, b"novo").unwrap();
        fs::write(&paths.new_version, SHA).unwrap();
        assert_eq!(paths.staged("1111111").as_deref(), Some(SHA));
        // A versão guardada igual à própria não conta.
        assert_eq!(paths.staged(SHA), None);
        swap(&paths).unwrap();
        assert_eq!(fs::read(&paths.exe).unwrap(), b"novo");
        assert_eq!(fs::read(&paths.old).unwrap(), b"velho");
        assert!(!paths.new.exists() && !paths.new_version.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_swap_restores_the_running_file() {
        let dir = temp_dir("rollback");
        let paths = Paths::for_exe(&dir.join("oblita-host.exe"));
        fs::write(&paths.exe, b"velho").unwrap();
        // Sem o .new.exe a segunda troca falha.
        assert!(swap(&paths).is_err());
        assert_eq!(fs::read(&paths.exe).unwrap(), b"velho");
        assert!(!paths.old.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
