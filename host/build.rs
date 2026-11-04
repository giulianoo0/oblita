// O ícone do .exe exige o rc.exe do Windows SDK, que o CI tem. Sem ele o programa só fica sem ícone.
fn main() {
    println!("cargo:rerun-if-changed=oblita.ico");
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        winresource::WindowsResource::new()
            .set_icon("oblita.ico")
            .set("ProductName", "Oblita Host")
            .set("FileDescription", "Programa de rede local do oblita_")
            .compile()
            .expect("não foi possível embutir o ícone");
    }
}
