// Hub de rede local do Oblita: repassa bytes entre os alunos e o painel do professor.
// Não entende provas nem gabarito. O protocolo é o de server/hub.ts e shared/frames.ts.
#[macro_use]
mod log;
mod app;
mod config;
mod files;
mod files_ws;
mod tui;

use std::{
    collections::{BTreeMap, HashMap},
    convert::Infallible,
    fs,
    io::{self, IsTerminal},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use app::App;

use axum::{
    body::{Body, Bytes},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    serve::ListenerExt,
    Json, Router,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use rust_embed::Embed;
use serde_json::json;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, Notify},
    time::{self, timeout},
};
use tokio_rustls::{
    rustls::{
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
        ServerConfig,
    },
    TlsAcceptor,
};
use tower::ServiceExt;

const HUB_PORT: u16 = 7787;
// Outra porta só com --porta, para testar com outro hub já aberto na 7787.
static PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(HUB_PORT);

pub fn port() -> u16 {
    PORT.load(Ordering::Relaxed)
}
pub const FRONT_PORT: u16 = 3067;
// Fica falso se a porta do site não abriu: aí nenhuma tela anuncia esse endereço.
static FRONT_UP: AtomicBool = AtomicBool::new(false);

pub fn front_up() -> bool {
    FRONT_UP.load(Ordering::Relaxed)
}
const HUB_ORIGINS: [&str; 7] = [
    "https://oblita.giuli.dev",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:3067",
    "http://127.0.0.1:3067",
    "https://localhost:3067",
    "https://127.0.0.1:3067",
];
const FRONT_HOSTS: [&str; 2] = ["localhost:3067", "127.0.0.1:3067"];
// O primeiro byte de um aperto de mão TLS. Assim a mesma porta atende http e https.
const TLS_HANDSHAKE: u8 = 0x16;
const FIRST_BYTE_LIMIT: Duration = Duration::from_secs(15);
const MAX_STUDENTS: usize = 512;
// Uma sala inteira pode estar atrás de um mesmo NAT (até ~100 alunos), e todos contam como um IP
// só: por isso o teto por IP tem de caber a sala, não 16. Continua abaixo do limite global de 512,
// e a memória que um IP ocupa na fila do painel já é limitada à parte por IP_SHARE_BYTES.
const MAX_PER_IP: usize = 128;
// Sem o limite, um socket mudo seguraria a vaga para sempre, porque responder ping não prova nada.
const SILENT_LIMIT: Duration = Duration::from_secs(15);
// A prova vai do painel ao aluno e pode ser grande; o aluno só manda partes de ~150 KB.
const MAX_STUDENT_FRAME: usize = 8 * 1024 * 1024;
// 16 MiB de dados mais os 5 bytes do cabeçalho do hub.
const MAX_HOST_FRAME: usize = 16 * 1024 * 1024 + 5;
// Um pedido de arquivo: a prova em JSON é o maior texto, e pode passar de 12 MB.
const MAX_FILE_FRAME: usize = 32 * 1024 * 1024;
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
    app: Arc<App>,
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
            hub.app.students.store(inner.students.len(), Ordering::Relaxed);
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
        hub.app.students.store(inner.students.len(), Ordering::Relaxed);
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
    hub.app.panel.store(true, Ordering::Relaxed);
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
            hub.app.panel.store(false, Ordering::Relaxed);
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

