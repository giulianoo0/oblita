// Hub de rede local do Oblita: repassa bytes entre os alunos e o painel do professor.
// Não entende provas nem gabarito. O protocolo é o de server/hub.ts e shared/frames.ts.
use std::{
    collections::{BTreeMap, HashMap},
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    time::{Duration, Instant},
};

use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    serve::ListenerExt,
    Json, Router,
};
use serde_json::json;
use tokio::{
    net::TcpListener,
    sync::{mpsc, Notify},
    time::{self, timeout},
};

const HUB_PORT: u16 = 7787;
const HUB_ORIGINS: [&str; 3] = ["https://oblita.giuli.dev", "http://localhost:5173", "http://localhost:3000"];
const MAX_STUDENTS: usize = 512;
// Um notebook com sockets crus não pode ocupar todas as vagas. Vale também para o loopback.
const MAX_PER_IP: usize = 16;
// Sem o limite, um socket mudo seguraria a vaga para sempre, porque responder ping não prova nada.
const SILENT_LIMIT: Duration = Duration::from_secs(15);
// A prova vai do painel ao aluno e pode ser grande; o aluno só manda partes de ~150 KB.
const MAX_STUDENT_FRAME: usize = 8 * 1024 * 1024;
// 16 MiB de dados mais os 5 bytes do cabeçalho do hub.
const MAX_HOST_FRAME: usize = 16 * 1024 * 1024 + 5;
// Cobrado por quadro: uma enxurrada de quadros de 1 byte também gasta memória.
const FRAME_COST: usize = 256;
const STUDENT_QUEUE_BYTES: usize = 64 * 1024 * 1024;
const HOST_QUEUE_BYTES: usize = 256 * 1024 * 1024;
// Quanto da fila do painel cada IP pode ocupar: o excesso derruba o aluno, nunca o painel.
// Seriam precisos 8 notebooks abusando juntos para encher a fila.
const IP_SHARE_BYTES: usize = 32 * 1024 * 1024;
// Um notebook que some do Wi-Fi não fecha o TCP; sem ping ocuparia a vaga para sempre.
const PING_EVERY: Duration = Duration::from_secs(30);
const IDLE_LIMIT: Duration = Duration::from_secs(120);
const SEND_TIMEOUT: Duration = Duration::from_secs(60);
const CLOSE_WAIT: Duration = Duration::from_secs(2);

const OP_OPEN: u8 = 0;
const OP_CLOSE: u8 = 1;
const OP_DATA: u8 = 2;

static LOG: OnceLock<SyncSender<String>> = OnceLock::new();

macro_rules! log {
    ($($arg:tt)*) => {
        if let Some(log) = LOG.get() {
            let _ = log.try_send(format!($($arg)*));
        }
    };
}

