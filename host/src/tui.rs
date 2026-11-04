// Tela do programa: estado, pasta de gravação e registro, com um menu por teclas.
// Roda na thread principal e só lê o estado do App; o hub segue sozinho se esta tela travar.
use std::{
    io,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, mpsc::Receiver},
    time::{Duration, Instant},
};

use ratatui::{
    crossterm::{
        event::{self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers},
        execute,
    },
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    DefaultTerminal, Frame,
};

use crate::{app::App, HUB_PORT};

const LOGO: [&str; 5] = [
    "        _     _ _ _",
    "   ___ | |__ | (_) |_ __ _",
    "  / _ \\| '_ \\| | | __/ _` |",
    " | (_) | |_) | | | || (_| |",
    "  \\___/|_.__/|_|_|\\__\\__,_|___",
];
const LOW_SPACE: u64 = 2 * 1024 * 1024 * 1024;
const FREE_EVERY: Duration = Duration::from_secs(5);
const ADDRESSES_EVERY: Duration = Duration::from_secs(10);
const ERROR_SHOWN: Duration = Duration::from_secs(60);

pub enum Exit {
    Quit,
    Stopped(String),
}

enum Mode {
    Normal,
    Typing(String),
    ConfirmQuit(usize),
}

struct Screen {
    mode: Mode,
    free: Option<u64>,
    free_at: Option<Instant>,
    free_of: PathBuf,
    addresses: Vec<(String, std::net::Ipv4Addr)>,
    addresses_at: Option<Instant>,
    notice: Option<String>,
}

// Restaura o terminal em qualquer saída, inclusive pânico: sem isto a janela ficaria sem eco.
struct Restore;

impl Drop for Restore {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), DisableMouseCapture, DisableBracketedPaste);
        ratatui::restore();
    }
}

pub fn run(app: &App, stopped: &Receiver<String>) -> io::Result<Exit> {
    let mut terminal = ratatui::try_init()?;
    let _restore = Restore;
    // Com o mouse capturado, o Windows desliga o QuickEdit: um clique não pausa mais a tela.
    let _ = execute!(io::stdout(), EnableMouseCapture, EnableBracketedPaste);
    let mut screen = Screen {
        mode: Mode::Normal,
        free: None,
        free_at: None,
        free_of: PathBuf::new(),
        addresses: Vec::new(),
        addresses_at: None,
        notice: None,
    };
    loop {
        if let Ok(message) = stopped.try_recv() {
            return Ok(Exit::Stopped(message));
        }
        refresh(app, &mut screen);
        terminal.draw(|frame| draw(frame, app, &screen))?;
        if !event::poll(Duration::from_millis(250))? {
            continue;
        }
        let input = event::read()?;
        if let Some(exit) = handle(app, &mut screen, &mut terminal, input) {
            return Ok(exit);
        }
    }
}

fn refresh(app: &App, screen: &mut Screen) {
    let folder = app.folder();
    if screen.free_of != folder || screen.free_at.is_none_or(|at| at.elapsed() > FREE_EVERY) {
        screen.free = fs4::available_space(&folder).ok();
        screen.free_at = Some(Instant::now());
        screen.free_of = folder;
    }
    if screen.addresses_at.is_none_or(|at| at.elapsed() > ADDRESSES_EVERY) {
        screen.addresses = crate::lan_addresses();
        screen.addresses_at = Some(Instant::now());
    }
}