pub fn lan_addresses() -> Vec<(String, Ipv4Addr)> {
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

// Na porta do site o pedido é da mesma origem, e o navegador nem manda Origin. Sec-Fetch-Site só ele
// define, e o Host barra um domínio qualquer que alguém tenha apontado para 127.0.0.1.
fn from_own_page(headers: &HeaderMap) -> bool {
    let same_origin = headers.get("sec-fetch-site").is_some_and(|v| v == "same-origin");
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    same_origin && FRONT_HOSTS.contains(&host)
}

// Só quem está na própria máquina do professor, numa página do Oblita, recebe o token.
async fn host_token(ConnectInfo(peer): ConnectInfo<SocketAddr>, State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !is_loopback(peer.ip()) || !(HUB_ORIGINS.contains(&origin) || from_own_page(&headers)) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" }))).into_response();
    }
    let addresses: Vec<String> = lan_addresses().into_iter().map(|(_, ip)| ip.to_string()).collect();
    let site: Vec<String> = if front_up() { addresses.iter().map(|ip| format!("https://{ip}:{FRONT_PORT}")).collect() } else { Vec::new() };
    Json(json!({ "token": hub.token, "addresses": addresses, "site": site })).into_response()
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

// Mesma porta de entrada do painel, mais a origem: só a página do Oblita nesta máquina grava em disco.
async fn ws_files(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
) -> Response {
    let token_ok = query.get("token").is_some_and(|token| *token == hub.token);
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !token_ok || !is_loopback(peer.ip()) || !HUB_ORIGINS.contains(&origin) {
        log!("Pedido de gravação recusado ({}). Só o painel neste computador grava na pasta.", peer.ip());
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(MAX_FILE_FRAME).max_frame_size(MAX_FILE_FRAME).on_upgrade(move |socket| files_session(hub, socket))
}

async fn send_within(ws: &mut WebSocket, frame: Bytes) -> bool {
    matches!(timeout(SEND_TIMEOUT, ws.send(Message::Binary(frame))).await, Ok(Ok(())))
}

async fn files_session(hub: Arc<Hub>, mut ws: WebSocket) {
    let app = hub.app.clone();
    app.files_open.fetch_add(1, Ordering::Relaxed);
    let mut folder = app.folder.subscribe();
    let info = |root: PathBuf| files_ws::encode_response(0, 0, &files_ws::info_json(&root));
    let mut alive = send_within(&mut ws, info(app.folder())).await;
    while alive {
        tokio::select! {
            changed = folder.changed() => {
                if changed.is_err() {
                    break;
                }
                let root = folder.borrow_and_update().clone();
                alive = send_within(&mut ws, info(root)).await;
            }
            incoming = ws.recv() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    let Some(req) = files_ws::parse_request(&bytes) else { continue };
                    let id = req.id;
                    let worker = app.clone();
                    // Um pânico aqui vira erro deste pedido, e o canal continua.
                    let outcome = tokio::task::spawn_blocking(move || worker.file_op(&req))
                        .await
                        .unwrap_or_else(|_| files_ws::Outcome::Failed(files::FileError::Io("erro interno".into())));
                    let reply = match outcome {
                        files_ws::Outcome::Ok(body) => files_ws::encode_response(id, 0, &body),
                        files_ws::Outcome::Saved(path) => files_ws::encode_response(id, 0, json!({ "path": path }).to_string().as_bytes()),
                        files_ws::Outcome::Failed(error) => files_ws::encode_response(id, error.code(), error.describe().as_bytes()),
                    };
                    alive = send_within(&mut ws, reply).await;
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
        }
    }
    app.files_open.fetch_sub(1, Ordering::Relaxed);
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
    // Uma regra por porta: quem já tinha a do hub, de uma versão anterior, ainda precisa da do site.
    let site_rule = format!("name=Oblita Host site - {}", exe.display());
    let add = |rule: &str, port: u16| {
        let port = format!("localport={port}");
        netsh(&["show", "rule", rule])
            || netsh(&["add", "rule", rule, "dir=in", "action=allow", program.as_str(), "enable=yes", "profile=private,public", "protocol=TCP", port.as_str()])
    };
    if netsh(&["show", "rule", rule.as_str()]) && netsh(&["show", "rule", site_rule.as_str()]) {
        log!("Firewall: regra deste programa já existe.");
        return;
    }
    // Sem curto-circuito: sem a regra do hub, ainda vale tentar a do site, e vice-versa.
    let hub_added = add(rule.as_str(), port());
    let site_added = add(site_rule.as_str(), FRONT_PORT);
    if hub_added && site_added {
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
            "A porta {} já está em uso, provavelmente porque o Oblita Host já está aberto.\n\
             Procure a outra janela e use aquela, ou feche-a e abra este programa de novo.",
            port()
        ),
        io::ErrorKind::PermissionDenied => format!(
            "O Windows não deixou usar a porta {} ({error}).\n\
             Reinicie o computador e tente de novo; se continuar, abra como administrador.",
            port()
        ),
        _ => format!("Não foi possível abrir a porta {}: {error}.\nReinicie o computador e tente de novo.", port()),
    }
}

// ---- o site embutido: funciona sem o oblita.giuli.dev e sem internet nenhuma

#[derive(Embed)]
#[folder = "../dist"]
struct Front;

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "json" | "webmanifest" => "application/json",
        "wasm" => "application/wasm",
        "tar" => "application/x-tar",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn front_file(method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let immutable = path.starts_with("assets/");
    let (name, gzipped, file) = if let Some(file) = Front::get(path) {
        (path, false, file)
    } else if let Some(file) = Front::get(&format!("{path}.gz")) {
        // O compilador vem comprimido no site; aqui quem abre é o próprio navegador.
        (path, true, file)
    } else if immutable {
        return StatusCode::NOT_FOUND.into_response();
    } else if let Some(file) = Front::get("index.html") {
        ("index.html", false, file)
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, content_type(name))
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::X_FRAME_OPTIONS, "DENY")
        .header(header::CACHE_CONTROL, if immutable { "public, max-age=31536000, immutable" } else { "no-cache" });
    if gzipped {
        response = response.header(header::CONTENT_ENCODING, "gzip");
    }
    response.body(Body::from(file.data)).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn tls_config(cert: Vec<u8>, key: Vec<u8>) -> Result<ServerConfig, String> {
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(cert)], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)))
        .map_err(|error| error.to_string())?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

