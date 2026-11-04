// Escrita na pasta de gravação, pedida pelo painel. O caminho vem do navegador e é tratado como
// hostil: o painel já limpa os nomes, mas quem decide o que toca no disco é este arquivo.
//
// Só escreve, nunca lê nem lista, e nada daqui devolve conteúdo pela rede. Tudo cai dentro de uma
// pasta de sala, que é o primeiro nome do caminho. A sala ganha a marca `.oblita-sala` quando este
// programa a cria; pasta sem a marca não é tocada, e apagar só vale dentro de sala marcada.
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileError {
    InvalidPath,
    NoSpace,
    Denied,
    NotFound,
    // Escrever além do fim deixaria um buraco no vídeo: o arquivo sumiu ou é de outra pasta.
    Gap,
    NoRoot,
    Busy,
    // Passou do limite da sala: arquivo grande demais, arquivos demais ou bytes demais.
    Limit,
    Io(String),
}

// Folga para a raiz: o Windows conta o caminho inteiro, e a pasta escolhida também ocupa espaço.
const MAX_COMPONENT: usize = 120;
const MAX_TOTAL: usize = 400;
const MAX_DEPTH: usize = 12;
pub const MARKER: &str = ".oblita-sala";

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub file_bytes: u64,
    pub room_bytes: u64,
    pub room_files: u64,
    // Espaço que sempre sobra no disco: a gravação para antes de travar o computador do professor.
    pub reserve: u64,
}

impl Default for Limits {
    fn default() -> Limits {
        const GIB: u64 = 1024 * 1024 * 1024;
        Limits { file_bytes: 2 * GIB, room_bytes: 400 * GIB, room_files: 50_000, reserve: GIB }
    }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn bad_char(c: char) -> bool {
    // ":" cobre letra de unidade e fluxo alternativo do NTFS; "\" e "?" cobrem UNC e "\\?\".
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        || (c as u32) < 0x20
        || ('\u{7f}'..='\u{9f}').contains(&c)
        // Invisíveis e de direção: disfarçariam a extensão, como em "gpj.\u{202e}exe".
        || ('\u{200b}'..='\u{200f}').contains(&c)
        || ('\u{2028}'..='\u{202e}').contains(&c)
        || ('\u{2060}'..='\u{2069}').contains(&c)
        || c == '\u{feff}'
}

// "aux.h" e "nul .cpp" também são o dispositivo no Windows: vale o nome até o primeiro ponto.
fn reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_lowercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|rest| rest.chars().count() == 1 && rest.chars().all(|c| c.is_ascii_digit() || "¹²³".contains(c)))
    };
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul" | "conin$" | "conout$") || numbered("com") || numbered("lpt")
}

fn valid_component(part: &str) -> bool {
    !part.is_empty()
        && part.encode_utf16().count() <= MAX_COMPONENT
        // Começar com ponto também protege a marca da sala e os temporários deste programa.
        && !part.starts_with('.')
        && !part.starts_with(' ')
        // O Windows apaga ponto e espaço do fim, e "a." viraria o mesmo arquivo que "a".
        && !part.ends_with('.')
        && !part.ends_with(' ')
        && !part.chars().any(bad_char)
        && !reserved(part)
}

// Só "/" separa. Barra invertida, dois-pontos e ".." são recusados em vez de corrigidos.
// Precisa de ao menos sala e arquivo: nada é gravado solto na raiz.
pub fn check_path(rel: &str) -> Result<PathBuf, FileError> {
    let parts: Vec<&str> = rel.split('/').collect();
    if rel.encode_utf16().count() > MAX_TOTAL || parts.len() < 2 || parts.len() > MAX_DEPTH || !parts.iter().all(|p| valid_component(p)) {
        return Err(FileError::InvalidPath);
    }
    Ok(parts.iter().collect())
}

// O nome da pasta da sala, conferido do mesmo jeito que um componente de caminho.
pub fn check_room(name: &str) -> Result<(), FileError> {
    if valid_component(name) {
        Ok(())
    } else {
        Err(FileError::InvalidPath)
    }
}

