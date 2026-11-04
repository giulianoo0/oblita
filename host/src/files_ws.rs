// Canal de arquivos entre o painel e este programa, só pelo loopback, com o token e a origem do painel.
// Pedido:   [u32 id][u8 op][u64 offset][u16 tamanho do caminho][caminho][corpo]
// Resposta: [u32 id][u8 situação][corpo]; situação 0 é sucesso, o resto é FileError::code.
// O id 0 é reservado para avisos que partem daqui, como a troca de pasta.
// Só há escrita: nenhuma operação lê, lista ou devolve conteúdo de arquivo.
// O formato é o mesmo de src/teacher/fileLink.ts: mudou um, mude o outro.
use std::path::Path;

use axum::body::Bytes;

use crate::files::{FileError, Store};

pub const OP_WRITE_AT: u8 = 1;
pub const OP_REPLACE: u8 = 2;
pub const OP_REMOVE: u8 = 4;
pub const OP_INFO: u8 = 6;
pub const OP_DONE: u8 = 7;

#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub id: u32,
    pub op: u8,
    pub offset: u64,
    pub path: String,
    pub body: Bytes,
}

const HEAD: usize = 4 + 1 + 8 + 2;

pub fn parse_request(frame: &Bytes) -> Option<Request> {
    let head = frame.get(..HEAD)?;
    let id = u32::from_be_bytes(head[0..4].try_into().ok()?);
    let op = head[4];
    let offset = u64::from_be_bytes(head[5..13].try_into().ok()?);
    let path_len = usize::from(u16::from_be_bytes(head[13..15].try_into().ok()?));
    let path = std::str::from_utf8(frame.get(HEAD..HEAD + path_len)?).ok()?.to_owned();
    Some(Request { id, op, offset, path, body: frame.slice(HEAD + path_len..) })
}

pub fn encode_response(id: u32, status: u8, body: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(5 + body.len());
    out.extend_from_slice(&id.to_be_bytes());
    out.push(status);
    out.extend_from_slice(body);
    Bytes::from(out)
}

pub enum Outcome {
    Ok(Vec<u8>),
    // A sala inteira foi gravada; leva o caminho completo, para o painel e esta janela mostrarem.
    Saved(String),
    Failed(FileError),
}

// Só da pasta escolhida pelo professor: onde fica e quanto cabe. Nada sobre o resto do disco.
pub fn info_json(root: &Path) -> Vec<u8> {
    let free = fs4::available_space(root).ok();
    serde_json::json!({ "t": "info", "root": root.display().to_string(), "free": free, "exists": root.is_dir() })
        .to_string()
        .into_bytes()
}