// Guardado em disco: com um certificado novo a cada abertura, reabrir o programa no meio
// da prova faria todo aluno aceitar o aviso de novo.
fn tls_acceptor() -> Result<TlsAcceptor, String> {
    let dir = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("Oblita");
    let (cert_path, key_path) = (dir.join("cert.der"), dir.join("key.der"));
    let saved = match (fs::read(&cert_path), fs::read(&key_path)) {
        (Ok(cert), Ok(key)) => tls_config(cert, key).ok(),
        _ => None,
    };
    let config = match saved {
        Some(config) => config,
        None => {
            let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
            names.extend(lan_addresses().into_iter().map(|(_, ip)| ip.to_string()));
            let made = rcgen::generate_simple_self_signed(names).map_err(|error| error.to_string())?;
            let (cert, key) = (made.cert.der().to_vec(), made.signing_key.serialize_der());
            // Sem conseguir guardar, ainda funciona: só pede o aviso de novo na próxima abertura.
            let _ = fs::create_dir_all(&dir).and_then(|()| fs::write(&cert_path, &cert)).and_then(|()| fs::write(&key_path, &key));
            tls_config(cert, key)?
        }
    };
    Ok(TlsAcceptor::from(Arc::new(config)))
}

// Em http://IP o navegador não libera a tela nem a cifra: fora do próprio computador, só https.
fn redirect_to_tls(headers: &HeaderMap, uri: &Uri) -> Response {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    let host = host.split(':').next().unwrap_or("localhost");
    let target = uri.path_and_query().map_or("/", |value| value.as_str());
    Response::builder()
        .status(StatusCode::PERMANENT_REDIRECT)
        .header(header::LOCATION, format!("https://{host}:{FRONT_PORT}{target}"))
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::BAD_REQUEST.into_response())
}

async fn serve_connection<I>(io: I, app: Router, peer: SocketAddr, tls: bool)
where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let service = hyper::service::service_fn(move |mut request: hyper::Request<hyper::body::Incoming>| {
        let app = app.clone();
        async move {
            if !tls && !is_loopback(peer.ip()) {
                return Ok::<_, Infallible>(redirect_to_tls(request.headers(), request.uri()));
            }
            request.extensions_mut().insert(ConnectInfo(peer));
            app.oneshot(request).await
        }
    });
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder.timer(TokioTimer::new());
    let _ = builder.serve_connection(io, service).with_upgrades().await;
}