fn handle(app: &App, screen: &mut Screen, terminal: &mut DefaultTerminal, input: Event) -> Option<Exit> {
    let paste = match &input {
        Event::Paste(text) => Some(text.clone()),
        _ => None,
    };
    let key = match input {
        Event::Key(key) if key.kind == KeyEventKind::Press => Some(key),
        _ => None,
    };
    match &mut screen.mode {
        Mode::Typing(text) => {
            if let Some(pasted) = paste {
                text.push_str(pasted.trim_matches(['\r', '\n']));
                return None;
            }
            let key = key?;
            match key.code {
                KeyCode::Esc => screen.mode = Mode::Normal,
                KeyCode::Backspace => {
                    text.pop();
                }
                KeyCode::Enter => {
                    // Quem copia o caminho do Explorer costuma trazer as aspas junto.
                    let typed = PathBuf::from(text.trim().trim_matches('"'));
                    screen.notice = app.set_folder(typed).err();
                    screen.mode = Mode::Normal;
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => text.push(c),
                _ => {}
            }
            None
        }
        Mode::ConfirmQuit(_) => {
            let key = key?;
            match key.code {
                KeyCode::Char('s' | 'S' | 'y' | 'Y') => Some(Exit::Quit),
                _ => {
                    screen.mode = Mode::Normal;
                    None
                }
            }
        }
        Mode::Normal => {
            let key = key?;
            let ctrl_c = key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
            match key.code {
                _ if ctrl_c => quit(app, screen),
                KeyCode::Char('q' | 'Q') | KeyCode::Esc => quit(app, screen),
                KeyCode::Char('p' | 'P') => {
                    pick_folder(app, screen);
                    // O diálogo nativo desenha por cima: a tela inteira é refeita depois.
                    let _ = terminal.clear();
                    None
                }
                KeyCode::Char('d' | 'D') => {
                    screen.mode = Mode::Typing(app.folder().display().to_string());
                    None
                }
                KeyCode::Char('a' | 'A') => {
                    open_in_explorer(&app.folder());
                    None
                }
                _ => None,
            }
        }
    }
}

fn quit(app: &App, screen: &mut Screen) -> Option<Exit> {
    let students = app.students.load(Ordering::Relaxed);
    if students == 0 {
        return Some(Exit::Quit);
    }
    screen.mode = Mode::ConfirmQuit(students);
    None
}

fn pick_folder(app: &App, screen: &mut Screen) {
    let current = app.folder();
    // O diálogo é do sistema; se não abrir (Linux sem portal), fica a opção de digitar.
    let picked = std::panic::catch_unwind(|| rfd::FileDialog::new().set_title("Pasta de gravação do Oblita").set_directory(&current).pick_folder());
    match picked {
        Ok(Some(folder)) => screen.notice = app.set_folder(folder).err(),
        Ok(None) => {}
        Err(_) => screen.notice = Some("o diálogo de pasta não abriu aqui; aperte D para digitar o caminho".into()),
    }
}

fn open_in_explorer(folder: &Path) {
    let _ = std::fs::create_dir_all(folder);
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(windows, target_os = "macos")))]
    let program = "xdg-open";
    if let Err(error) = std::process::Command::new(program).arg(folder).spawn() {
        log!("Não foi possível abrir a pasta: {error}.");
    }
}

pub fn format_bytes(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let gb = bytes as f64 / GB;
    let text = if gb >= 100.0 { format!("{gb:.0} GB") } else if gb >= 1.0 { format!("{gb:.1} GB") } else { format!("{:.0} MB", bytes as f64 / (1024.0 * 1024.0)) };
    text.replace('.', ",")
}

fn draw(frame: &mut Frame, app: &App, screen: &Screen) {
    let [top, folder_area, log_area, menu_area] =
        Layout::vertical([Constraint::Length(7), Constraint::Length(5), Constraint::Min(3), Constraint::Length(1)]).areas(frame.area());
    let [logo_area, status_area] = Layout::horizontal([Constraint::Length(32), Constraint::Min(20)]).areas(top);

    let brand = Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD);
    let logo: Vec<Line> = std::iter::once(Line::default()).chain(LOGO.iter().map(|l| Line::styled(*l, brand))).collect();
    frame.render_widget(Paragraph::new(logo), logo_area);
    frame.render_widget(Paragraph::new(status_lines(app, screen)).wrap(Wrap { trim: false }), status_area);
    frame.render_widget(folder_block(app, screen), folder_area);

    let height = log_area.height.saturating_sub(2) as usize;
    let lines: Vec<Line> = crate::log::recent(height).into_iter().map(Line::from).collect();
    frame.render_widget(Paragraph::new(lines).block(Block::default().borders(Borders::TOP).title(" Registro ")), log_area);
    frame.render_widget(menu(screen), menu_area);
}