// Thread própria: clicar na janela do cmd (QuickEdit) trava a saída, e o hub não pode travar junto.
fn init_log() {
    let (tx, rx) = sync_channel::<String>(4096);
    std::thread::spawn(move || {
        let mut out = io::stdout();
        for line in rx {
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
    });
    let _ = LOG.set(tx);
}

fn hub_frame(conn: u32, op: u8, data: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(5 + data.len());
    out.extend_from_slice(&conn.to_be_bytes());
    out.push(op);
    out.extend_from_slice(data);
    Bytes::from(out)
}

fn parse_frame(frame: &Bytes) -> Option<(u32, u8, Bytes)> {
    if frame.len() < 5 {
        return None;
    }
    let conn = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
    Some((conn, frame[4], frame.slice(5..)))
}

// Devolve os bytes ao sair da fila por qualquer caminho, inclusive quando a conexão morre com a fila cheia.
struct Charge {
    cost: usize,
    total: Arc<AtomicUsize>,
    share: Option<Arc<AtomicUsize>>,
}

impl Drop for Charge {
    fn drop(&mut self) {
        self.total.fetch_sub(self.cost, Ordering::Relaxed);
        if let Some(share) = &self.share {
            share.fetch_sub(self.cost, Ordering::Relaxed);
        }
    }
}

struct Queued {
    // None fecha a conexão depois do que já está na fila: o aviso de "refused" chega antes do fechamento.
    frame: Option<Bytes>,
    charge: Charge,
}

struct Peer {
    queue: mpsc::UnboundedSender<Queued>,
    kill: Arc<Notify>,
    queued: Arc<AtomicUsize>,
    byte_limit: usize,
}

struct Inbox {
    queue: mpsc::UnboundedReceiver<Queued>,
    kill: Arc<Notify>,
}

impl Peer {
    fn new(byte_limit: usize) -> (Peer, Inbox) {
        let (tx, rx) = mpsc::unbounded_channel();
        let kill = Arc::new(Notify::new());
        let queued = Arc::new(AtomicUsize::new(0));
        let inbox = Inbox { queue: rx, kill: kill.clone() };
        (Peer { queue: tx, kill, queued, byte_limit }, inbox)
    }

    fn has_room(&self, size: usize) -> bool {
        self.queued.load(Ordering::Relaxed) + size + FRAME_COST <= self.byte_limit
    }

    fn push(&self, frame: Option<Bytes>, share: Option<Arc<AtomicUsize>>) {
        let cost = frame.as_ref().map_or(0, |f| f.len() + FRAME_COST);
        self.queued.fetch_add(cost, Ordering::Relaxed);
        if let Some(share) = &share {
            share.fetch_add(cost, Ordering::Relaxed);
        }
        let charge = Charge { cost, total: self.queued.clone(), share };
        let _ = self.queue.send(Queued { frame, charge });
    }
}

struct Student {
    peer: Peer,
    to_host: Arc<AtomicUsize>,
}

// Fica no mapa enquanto houver bytes na fila: reconectar não pode zerar a cota.
#[derive(Default)]
struct IpSlot {
    conns: usize,
    to_host: Arc<AtomicUsize>,
}

#[derive(Default)]
struct Inner {
    // BTreeMap para reapresentar os alunos ao painel na ordem de chegada, como o Map do TypeScript.
    students: BTreeMap<u32, Student>,
    per_ip: HashMap<IpAddr, IpSlot>,
    host: Option<(u64, Peer)>,
    next_conn: u32,
    next_host: u64,
}

struct Hub {
    token: String,
    inner: Mutex<Inner>,
}

impl Hub {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    // Só os dados têm limite: abrir e fechar são pequenos e o painel precisa vê-los.
    // Passou do limite, fecha quem está mandando; o protocolo retransmite ao reconectar.
    fn send_to_host(&self, conn: u32, data: &[u8]) {
        let inner = self.lock();
        let (Some(student), Some((_, host))) = (inner.students.get(&conn), &inner.host) else { return };
        let size = data.len() + 5;
        let over_share = student.to_host.load(Ordering::Relaxed) + size + FRAME_COST > IP_SHARE_BYTES;
        if over_share || !host.has_room(size) {
            student.peer.kill.notify_one();
            return;
        }
        host.push(Some(hub_frame(conn, OP_DATA, data)), Some(student.to_host.clone()));
    }

    fn relay_from_host(&self, host_id: u64, frame: &Bytes) {
        let Some((conn, op, data)) = parse_frame(frame) else { return };
        let inner = self.lock();
        if !matches!(&inner.host, Some((id, _)) if *id == host_id) {
            return;
        }
        let Some(Student { peer, .. }) = inner.students.get(&conn) else { return };
        match op {
            OP_DATA if peer.has_room(data.len()) => peer.push(Some(data), None),
            OP_DATA => peer.kill.notify_one(),
            OP_CLOSE => peer.push(None, None),
            _ => {}
        }
    }
}

// Devolve true se a conexão caiu por fila cheia.
async fn pump(mut ws: WebSocket, mut inbox: Inbox, silent_limit: Option<Duration>, on_frame: impl Fn(Bytes)) -> bool {
    let mut ping = time::interval(PING_EVERY);
    let mut last_seen = Instant::now();
    let mut awaiting_first = silent_limit.is_some();
    let silence = time::sleep(silent_limit.unwrap_or(Duration::ZERO));
    tokio::pin!(silence);
    loop {
        tokio::select! {
            _ = inbox.kill.notified() => return true,
            () = &mut silence, if awaiting_first => return false,
            out = inbox.queue.recv() => {
                let Some(Queued { frame: Some(bytes), charge: _charge }) = out else { break };
                tokio::select! {
                    _ = inbox.kill.notified() => return true,
                    sent = timeout(SEND_TIMEOUT, ws.send(Message::Binary(bytes))) => {
                        if !matches!(sent, Ok(Ok(()))) {
                            return false;
                        }
                    }
                }
            }
            incoming = ws.recv() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    last_seen = Instant::now();
                    awaiting_first = false;
                    on_frame(bytes);
                }
                Some(Ok(_)) => last_seen = Instant::now(),
                Some(Err(_)) | None => return false,
            },
            _ = ping.tick() => {
                if last_seen.elapsed() > IDLE_LIMIT {
                    return false;
                }
                let sent = timeout(SEND_TIMEOUT, ws.send(Message::Ping(Bytes::new()))).await;
                if !matches!(sent, Ok(Ok(()))) {
                    return false;
                }
            }
        }
    }
    // No Windows, fechar com dados não lidos vira RST, e o outro lado pode perder o último quadro.
    let _ = timeout(CLOSE_WAIT, async {
        let _ = ws.send(Message::Close(None)).await;
        while let Some(Ok(_)) = ws.recv().await {}
    })
    .await;
    false
}