async fn accept_front(stream: TcpStream, app: Router, peer: SocketAddr, acceptor: Option<TlsAcceptor>) {
    let _ = stream.set_nodelay(true);
    let mut first = [0u8; 1];
    if !matches!(timeout(FIRST_BYTE_LIMIT, stream.peek(&mut first)).await, Ok(Ok(1))) {
        return;
    }
    match (first[0] == TLS_HANDSHAKE, acceptor) {
        (true, Some(acceptor)) => {
            if let Ok(Ok(secure)) = timeout(FIRST_BYTE_LIMIT, acceptor.accept(stream)).await {
                serve_connection(TokioIo::new(secure), app, peer, true).await;
            }
        }
        (true, None) => {}
        (false, _) => serve_connection(TokioIo::new(stream), app, peer, false).await,
    }
}

// O hub continua de pé mesmo se esta parte falhar: quem usa o site baixado não depende dela.
async fn serve_front(app: Router) {
    if Front::get("index.html").is_none() {
        log!("Este programa foi compilado sem o site: a porta {FRONT_PORT} fica fechada.");
        return;
    }
    let address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, FRONT_PORT));
    let listener = match TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            log!("O site embutido não abriu na porta {FRONT_PORT} ({error}). O restante continua funcionando pelo oblita.giuli.dev.");
            return;
        }
    };
    let acceptor = match tls_acceptor() {
        Ok(acceptor) => Some(acceptor),
        Err(error) => {
            log!("Sem certificado ({error}): os alunos não vão conseguir usar o site desta porta, só a página já baixada.");
            None
        }
    };
    FRONT_UP.store(true, Ordering::Relaxed);
    log!("Sem internet e sem baixar nada antes:");
    log!("    Professor, neste computador: http://localhost:{FRONT_PORT}");
    for (_, ip) in lan_addresses() {
        log!("    Alunos: https://{ip}:{FRONT_PORT}");
    }
    log!("    O navegador do aluno avisa sobre o certificado: clique em Avançado e depois em Continuar.");
    log!("");
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                tokio::spawn(accept_front(stream, app.clone(), peer, acceptor.clone()));
            }
            Err(_) => time::sleep(Duration::from_millis(100)).await,
        }
    }
}

fn hub_routes() -> Router<Arc<Hub>> {
    Router::new()
        .route("/ping", get(ping))
        .route("/host-token", get(host_token))
        .route("/ws/host", get(ws_host))
        .route("/ws/student", get(ws_student))
        .route("/ws/files", get(ws_files))
}

async fn serve(token: String, app: Arc<App>) -> Result<(), String> {
    let address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port()));
    let listener = TcpListener::bind(address).await.map_err(explain_bind)?.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });

    // Na tela de menu o logo já está no topo.
    if log::to_stdout() {
        log!("{LOGO}");
    }
    log!("Oblita Host: tudo certo, o programa está rodando.");
    log!("");
    let addresses = lan_addresses();
    if addresses.is_empty() {
        log!("Nenhuma rede encontrada. Conecte este computador ao Wi-Fi ou ao cabo e abra o programa de novo.");
    } else {
        log!("Os alunos devem digitar um destes endereços (use o da rede em que eles estão):");
        for (name, ip) in &addresses {
            log!("    {ip}:{}    ({name})", port());
        }
    }
    log!("");
    log!("Gravação em: {}", app.folder().display());
    log!("Deixe esta janela aberta durante a prova. Para encerrar, feche a janela.");
    log!("");
    tokio::task::spawn_blocking(ensure_firewall);

    let hub = Arc::new(Hub { token, inner: Mutex::new(Inner::default()), app });
    // Com --porta é teste, com outro programa aberto: a porta do site fica com ele.
    if port() == HUB_PORT {
        // Sem CORS: aqui tudo é da mesma origem, e nenhum outro site precisa ler nada desta porta.
        let front: Router = hub_routes().fallback(front_file).with_state(hub.clone());
        tokio::spawn(serve_front(front));
    }
    let app: Router = hub_routes().fallback(|| async { StatusCode::NOT_FOUND }).layer(middleware::from_fn(cors)).with_state(hub);
    let service = app.into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, service).await.map_err(|error| format!("O servidor parou: {error}. Abra o programa de novo."))
}