fn status_lines(app: &App, screen: &Screen) -> Vec<Line<'static>> {
    let ok = Style::default().fg(Color::Green);
    let off = Style::default().fg(Color::DarkGray);
    let students = app.students.load(Ordering::Relaxed);
    let panel = app.panel.load(Ordering::Relaxed);
    let mut lines = vec![
        Line::default(),
        Line::from(vec![Span::styled("● rodando", ok), Span::raw(format!("   Alunos conectados: {students}"))]),
        Line::from(vec![
            Span::raw("Painel do professor: "),
            if panel { Span::styled("conectado", ok) } else { Span::styled("não conectado (abra o Oblita neste computador)", off) },
        ]),
        Line::from("Endereços para os alunos digitarem:"),
    ];
    if screen.addresses.is_empty() {
        lines.push(Line::styled("  nenhuma rede encontrada; conecte ao Wi-Fi ou ao cabo", Style::default().fg(Color::Red)));
    }
    for (name, ip) in &screen.addresses {
        lines.push(Line::from(vec![Span::styled(format!("  {ip}:{HUB_PORT}"), Style::default().add_modifier(Modifier::BOLD)), Span::styled(format!("  ({name})"), off)]));
    }
    lines
}

fn folder_block(app: &App, screen: &Screen) -> Paragraph<'static> {
    let folder = app.folder();
    let free = match screen.free {
        Some(free) if free < LOW_SPACE => Span::styled(format!("{} livres: pouco espaço, escolha outra pasta", format_bytes(free)), Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)),
        Some(free) => Span::raw(format!("{} livres", format_bytes(free))),
        None => Span::styled("pasta não encontrada", Style::default().fg(Color::Red)),
    };
    let mut lines = vec![Line::from(vec![Span::raw(folder.display().to_string()), Span::raw("   "), free])];
    let status = app.status();
    if let Some((at, error)) = &status.error {
        if at.elapsed() < ERROR_SHOWN {
            lines.push(Line::styled(error.clone(), Style::default().fg(Color::Red)));
        }
    }
    if let Some(saved) = &status.saved {
        lines.push(Line::styled(format!("Tudo salvo em {saved}"), Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)));
    }
    if let Some(notice) = &screen.notice {
        lines.push(Line::styled(notice.clone(), Style::default().fg(Color::Yellow)));
    }
    Paragraph::new(lines).wrap(Wrap { trim: false }).block(Block::default().borders(Borders::TOP).title(" Pasta de gravação "))
}

fn menu(screen: &Screen) -> Paragraph<'static> {
    let key = Style::default().fg(Color::Black).bg(Color::Yellow);
    let line = match &screen.mode {
        Mode::Normal => Line::from(vec![
            Span::styled(" P ", key),
            Span::raw(" escolher pasta  "),
            Span::styled(" D ", key),
            Span::raw(" digitar caminho  "),
            Span::styled(" A ", key),
            Span::raw(" abrir pasta  "),
            Span::styled(" Q ", key),
            Span::raw(" sair"),
        ]),
        Mode::Typing(text) => Line::from(vec![Span::raw("Caminho da pasta: "), Span::styled(format!("{text}_"), Style::default().add_modifier(Modifier::BOLD)), Span::raw("   Enter confirma, Esc cancela")]),
        Mode::ConfirmQuit(n) => Line::styled(
            format!("Há {n} aluno(s) conectado(s). Sair desconecta todos até o programa abrir de novo. Sair mesmo assim? (s/n)"),
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        ),
    };
    Paragraph::new(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_read_like_windows_explorer_in_portuguese() {
        assert_eq!(format_bytes(512 * 1024 * 1024), "512 MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024 / 2), "1,5 GB");
        assert_eq!(format_bytes(250 * 1024 * 1024 * 1024), "250 GB");
    }
}