fn classify(error: io::Error) -> FileError {
    #[cfg(windows)]
    const FULL: [i32; 2] = [39, 112];
    #[cfg(not(windows))]
    const FULL: [i32; 2] = [28, 69];
    // No Windows, arquivo aberto no Excel não deixa substituir.
    #[cfg(windows)]
    const BUSY: [i32; 2] = [32, 33];
    #[cfg(not(windows))]
    const BUSY: [i32; 0] = [];
    // ELOOP: o O_NOFOLLOW achou um link no lugar do arquivo.
    #[cfg(unix)]
    const LINK: [i32; 1] = [libc::ELOOP];
    #[cfg(not(unix))]
    const LINK: [i32; 0] = [];
    let raw = error.raw_os_error();
    match error.kind() {
        _ if raw.is_some_and(|code| FULL.contains(&code)) => FileError::NoSpace,
        _ if raw.is_some_and(|code| BUSY.contains(&code)) => FileError::Busy,
        _ if raw.is_some_and(|code| LINK.contains(&code)) => FileError::InvalidPath,
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => FileError::NoSpace,
        io::ErrorKind::NotFound => FileError::NotFound,
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => FileError::Denied,
        _ => FileError::Io(error.to_string()),
    }
}

impl From<io::Error> for FileError {
    fn from(error: io::Error) -> FileError {
        classify(error)
    }
}

impl FileError {
    pub fn code(&self) -> u8 {
        match self {
            FileError::InvalidPath => 1,
            FileError::NoSpace => 2,
            FileError::Denied => 3,
            FileError::NotFound => 4,
            FileError::Gap => 5,
            FileError::NoRoot => 6,
            FileError::Busy => 7,
            FileError::Io(_) => 8,
            FileError::Limit => 9,
        }
    }

    pub fn describe(&self) -> String {
        match self {
            FileError::InvalidPath => "caminho recusado".into(),
            FileError::NoSpace => "disco cheio".into(),
            FileError::Denied => "sem permissão para gravar na pasta".into(),
            FileError::NotFound => "arquivo não encontrado".into(),
            FileError::Gap => "o arquivo não tem o começo esperado".into(),
            FileError::NoRoot => "a pasta de gravação não existe".into(),
            FileError::Busy => "arquivo aberto em outro programa".into(),
            FileError::Limit => "limite da sala atingido".into(),
            FileError::Io(text) => text.clone(),
        }
    }
}

#[cfg(windows)]
fn is_link(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // Qualquer ponto de nova análise: link, junção, pasta montada, arquivo de nuvem.
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

// Abre sem seguir link no último nome. As pastas do meio já foram conferidas uma a uma.
fn open_options(create_new: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true);
    if create_new {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: abre o próprio link em vez do destino, e is_link recusa depois.
        options.custom_flags(0x0020_0000);
    }
    options
}

#[derive(Default)]
struct Usage {
    bytes: u64,
    files: u64,
}

pub struct Store {
    root: PathBuf,
    real_root: PathBuf,
    limits: Limits,
    rooms: HashMap<String, Usage>,
    free_space: fn(&Path) -> Option<u64>,
}

fn disk_free(path: &Path) -> Option<u64> {
    fs4::available_space(path).ok()
}