fn run(app: Arc<App>) -> Result<(), String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| format!("O Windows não forneceu números aleatórios: {error}. Reinicie o computador."))?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Não foi possível iniciar: {error}. Reinicie o computador e tente de novo."))?;
    runtime.block_on(serve(token, app))
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

// Acentos: a std do Rust escreve no console com WriteConsoleW, então não precisa de chcp 65001.
// O hub roda numa thread própria; a principal fica com a tela, porque o diálogo de pasta do macOS
// só abre na thread principal.
const HELP: &str = "\
Oblita Host: o programa de rede local do professor.

Uso: oblita-host [opções]

Sem opções, abre a tela com menu e grava na pasta escolhida da última vez
(Documentos\\Oblita na primeira vez).

Opções:
  --pasta <caminho>  grava nesta pasta só desta vez, sem mudar a escolha salva
  --porta <número>   escuta nesta porta em vez da 7787, sem o site na 3067 (para testes)
  --plain            sem a tela de menu: só o registro, linha a linha
  --help, -h         mostra esta ajuda
";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().skip(1).any(|a| matches!(a.as_str(), "--help" | "-h" | "/?")) {
        print!("{HELP}");
        return;
    }
    // Sem terminal (saída redirecionada, como no CI), a tela de menu não teria onde desenhar.
    let plain = args.iter().any(|a| a == "--plain") || !io::stdout().is_terminal() || !io::stdin().is_terminal();
    log::init(plain);
    std::panic::set_hook(Box::new(|info| {
        log!("Erro interno: {info}. Se algo parar de funcionar, feche e abra o programa de novo.");
    }));

    // Para testar: a pasta vale só desta vez e não é salva.
    let chosen = arg_value(&args, "--pasta").map(PathBuf::from);
    if let Some(port) = arg_value(&args, "--porta").and_then(|p| p.parse::<u16>().ok()) {
        PORT.store(port, Ordering::Relaxed);
    }
    let config_file = config::config_path();
    let folder = chosen.clone().unwrap_or_else(|| match &config_file {
        Some(file) => config::load(file, config::default_folder()).folder,
        None => config::default_folder(),
    });
    if let Err(error) = std::fs::create_dir_all(&folder) {
        log!("Não foi possível criar a pasta de gravação {}: {error}. Escolha outra no menu.", folder.display());
    }
    let app = Arc::new(App::new(folder, config_file, chosen.is_none()));

    let (stopped_tx, stopped_rx) = std::sync::mpsc::channel::<String>();
    let server = app.clone();
    std::thread::spawn(move || {
        let message = match std::panic::catch_unwind(move || run(server)) {
            Ok(Ok(())) => "O programa parou. Abra de novo para continuar.".to_string(),
            Ok(Err(message)) => message,
            Err(_) => "O programa parou por um erro interno. Abra de novo para continuar.".to_string(),
        };
        let _ = stopped_tx.send(message);
    });

    let mut stopped = None;
    if !plain {
        match std::panic::catch_unwind(|| tui::run(&app, &stopped_rx)) {
            Ok(Ok(tui::Exit::Quit)) => std::process::exit(0),
            Ok(Ok(tui::Exit::Stopped(message))) => stopped = Some(message),
            Ok(Err(error)) => log!("A tela de menu não abriu ({error}); seguindo no modo simples."),
            Err(_) => log!("A tela de menu parou por um erro interno; seguindo no modo simples. A prova continua."),
        }
        // Dá tempo de a última linha chegar à lista antes de ela ir para o console.
        std::thread::sleep(Duration::from_millis(100));
        log::switch_to_stdout();
    }
    let message = stopped.unwrap_or_else(|| stopped_rx.recv().unwrap_or_else(|_| "O programa parou.".to_string()));
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