enum Refusal {
    Full,
    TooManyFromIp,
}

async fn student_session(hub: Arc<Hub>, mut ws: WebSocket, ip: IpAddr) {
    let ip = ip.to_canonical();
    let (peer, inbox) = Peer::new(STUDENT_QUEUE_BYTES);
    let registered = {
        let mut guard = hub.lock();
        let inner = &mut *guard;
        inner.per_ip.retain(|_, slot| slot.conns > 0 || slot.to_host.load(Ordering::Relaxed) > 0);
        let slot = inner.per_ip.entry(ip).or_default();
        if inner.students.len() >= MAX_STUDENTS {
            Err(Refusal::Full)
        } else if slot.conns >= MAX_PER_IP {
            Err(Refusal::TooManyFromIp)
        } else {
            inner.next_conn += 1;
            let conn = inner.next_conn;
            slot.conns += 1;
            inner.students.insert(conn, Student { peer, to_host: slot.to_host.clone() });
            if let Some((_, host)) = &inner.host {
                host.push(Some(hub_frame(conn, OP_OPEN, &[])), None);
            }
            Ok((conn, inner.students.len()))
        }
    };
    let (conn, total) = match registered {
        Ok(ok) => ok,
        Err(refusal) => {
            match refusal {
                Refusal::Full => log!("Limite de {MAX_STUDENTS} alunos atingido: conexão de {ip} recusada. Peça para quem saiu da prova fechar a aba."),
                Refusal::TooManyFromIp => log!("Conexão de {ip} recusada: já são {MAX_PER_IP} conexões vindas desse endereço."),
            }
            let _ = ws.send(Message::Close(None)).await;
            return;
        }
    };
    log!("Aluno conectou (conexão {conn}, {ip}). Alunos conectados: {total}.");

    let relay = hub.clone();
    let overflow = pump(ws, inbox, Some(SILENT_LIMIT), move |bytes| relay.send_to_host(conn, &bytes)).await;

    let total = {
        let mut inner = hub.lock();
        inner.students.remove(&conn);
        if let Some(slot) = inner.per_ip.get_mut(&ip) {
            slot.conns -= 1;
        }
        if let Some((_, host)) = &inner.host {
            host.push(Some(hub_frame(conn, OP_CLOSE, &[])), None);
        }
        inner.students.len()
    };
    if overflow {
        log!("A conexão {conn} ({ip}) acumulou dados demais e foi fechada; o aluno reconecta sozinho.");
    }
    log!("Aluno desconectou (conexão {conn}, {ip}). Alunos conectados: {total}.");
}

async fn host_session(hub: Arc<Hub>, ws: WebSocket) {
    let (peer, inbox) = Peer::new(HOST_QUEUE_BYTES);
    let (id, total, replaced) = {
        let mut inner = hub.lock();
        inner.next_host += 1;
        let id = inner.next_host;
        // O painel pode ter recarregado: reapresenta quem já está conectado.
        for conn in inner.students.keys() {
            peer.push(Some(hub_frame(*conn, OP_OPEN, &[])), None);
        }
        let replaced = inner.host.replace((id, peer));
        if let Some((_, old)) = &replaced {
            old.push(None, None);
        }
        (id, inner.students.len(), replaced.is_some())
    };
    if replaced {
        log!("Um novo painel assumiu no lugar do anterior.");
    }
    log!("Painel do professor conectado. Alunos conectados: {total}.");

    let relay = hub.clone();
    pump(ws, inbox, None, move |frame| relay.relay_from_host(id, &frame)).await;

    let current = {
        let mut inner = hub.lock();
        let current = matches!(&inner.host, Some((h, _)) if *h == id);
        if current {
            inner.host = None;
        }
        current
    };
    if current {
        log!("Painel do professor desconectado. Os alunos continuam conectados; abra o painel de novo quando quiser.");
    }
}