// Bloqueia no disco: quem chama roda isto fora do executor do tokio.
pub fn handle(store: Option<&mut Store>, root: &Path, req: &Request) -> Outcome {
    if req.op == OP_INFO {
        return Outcome::Ok(info_json(root));
    }
    let Some(store) = store else { return Outcome::Failed(FileError::NoRoot) };
    let done = |result: Result<(), FileError>| result.map_or_else(Outcome::Failed, |()| Outcome::Ok(Vec::new()));
    match req.op {
        OP_WRITE_AT => done(store.write_at(&req.path, req.offset, &req.body).map(drop)),
        OP_REPLACE => done(store.replace(&req.path, &req.body)),
        OP_REMOVE => done(store.remove(&req.path)),
        OP_DONE => store.room_path(&req.path).map_or_else(Outcome::Failed, |path| Outcome::Saved(path.display().to_string())),
        _ => Outcome::Failed(FileError::InvalidPath),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::Limits;

    fn frame(id: u32, op: u8, offset: u64, path: &str, body: &[u8]) -> Bytes {
        let mut out = Vec::new();
        out.extend_from_slice(&id.to_be_bytes());
        out.push(op);
        out.extend_from_slice(&offset.to_be_bytes());
        out.extend_from_slice(&(path.len() as u16).to_be_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(body);
        Bytes::from(out)
    }

    #[test]
    fn parses_what_the_panel_sends() {
        let parsed = parse_request(&frame(7, OP_WRITE_AT, 300, "sala/a.webm", b"xyz"));
        assert_eq!(
            parsed,
            Some(Request { id: 7, op: OP_WRITE_AT, offset: 300, path: "sala/a.webm".into(), body: Bytes::from_static(b"xyz") })
        );
    }

    #[test]
    fn short_or_broken_frames_are_ignored() {
        assert_eq!(parse_request(&Bytes::new()), None);
        assert_eq!(parse_request(&Bytes::from_static(&[0, 0, 0, 1, 1, 0, 0])), None);
        let mut long = frame(1, OP_REPLACE, 0, "abc", b"").to_vec();
        long[13..15].copy_from_slice(&500u16.to_be_bytes());
        assert_eq!(parse_request(&Bytes::from(long)), None, "caminho maior que o quadro");
        let mut invalid = frame(1, OP_REPLACE, 0, "ab", b"").to_vec();
        invalid[15] = 0xff;
        assert_eq!(parse_request(&Bytes::from(invalid)), None, "caminho que não é UTF-8");
    }

    #[test]
    fn response_carries_id_and_status() {
        assert_eq!(&encode_response(258, 5, b"ok")[..], &[0, 0, 1, 2, 5, b'o', b'k'][..]);
    }

    #[test]
    fn dispatches_to_the_store_and_reports_errors() {
        let dir = std::env::temp_dir().join(format!("oblita-ws-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = Store::open(&dir, Limits::default()).unwrap();
        let req = |op, offset, path: &str, body: &[u8]| parse_request(&frame(1, op, offset, path, body)).unwrap();
        assert!(matches!(handle(Some(&mut store), &dir, &req(OP_WRITE_AT, 0, "s/a.webm", b"abc")), Outcome::Ok(_)));
        assert!(matches!(handle(Some(&mut store), &dir, &req(OP_WRITE_AT, 3, "s/a.webm", b"de")), Outcome::Ok(_)));
        assert_eq!(std::fs::read(dir.join("s/a.webm")).unwrap(), b"abcde");
        assert!(matches!(handle(Some(&mut store), &dir, &req(OP_REPLACE, 0, "s/r.txt", b"oi")), Outcome::Ok(_)));
        assert!(matches!(handle(Some(&mut store), &dir, &req(OP_REMOVE, 0, "s/r.txt", b"")), Outcome::Ok(_)));
        assert!(!dir.join("s/r.txt").exists());
        assert!(matches!(handle(Some(&mut store), &dir, &req(OP_REPLACE, 0, "../fora.txt", b"x")), Outcome::Failed(FileError::InvalidPath)));
        // Ler e renomear não existem: 5 e 3 foram ops de rascunho e continuam recusados.
        for op in [3, 5, 0, 99] {
            assert!(matches!(handle(Some(&mut store), &dir, &req(op, 0, "s/a.webm", b"")), Outcome::Failed(FileError::InvalidPath)), "op {op}");
        }
        match handle(None, &dir, &req(OP_INFO, 0, "", b"")) {
            Outcome::Ok(json) => {
                let info: serde_json::Value = serde_json::from_slice(&json).unwrap();
                assert_eq!(info["root"], dir.display().to_string());
                assert!(info["free"].as_u64().is_some());
            }
            _ => panic!("info falhou"),
        }
        assert!(matches!(handle(None, &dir, &req(OP_REPLACE, 0, "s/r.txt", b"x")), Outcome::Failed(FileError::NoRoot)));
        match handle(Some(&mut store), &dir, &req(OP_DONE, 0, "s", b"")) {
            Outcome::Saved(path) => assert!(path.ends_with("s"), "{path}"),
            _ => panic!("done falhou"),
        }
        assert!(matches!(handle(Some(&mut store), &dir, &req(OP_DONE, 0, "..", b"")), Outcome::Failed(FileError::InvalidPath)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
