# Oblita Host

Programa de console para Windows que o professor abre na própria máquina durante uma prova sem internet. Ele só repassa bytes entre os alunos e o painel do professor: não entende provas nem gabarito, então não tem o que vazar.

## Como funciona

- O professor abre o `oblita-host.exe`, e a janela mostra os endereços (`IP:7787`) que os alunos devem digitar.
- O painel, na página do Oblita, detecta o programa em `http://localhost:7787/host-token`. Essa rota só entrega o token para a própria máquina e para uma origem do Oblita.
- O painel conecta em `/ws/host?token=...`, e os alunos conectam em `/ws/student`.
- Se o painel recarregar, os alunos continuam conectados e são reapresentados a ele.
- Se a fila de um aluno encher, ou se o IP dele ocupar mais de 32 MiB da fila do painel, o programa fecha esse aluno em vez de gastar memória. O painel nunca cai por excesso de dados. O aluno reconecta e o protocolo retransmite o que faltou.

## Limites

- 512 alunos no total e 16 conexões por IP, inclusive no loopback. Alunos atrás de um mesmo NAT contam como um IP só.
- Um aluno que não mandar nenhum quadro binário nos primeiros 15 s é fechado. Responder ping ou mandar texto não conta.
- Quadros de até 8 MiB do aluno para o painel e de até 16 MiB do painel para o aluno. Acima disso, só a conexão que mandou cai.
- Não há limite de velocidade: um aluno que manda rápido, mas não o bastante para encher a cota, continua gastando a banda e a CPU do painel, e os outros esperam atrás dele na fila.

O protocolo é o de `shared/frames.ts`, e `server/hub.ts` é a versão em TypeScript para desenvolvimento. Mudou um, mude o outro. Os limites desta seção e a cota da fila existem só aqui, porque aquela versão não é usada em prova.

## Porta

TCP 7787 em todas as interfaces. Se ela estiver ocupada, normalmente há outra janela do programa aberta, e o erro explica isso na tela.

## Firewall

Ao abrir, o programa tenta criar uma regra de entrada para o próprio `.exe` nas redes privadas e públicas, se ela ainda não existir. Isso exige administrador. Sem essa permissão, basta clicar em Permitir no aviso do Windows ou abrir o programa como administrador uma vez. Cancelar esse aviso faz o Windows criar regras de bloqueio chamadas `oblita-host`, e bloqueio vence liberação; abrir como administrador também as apaga. Em computadores de domínio (comum em escolas), a regra precisa ser criada à mão ou pela TI, porque ela não cobre o perfil de domínio.

## Build

O `.exe` publicado vem do CI (`.github/workflows/host.yml`), que compila com MSVC e `--locked`, roda os testes e o `smoke.ps1` e publica na release `host-latest`.

Para testar localmente, depois de `cargo build --release`, rode `bun test e2e/hub-rust.test.ts`, com a porta 7787 livre. Com o toolchain GNU sem MSYS2, o build falha porque o `dlltool` do `rust-mingw` precisa de um `as.exe` que não vem junto; o MSVC não tem esse problema.