fn is_loopback(ip: IpAddr) -> bool {
    ip.to_canonical().is_loopback()
}

fn lan_addresses() -> Vec<(String, Ipv4Addr)> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else { return Vec::new() };
    interfaces
        .into_iter()
        .filter(|i| !i.is_loopback() && !i.is_link_local() && i.is_oper_up())
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) => Some((i.name, ip)),
            IpAddr::V6(_) => None,
        })
        .collect()
}

// O Chrome exige estes cabeçalhos para uma página HTTPS falar com a rede local, inclusive em erros.
async fn cors(req: Request, next: Next) -> Response {
    let origin = req.headers().get(header::ORIGIN).cloned();
    let mut res = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    let headers = res.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.unwrap_or_else(|| HeaderValue::from_static("*")));
    headers.insert(HeaderName::from_static("access-control-allow-private-network"), HeaderValue::from_static("true"));
    headers.insert(HeaderName::from_static("access-control-allow-local-network"), HeaderValue::from_static("true"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("*"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, OPTIONS"));
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    res
}

async fn ping(State(hub): State<Arc<Hub>>) -> Json<serde_json::Value> {
    let (students, host) = {
        let inner = hub.lock();
        (inner.students.len(), inner.host.is_some())
    };
    Json(json!({ "app": "oblita", "v": 1, "students": students, "host": host }))
}

// Só quem está na própria máquina do professor, numa página do Oblita, recebe o token.
async fn host_token(ConnectInfo(peer): ConnectInfo<SocketAddr>, State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !is_loopback(peer.ip()) || !HUB_ORIGINS.contains(&origin) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" }))).into_response();
    }
    let addresses: Vec<String> = lan_addresses().into_iter().map(|(_, ip)| ip.to_string()).collect();
    Json(json!({ "token": hub.token, "addresses": addresses })).into_response()
}

async fn ws_host(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    State(hub): State<Arc<Hub>>,
) -> Response {
    let token_ok = query.get("token").is_some_and(|token| *token == hub.token);
    if !token_ok || !is_loopback(peer.ip()) {
        log!("Tentativa de abrir o painel recusada ({}). O painel só funciona neste computador.", peer.ip());
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(MAX_HOST_FRAME).max_frame_size(MAX_HOST_FRAME).on_upgrade(move |socket| host_session(hub, socket))
}

async fn ws_student(ws: WebSocketUpgrade, ConnectInfo(peer): ConnectInfo<SocketAddr>, State(hub): State<Arc<Hub>>) -> Response {
    ws.max_message_size(MAX_STUDENT_FRAME)
        .max_frame_size(MAX_STUDENT_FRAME)
        .on_upgrade(move |socket| student_session(hub, socket, peer.ip()))
}

#[cfg(windows)]
fn netsh(args: &[&str]) -> bool {
    std::process::Command::new("netsh")
        .args(["advfirewall", "firewall"])
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn ensure_firewall() {
    let Ok(exe) = std::env::current_exe() else { return };
    // O caminho entra no nome: a regra vale para este .exe, e movê-lo de pasta cria outra.
    let rule = format!("name=Oblita Host - {}", exe.display());
    let program = format!("program={}", exe.display());
    // Cancelar o aviso do Windows cria regras de bloqueio com o nome do .exe, e bloqueio vence liberação.
    // Sem administrador este comando só falha, e nada muda.
    netsh(&["delete", "rule", "name=oblita-host", program.as_str()]);
    if netsh(&["show", "rule", rule.as_str()]) {
        log!("Firewall: regra deste programa já existe.");
        return;
    }
    let port = format!("localport={HUB_PORT}");
    let added = netsh(&[
        "add",
        "rule",
        rule.as_str(),
        "dir=in",
        "action=allow",
        program.as_str(),
        "enable=yes",
        "profile=private,public",
        "protocol=TCP",
        port.as_str(),
    ]);
    if added {
        log!("Firewall: programa liberado para os alunos conectarem.");
    } else {
        log!("Firewall: se o Windows perguntar, clique em Permitir e marque redes privadas e públicas.");
        log!("Se os alunos não conseguirem conectar (ou se você cancelou esse aviso), abra este programa uma vez como administrador");
        log!("(botão direito no arquivo, Executar como administrador) para ele liberar o acesso sozinho.");
    }
}

#[cfg(not(windows))]
fn ensure_firewall() {}

const LOGO: &str = r"
        _     _ _ _
   ___ | |__ | (_) |_ __ _
  / _ \| '_ \| | | __/ _` |
 | (_) | |_) | | | || (_| |
  \___/|_.__/|_|_|\__\__,_|___
";

fn explain_bind(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::AddrInUse => format!(
            "A porta {HUB_PORT} já está em uso, provavelmente porque o Oblita Host já está aberto.\n\
             Procure a outra janela e use aquela, ou feche-a e abra este programa de novo."
        ),
        io::ErrorKind::PermissionDenied => format!(
            "O Windows não deixou usar a porta {HUB_PORT} ({error}).\n\
             Reinicie o computador e tente de novo; se continuar, abra como administrador."
        ),
        _ => format!("Não foi possível abrir a porta {HUB_PORT}: {error}.\nReinicie o computador e tente de novo."),
    }
}

async fn serve(token: String) -> Result<(), String> {
    let address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, HUB_PORT));
    let listener = TcpListener::bind(address).await.map_err(explain_bind)?.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });

    log!("{LOGO}");
    log!("Oblita Host: tudo certo, o programa está rodando.");
    log!("");
    let addresses = lan_addresses();
    if addresses.is_empty() {
        log!("Nenhuma rede encontrada. Conecte este computador ao Wi-Fi ou ao cabo e abra o programa de novo.");
    } else {
        log!("Os alunos devem digitar um destes endereços (use o da rede em que eles estão):");
        for (name, ip) in &addresses {
            log!("    {ip}:{HUB_PORT}    ({name})");
        }
    }
    log!("");
    log!("Deixe esta janela aberta durante a prova. Para encerrar, feche a janela.");
    log!("");
    tokio::task::spawn_blocking(ensure_firewall);

    let hub = Arc::new(Hub { token, inner: Mutex::new(Inner::default()) });
    let app: Router = Router::new()
        .route("/ping", get(ping))
        .route("/host-token", get(host_token))
        .route("/ws/host", get(ws_host))
        .route("/ws/student", get(ws_student))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(middleware::from_fn(cors))
        .with_state(hub);
    let service = app.into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, service).await.map_err(|error| format!("O servidor parou: {error}. Abra o programa de novo."))
}

