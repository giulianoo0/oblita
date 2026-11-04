// Registro do programa. Quem registra nunca espera: a fila descarta se a janela travar.
// Thread própria: clicar na janela do cmd (QuickEdit) trava a saída, e o hub não pode travar junto.
use std::{
    collections::VecDeque,
    io::{self, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, SyncSender},
        Mutex, OnceLock,
    },
};

pub static LOG: OnceLock<SyncSender<String>> = OnceLock::new();
// Na tela de menu as linhas ficam só aqui; no modo simples também vão para o console.
static TO_STDOUT: AtomicBool = AtomicBool::new(true);
static RECENT: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
const KEEP: usize = 1000;

macro_rules! log {
    ($($arg:tt)*) => {
        if let Some(log) = $crate::log::LOG.get() {
            let _ = log.try_send(format!($($arg)*));
        }
    };
}

pub fn init(to_stdout: bool) {
    TO_STDOUT.store(to_stdout, Ordering::Relaxed);
    let (tx, rx) = sync_channel::<String>(4096);
    std::thread::spawn(move || {
        let mut out = io::stdout();
        for line in rx {
            if TO_STDOUT.load(Ordering::Relaxed) {
                let _ = writeln!(out, "{line}");
                let _ = out.flush();
            }
            let mut recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
            // O logo vem numa linha só, com quebras: a tela conta linha por linha.
            recent.extend(line.lines().map(str::to_owned));
            while recent.len() > KEEP {
                recent.pop_front();
            }
        }
    });
    let _ = LOG.set(tx);
}

pub fn recent(count: usize) -> Vec<String> {
    let recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
    recent.iter().skip(recent.len().saturating_sub(count)).cloned().collect()
}

// A tela de menu não abriu ou caiu: o que já foi registrado vai para o console, e o resto segue por lá.
pub fn switch_to_stdout() {
    if TO_STDOUT.swap(true, Ordering::Relaxed) {
        return;
    }
    let mut out = io::stdout();
    for line in recent(KEEP) {
        let _ = writeln!(out, "{line}");
    }
    let _ = out.flush();
}