impl Store {
    // A raiz vem só do professor, pela tela deste programa; nunca da rede.
    pub fn open(root: &Path, limits: Limits) -> Result<Store, FileError> {
        let real_root = fs::canonicalize(root).map_err(|_| FileError::NoRoot)?;
        if !real_root.is_dir() {
            return Err(FileError::NoRoot);
        }
        Ok(Store { root: root.to_path_buf(), real_root, limits, rooms: HashMap::new(), free_space: disk_free })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn real_root(&self) -> Result<&Path, FileError> {
        // A pasta pode ter sido apagada ou trocada por um link no meio da prova.
        match fs::canonicalize(&self.root) {
            Ok(now) if now == self.real_root => Ok(&self.real_root),
            Ok(_) => Err(FileError::Denied),
            Err(_) => Err(FileError::NoRoot),
        }
    }

    // A sala é criada aqui, com a marca. Pasta com o mesmo nome feita por outra pessoa fica intocada.
    fn room_dir(&mut self, room: &str, create: bool) -> Result<PathBuf, FileError> {
        let dir = self.real_root()?.join(room);
        match fs::symlink_metadata(&dir) {
            Ok(meta) if is_link(&meta) || !meta.is_dir() => return Err(FileError::InvalidPath),
            Ok(_) => {
                if !fs::symlink_metadata(dir.join(MARKER)).is_ok_and(|m| m.is_file()) {
                    return Err(FileError::Denied);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !create {
                    return Err(FileError::NotFound);
                }
                fs::create_dir(&dir)?;
                File::options().write(true).create_new(true).open(dir.join(MARKER))?;
            }
            Err(error) => return Err(error.into()),
        }
        if !self.rooms.contains_key(room) {
            let usage = measure(&dir);
            self.rooms.insert(room.to_owned(), usage);
        }
        Ok(dir)
    }

    // Anda pasta por pasta sem seguir atalhos: um link dentro da raiz levaria a escrita para fora.
    fn resolve(&mut self, rel: &str, create: bool) -> Result<(String, PathBuf), FileError> {
        let rel = check_path(rel)?;
        let mut parts = rel.iter().map(|p| p.to_string_lossy().into_owned());
        let room = parts.next().ok_or(FileError::InvalidPath)?;
        let mut current = self.room_dir(&room, create)?;
        let rest: Vec<String> = parts.collect();
        for (i, part) in rest.iter().enumerate() {
            current.push(part);
            let last = i + 1 == rest.len();
            match fs::symlink_metadata(&current) {
                Ok(meta) if is_link(&meta) => return Err(FileError::InvalidPath),
                Ok(meta) if !last && !meta.is_dir() => return Err(FileError::InvalidPath),
                Ok(meta) if last && !meta.is_file() => return Err(FileError::InvalidPath),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if !last && create {
                        fs::create_dir(&current).or_else(|e| if current.is_dir() { Ok(()) } else { Err(e) })?;
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok((room, current))
    }

    // Confere pelo arquivo já aberto: se alguém trocou uma pasta por link entre a conferência e a
    // abertura, o caminho real sai da raiz ou aponta para outro arquivo, e a escrita não acontece.
    fn verify(&self, file: &File, path: &Path) -> Result<(), FileError> {
        let opened = file.metadata()?;
        if is_link(&opened) || !opened.is_file() {
            return Err(FileError::InvalidPath);
        }
        let real = fs::canonicalize(path)?;
        if !real.starts_with(&self.real_root) {
            return Err(FileError::InvalidPath);
        }
        let named = fs::metadata(&real)?;
        if !same_file(&opened, &named) {
            return Err(FileError::InvalidPath);
        }
        Ok(())
    }

    fn check_quota(&self, room: &str, grow: u64, new_file: bool) -> Result<(), FileError> {
        let usage = self.rooms.get(room).ok_or(FileError::NotFound)?;
        if usage.bytes.saturating_add(grow) > self.limits.room_bytes || (new_file && usage.files >= self.limits.room_files) {
            return Err(FileError::Limit);
        }
        if grow > 0 {
            let free = (self.free_space)(&self.real_root).unwrap_or(u64::MAX);
            if free < grow.saturating_add(self.limits.reserve) {
                return Err(FileError::NoSpace);
            }
        }
        Ok(())
    }

    fn account(&mut self, room: &str, before: u64, after: u64, new_file: bool) {
        if let Some(usage) = self.rooms.get_mut(room) {
            usage.bytes = usage.bytes.saturating_sub(before).saturating_add(after);
            if new_file {
                usage.files += 1;
            }
        }
    }

    // Escreve a partir de `offset` e corta o que houver depois: repetir o mesmo pedaço dá o mesmo arquivo.
    pub fn write_at(&mut self, rel: &str, offset: u64, data: &[u8]) -> Result<u64, FileError> {
        let (room, path) = self.resolve(rel, offset == 0)?;
        let end = offset.checked_add(data.len() as u64).ok_or(FileError::Limit)?;
        if end > self.limits.file_bytes {
            return Err(FileError::Limit);
        }
        let existing = match fs::symlink_metadata(&path) {
            Ok(meta) => Some(meta.len()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let len = existing.unwrap_or(0);
        if offset > len {
            return Err(FileError::Gap);
        }
        self.check_quota(&room, end.saturating_sub(len), existing.is_none())?;
        let mut file = open_options(existing.is_none()).open(&path)?;
        self.verify(&file, &path)?;
        let len = file.metadata()?.len();
        if offset > len {
            return Err(FileError::Gap);
        }
        if len > offset {
            file.set_len(offset)?;
        }
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(data)?;
        self.account(&room, len, end, existing.is_none());
        Ok(end)
    }

    // Grava ao lado e renomeia: quem abrir o arquivo no meio vê o antigo inteiro ou o novo inteiro.
    pub fn replace(&mut self, rel: &str, data: &[u8]) -> Result<(), FileError> {
        let (room, path) = self.resolve(rel, true)?;
        let size = data.len() as u64;
        if size > self.limits.file_bytes {
            return Err(FileError::Limit);
        }
        let before = fs::symlink_metadata(&path).ok().map(|m| m.len());
        self.check_quota(&room, size.saturating_sub(before.unwrap_or(0)), before.is_none())?;
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("arquivo");
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp = path.with_file_name(format!(".{name}.{n}.oblita-tmp"));
        let written = (|| -> Result<(), FileError> {
            let mut file = open_options(true).open(&temp)?;
            self.verify(&file, &temp)?;
            file.write_all(data)?;
            file.sync_all()?;
            drop(file);
            // O destino é conferido de novo logo antes: um link plantado ali não é substituído às cegas.
            if fs::symlink_metadata(&path).is_ok_and(|m| is_link(&m) || !m.is_file()) {
                return Err(FileError::InvalidPath);
            }
            fs::rename(&temp, &path)?;
            Ok(())
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        self.account(&room, before.unwrap_or(0), size, before.is_none());
        Ok(())
    }

    // Só dentro de sala marcada, e só arquivo. Já apagado conta como sucesso: o painel pode repetir.
    pub fn remove(&mut self, rel: &str) -> Result<(), FileError> {
        let (room, path) = match self.resolve(rel, false) {
            Err(FileError::NotFound) => return Ok(()),
            other => other?,
        };
        match fs::symlink_metadata(&path) {
            Ok(meta) if is_link(&meta) || !meta.is_file() => Err(FileError::InvalidPath),
            Ok(meta) => {
                fs::remove_file(&path)?;
                if let Some(usage) = self.rooms.get_mut(&room) {
                    usage.bytes = usage.bytes.saturating_sub(meta.len());
                    usage.files = usage.files.saturating_sub(1);
                }
                self.prune(&room, &path);
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    // Apaga as pastas que ficaram vazias, até a da sala, que fica com a marca.
    fn prune(&self, room: &str, file: &Path) {
        let stop = self.real_root.join(room);
        let mut dir = file.parent();
        while let Some(current) = dir {
            if current == stop || !current.starts_with(&stop) || fs::remove_dir(current).is_err() {
                break;
            }
            dir = current.parent();
        }
    }

    // A sala inteira, para o aviso de "Tudo salvo". Só confirma o que existe e é sala nossa.
    pub fn room_path(&mut self, room: &str) -> Result<PathBuf, FileError> {
        check_room(room)?;
        self.room_dir(room, false)?;
        // O caminho como o professor escolheu, sem o "\\?\" que o canônico ganha no Windows.
        Ok(self.root.join(room))
    }
}

#[cfg(unix)]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

// Sem o índice do arquivo na std estável do Windows: a hora de criação, em 100 ns, faz o papel.
#[cfg(windows)]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    a.creation_time() == b.creation_time() && a.file_size() == b.file_size()
}

#[cfg(not(any(unix, windows)))]
fn same_file(_: &fs::Metadata, _: &fs::Metadata) -> bool {
    true
}

// Conta o que a sala já tem, sem seguir links, para os limites valerem depois de reabrir o programa.
fn measure(dir: &Path) -> Usage {
    let mut usage = Usage::default();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.path().symlink_metadata() else { continue };
            if is_link(&meta) {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else if entry.file_name() != MARKER {
                usage.files += 1;
                usage.bytes += meta.len();
            }
        }
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);

    impl Temp {
        fn new(name: &str) -> Temp {
            let mut random = [0u8; 6];
            getrandom::fill(&mut random).unwrap();
            let tag: String = random.iter().map(|b| format!("{b:02x}")).collect();
            let dir = std::env::temp_dir().join(format!("oblita-files-{name}-{tag}"));
            fs::create_dir_all(&dir).unwrap();
            Temp(dir)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn store(dir: &Temp) -> Store {
        Store::open(&dir.0, Limits::default()).unwrap()
    }

    // Tudo o que existe na pasta de fora, para provar que um ataque não escreveu nada lá.
    fn listing(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            for entry in fs::read_dir(&current).unwrap().flatten() {
                out.push(entry.path());
                if entry.path().symlink_metadata().unwrap().is_dir() {
                    stack.push(entry.path());
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn accepts_the_export_layout() {
        for ok in [
            "Prova 2026-11-04 14h30/alunos/João Ação (999)/gravacao/0000.webm",
            "Prova/grupos/Os Ponteiros/q1/Main (2).cpp",
            "Prova/resumo.csv",
            "Prova/alunos/_CON/alertas.csv",
            "a/日本語 😀.txt",
        ] {
            assert!(check_path(ok).is_ok(), "{ok}");
        }
        assert_eq!(check_path("a/b/c.txt"), Ok(PathBuf::from("a").join("b").join("c.txt")));
    }

    #[test]
    fn refuses_paths_that_escape_or_break_windows() {
        let long_name = format!("sala/{}", "a".repeat(200));
        let deep = vec!["d"; 40].join("/");
        let long_total = vec!["x".repeat(100); 6].join("/");
        for bad in [
            "",
            "solto.txt",
            "..",
            "../fora.txt",
            "sala/../../fora.txt",
            "sala/./b",
            "/etc/passwd",
            "C:\\",
            "C:\\Windows\\x.txt",
            "C:/Windows/x.txt",
            "sala/C:x",
            "\\\\servidor\\compartilhada\\x.txt",
            "//servidor/compartilhada/x.txt",
            "\\\\?\\C:\\x.txt",
            "//?/C:/x.txt",
            "sala\\b.txt",
            "sala//b",
            "sala/",
            "sala/b.",
            "sala/b ",
            " sala/b",
            "sala/.oculto",
            "sala/.oblita-sala",
            "CON/x.txt",
            "sala/aux.txt",
            "sala/con.txt",
            "sala/Aux.h",
            "sala/nul .cpp",
            "sala/COM1",
            "sala/lpt9.log",
            "sala/com¹.txt",
            "sala/conin$",
            "sala/file.txt:stream",
            "sala/file.txt::$DATA",
            "sala/b*",
            "sala/b?",
            "sala/<b>",
            "sala/\"b\"",
            "sala/b|c",
            "sala/nul\u{0}byte",
            "sala/quebra\nlinha",
            "sala/del\u{7f}",
            "sala/gpj.\u{202e}exe",
            "sala/zero\u{200b}largura",
            "sala/bom\u{feff}",
            long_name.as_str(),
            deep.as_str(),
            long_total.as_str(),
        ] {
            assert_eq!(check_path(bad), Err(FileError::InvalidPath), "{bad:?}");
        }
    }

    #[test]
    fn attacks_write_nothing_outside_the_root() {
        let parent = Temp::new("attack");
        let root = parent.0.join("raiz");
        fs::create_dir(&root).unwrap();
        let before = listing(&parent.0);
        let mut store = Store::open(&root, Limits::default()).unwrap();
        for bad in ["../fora.txt", "sala/../../fora.txt", "/tmp/fora.txt", "C:\\fora.txt", "\\\\?\\C:\\fora.txt", "sala/aux.txt", "sala/f.txt:stream"] {
            assert_eq!(store.write_at(bad, 0, b"x"), Err(FileError::InvalidPath), "{bad}");
            assert_eq!(store.replace(bad, b"x"), Err(FileError::InvalidPath), "{bad}");
            assert_eq!(store.remove(bad), Err(FileError::InvalidPath), "{bad}");
        }
        assert_eq!(listing(&parent.0), before);
    }

    #[test]
    fn write_at_appends_and_is_idempotent() {
        let dir = Temp::new("append");
        let mut store = store(&dir);
        assert_eq!(store.write_at("sala/aluno/gravacao/0000.webm", 0, b"abc"), Ok(3));
        assert_eq!(store.write_at("sala/aluno/gravacao/0000.webm", 3, b"def"), Ok(6));
        // O mesmo pedaço de novo (o painel recarregou antes de salvar) não duplica nada.
        assert_eq!(store.write_at("sala/aluno/gravacao/0000.webm", 3, b"def"), Ok(6));
        assert_eq!(fs::read(dir.0.join("sala/aluno/gravacao/0000.webm")).unwrap(), b"abcdef");
        assert_eq!(store.write_at("sala/aluno/gravacao/0000.webm", 10, b"x"), Err(FileError::Gap));
        assert_eq!(store.write_at("sala/outro.webm", 5, b"x"), Err(FileError::Gap));
        assert!(!dir.0.join("sala/outro.webm").exists(), "buraco não pode criar arquivo");
        assert!(dir.0.join("sala").join(MARKER).is_file(), "a sala ganha a marca");
    }

    #[test]
    fn replace_is_atomic_and_leaves_no_temp_file() {
        let dir = Temp::new("replace");
        let mut store = store(&dir);
        store.replace("sala/resumo.txt", b"primeiro").unwrap();
        store.replace("sala/resumo.txt", b"segundo").unwrap();
        assert_eq!(fs::read(dir.0.join("sala/resumo.txt")).unwrap(), b"segundo");
        let mut names: Vec<_> = fs::read_dir(dir.0.join("sala")).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, vec![std::ffi::OsString::from(MARKER), std::ffi::OsString::from("resumo.txt")]);
    }

    #[test]
    fn remove_only_inside_our_rooms_and_prunes_empty_folders() {
        let dir = Temp::new("remove");
        let mut store = store(&dir);
        store.replace("sala/alunos/Ana/q1/sem-resposta.txt", b"").unwrap();
        store.replace("sala/resumo.txt", b"x").unwrap();
        store.remove("sala/alunos/Ana/q1/sem-resposta.txt").unwrap();
        // A pasta que ficou vazia some junto, mas a da sala fica, com a marca.
        assert!(!dir.0.join("sala/alunos").exists());
        assert!(dir.0.join("sala/resumo.txt").exists());
        assert_eq!(store.remove("sala/nada.txt"), Ok(()));
        assert_eq!(store.remove("nunca-existiu/nada.txt"), Ok(()));
        // Pasta do professor com o mesmo nome de uma sala: sem a marca, nada ali é tocado.
        fs::create_dir_all(dir.0.join("Minhas Coisas")).unwrap();
        fs::write(dir.0.join("Minhas Coisas/notas.txt"), b"meu").unwrap();
        assert_eq!(store.remove("Minhas Coisas/notas.txt"), Err(FileError::Denied));
        assert_eq!(store.replace("Minhas Coisas/notas.txt", b"x"), Err(FileError::Denied));
        assert_eq!(store.write_at("Minhas Coisas/novo.webm", 0, b"x"), Err(FileError::Denied));
        assert_eq!(fs::read(dir.0.join("Minhas Coisas/notas.txt")).unwrap(), b"meu");
        // Pasta não é apagada pelo nome.
        assert_eq!(store.remove("sala/alunos"), Ok(()));
        store.replace("sala/q/x.txt", b"x").unwrap();
        assert_eq!(store.remove("sala/q"), Err(FileError::InvalidPath));
    }

    #[test]
    fn missing_root_is_reported_instead_of_created() {
        let dir = Temp::new("noroot");
        assert!(matches!(Store::open(&dir.0.join("apagada"), Limits::default()), Err(FileError::NoRoot)));
        let mut store = store(&dir);
        fs::remove_dir_all(&dir.0).unwrap();
        assert_eq!(store.write_at("sala/a.webm", 0, b"x"), Err(FileError::NoRoot));
        assert!(!dir.0.exists());
    }

    #[test]
    fn limits_stop_before_the_disk_fills() {
        let dir = Temp::new("limits");
        let limits = Limits { file_bytes: 10, room_bytes: 15, room_files: 3, reserve: 0 };
        let mut store = Store::open(&dir.0, limits).unwrap();
        assert_eq!(store.write_at("sala/a.webm", 0, &[0; 11]), Err(FileError::Limit), "arquivo grande demais");
        assert_eq!(store.write_at("sala/a.webm", 0, &[0; 8]), Ok(8));
        assert_eq!(store.replace("sala/b.txt", &[0; 8]), Err(FileError::Limit), "sala cheia");
        store.replace("sala/b.txt", &[0; 2]).unwrap();
        store.replace("sala/c.txt", &[0; 1]).unwrap();
        assert_eq!(store.replace("sala/d.txt", b""), Err(FileError::Limit), "arquivos demais");
        // Regravar o mesmo arquivo não conta como arquivo novo.
        store.replace("sala/c.txt", &[0; 2]).unwrap();
        // Reabrir o programa recalcula o que a sala já tem.
        let mut again = Store::open(&dir.0, limits).unwrap();
        assert_eq!(again.replace("sala/d.txt", b""), Err(FileError::Limit));
        // Disco quase cheio: a reserva vale para qualquer sala.
        let mut full = Store::open(&dir.0, Limits { reserve: 1 << 20, ..Limits::default() }).unwrap();
        full.free_space = |_| Some(1000);
        assert_eq!(full.write_at("outra/a.webm", 0, b"x"), Err(FileError::NoSpace));
        assert!(full.replace("outra/vazio.txt", b"").is_ok(), "sem crescer, a reserva não impede");
    }

    #[cfg(unix)]
    #[test]
    fn planted_symlink_never_leads_outside() {
        let dir = Temp::new("link");
        let outside = Temp::new("outside");
        fs::write(outside.0.join("alvo.txt"), b"original").unwrap();
        let mut store = store(&dir);
        store.replace("sala/ok.txt", b"x").unwrap();
        // Sala inteira trocada por link, pasta do meio, e o próprio arquivo.
        std::os::unix::fs::symlink(&outside.0, dir.0.join("falsa")).unwrap();
        std::os::unix::fs::symlink(&outside.0, dir.0.join("sala/meio")).unwrap();
        std::os::unix::fs::symlink(outside.0.join("alvo.txt"), dir.0.join("sala/alvo.txt")).unwrap();
        let before = listing(&outside.0);
        assert_eq!(store.replace("falsa/x.txt", b"x"), Err(FileError::InvalidPath));
        assert_eq!(store.write_at("falsa/x.webm", 0, b"x"), Err(FileError::InvalidPath));
        assert_eq!(store.replace("sala/meio/x.txt", b"x"), Err(FileError::InvalidPath));
        assert_eq!(store.write_at("sala/meio/x.webm", 0, b"x"), Err(FileError::InvalidPath));
        assert_eq!(store.write_at("sala/alvo.txt", 0, b"hackeado"), Err(FileError::InvalidPath));
        assert_eq!(store.write_at("sala/alvo.txt", 8, b"hackeado"), Err(FileError::InvalidPath));
        assert_eq!(store.replace("sala/alvo.txt", b"hackeado"), Err(FileError::InvalidPath));
        assert_eq!(store.remove("sala/alvo.txt"), Err(FileError::InvalidPath));
        assert_eq!(listing(&outside.0), before);
        assert_eq!(fs::read(outside.0.join("alvo.txt")).unwrap(), b"original");
        // A raiz trocada por um link depois de escolhida também para tudo.
        let moved = dir.0.with_extension("movida");
        fs::rename(&dir.0, &moved).unwrap();
        std::os::unix::fs::symlink(&outside.0, &dir.0).unwrap();
        assert!(store.replace("sala/ok.txt", b"y").is_err());
        assert_eq!(listing(&outside.0), before);
        fs::remove_file(&dir.0).unwrap();
        fs::rename(&moved, &dir.0).unwrap();
    }
}