fn run() -> Result<(), String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| format!("O Windows não forneceu números aleatórios: {error}. Reinicie o computador."))?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Não foi possível iniciar: {error}. Reinicie o computador e tente de novo."))?;
    runtime.block_on(serve(token))
}

// Acentos: a std do Rust escreve no console com WriteConsoleW, então não precisa de chcp 65001.
fn main() {
    init_log();
    std::panic::set_hook(Box::new(|info| {
        log!("Erro interno: {info}. Se algo parar de funcionar, feche e abra o programa de novo.");
    }));
    let message = match std::panic::catch_unwind(run) {
        Ok(Ok(())) => "O programa parou. Abra de novo para continuar.".to_string(),
        Ok(Err(message)) => message,
        Err(_) => "O programa parou por um erro interno. Abra de novo para continuar.".to_string(),
    };
    log!("{message}");
    log!("");
    log!("Aperte Enter para fechar esta janela.");
    std::thread::sleep(Duration::from_millis(200));
    let _ = io::stdin().read_line(&mut String::new());
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_big_endian_like_dataview() {
        let frame = hub_frame(258, OP_DATA, &[9, 8]);
        assert_eq!(&frame[..], &[0u8, 0, 1, 2, 2, 9, 8][..]);
        assert_eq!(parse_frame(&frame), Some((258, OP_DATA, Bytes::from_static(&[9, 8]))));
    }

    #[test]
    fn frame_without_data_is_valid_and_short_frame_is_ignored() {
        assert_eq!(parse_frame(&hub_frame(1, OP_CLOSE, &[])), Some((1, OP_CLOSE, Bytes::new())));
        assert_eq!(parse_frame(&Bytes::from_static(&[0, 0, 0, 1])), None);
        assert_eq!(parse_frame(&Bytes::new()), None);
    }
}
