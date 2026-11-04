// O que a tela e o canal de arquivos compartilham. A tela só lê números e textos curtos daqui,
// e nunca segura a trava do hub: travar a janela não pode travar a prova.
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use tokio::sync::watch;

use crate::{
    config::{self, Config},
    files::{FileError, Limits, Store},
    files_ws::{self, Outcome, Request},
};

// Uma falha por tipo a cada tanto: um disco cheio falharia a cada pedaço de vídeo.
const ERROR_LOG_EVERY: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct Status {
    pub saved: Option<String>,
    pub error: Option<(Instant, String)>,
    last_logged: Option<(Instant, u8)>,
}

pub struct App {
    pub folder: watch::Sender<PathBuf>,
    config_file: Option<PathBuf>,
    // Com --pasta a escolha vale só desta vez e não é salva.
    persist: bool,
    pub students: AtomicUsize,
    pub panel: AtomicBool,
    pub files_open: AtomicUsize,
    status: Mutex<Status>,
    store: Mutex<Option<Store>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl App {
    pub fn new(folder: PathBuf, config_file: Option<PathBuf>, persist: bool) -> App {
        let (folder, _) = watch::channel(folder);
        App {
            folder,
            config_file,
            persist,
            students: AtomicUsize::new(0),
            panel: AtomicBool::new(false),
            files_open: AtomicUsize::new(0),
            status: Mutex::new(Status::default()),
            store: Mutex::new(None),
        }
    }

    pub fn folder(&self) -> PathBuf {
        self.folder.borrow().clone()
    }

    pub fn status(&self) -> MutexGuard<'_, Status> {
        lock(&self.status)
    }

    // A raiz só muda por aqui, pela tela do professor. O painel nunca escolhe onde gravar.
    pub fn set_folder(&self, folder: PathBuf) -> Result<(), String> {
        if !folder.is_absolute() {
            return Err("use o caminho completo, como C:\\Provas".into());
        }
        std::fs::create_dir_all(&folder).map_err(|error| format!("não foi possível criar a pasta: {error}"))?;
        if !folder.is_dir() {
            return Err("isso não é uma pasta".into());
        }
        if self.persist {
            if let Some(file) = &self.config_file {
                if let Err(error) = config::save(file, &Config { folder: folder.clone() }) {
                    log!("Não foi possível lembrar a pasta para a próxima vez: {error}.");
                }
            }
        }
        let connected = self.files_open.load(Ordering::Relaxed) > 0;
        self.folder.send_replace(folder.clone());
        self.status().saved = None;
        log!("Pasta de gravação: {}", folder.display());
        if connected {
            log!("O que já foi gravado continua na pasta anterior; o resto vai para a nova.");
        }
        Ok(())
    }

    // Bloqueia no disco: roda fora do executor. A raiz é lida aqui, a cada pedido.
    pub fn file_op(&self, req: &Request) -> Outcome {
        let root = self.folder();
        let mut store = lock(&self.store);
        if store.as_ref().map(|s| s.root()) != Some(root.as_path()) {
            *store = Store::open(&root, Limits::default()).ok();
        }
        let outcome = files_ws::handle(store.as_mut(), &root, req);
        match &outcome {
            Outcome::Failed(error) => self.note_error(req, error),
            Outcome::Saved(path) => {
                let mut status = self.status();
                if status.saved.as_deref() != Some(path.as_str()) {
                    log!("Tudo salvo em {path}");
                }
                status.saved = Some(path.clone());
            }
            Outcome::Ok(_) => {}
        }
        outcome
    }

    fn note_error(&self, req: &Request, error: &FileError) {
        let text = format!("Falha ao gravar {}: {}", req.path, error.describe());
        let mut status = self.status();
        let repeat = status.last_logged.is_some_and(|(at, code)| code == error.code() && at.elapsed() < ERROR_LOG_EVERY);
        if !repeat {
            log!("{text}. O painel guarda no navegador enquanto isso.");
            status.last_logged = Some((Instant::now(), error.code()));
        }
        status.error = Some((Instant::now(), text));
    }
}
