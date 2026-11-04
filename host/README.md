# Oblita Host

Programa de console para Windows (também roda no macOS, para teste) que o professor abre na própria máquina durante uma prova sem internet. Ele repassa bytes entre os alunos e o painel do professor e grava na pasta da prova o que o painel mandar: não entende provas nem gabarito, então não tem o que vazar.

## Tela

A janela mostra o logo, se está rodando, quantos alunos estão conectados, se o painel está conectado, os endereços para os alunos, a pasta de gravação com o espaço livre, o último "Tudo salvo em" e o registro rolando embaixo. Teclas:

- `P` escolhe a pasta pelo diálogo do sistema; `D` deixa digitar o caminho (para quando o diálogo não abre);
- `A` abre a pasta no Explorer (no Finder, no macOS);
- `Q` sai, pedindo confirmação se houver alunos conectados.

A pasta padrão é `Documentos/Oblita`, e a escolha fica em `%APPDATA%/Oblita/host.json`. Sem terminal (saída redirecionada, como no CI) ou com `--plain`, o programa só escreve o registro, como antes. Se a tela não abrir ou parar por erro, ele cai para esse modo e a prova continua. A tela roda numa thread própria e só lê números do hub, então travar a janela não trava a prova; com a tela, o QuickEdit do Windows fica desligado.

Para teste: `--pasta <caminho>` usa outra pasta só desta vez, e `--porta <n>` outra porta.

## Pasta da prova

O painel grava por `/ws/files?token=...`, que exige loopback, o token e a origem do Oblita. O programa só escreve: nada é lido, listado, movido ou devolvido pela rede. Tudo cai numa subpasta por prova, marcada com `.oblita-sala`; pasta sem a marca não é tocada. Cada caminho é conferido nome por nome (sem `..`, sem raiz, sem unidade, UNC ou `\\?\`, sem `:`, sem nomes reservados, sem caracteres de controle ou invisíveis, com limite de tamanho) e sem seguir links, junções ou pontos de nova análise, e conferido de novo pelo arquivo já aberto. Há limite por arquivo (2 GiB), por pedido (32 MiB), por sala (400 GiB e 50 000 arquivos) e uma reserva de 1 GiB livre no disco. Detalhes e o limite conhecido em `SPEC.md` §8.

## Como funciona

- O professor abre o `oblita-host.exe`, e a janela mostra os endereços (`IP:7787`) que os alunos devem digitar.
- O painel, na página do Oblita, detecta o programa em `http://localhost:7787/host-token`. Essa rota só entrega o token para a própria máquina e para uma origem do Oblita.
- O painel conecta em `/ws/host?token=...` e `/ws/files?token=...`, e os alunos conectam em `/ws/student`.
- Se o painel recarregar, os alunos continuam conectados e são reapresentados a ele.
- Se a fila de um aluno encher, ou se o IP dele ocupar mais de 32 MiB da fila do painel, o programa fecha esse aluno em vez de gastar memória. O painel nunca cai por excesso de dados. O aluno reconecta e o protocolo retransmite o que faltou.

## Limites

- 512 alunos no total e 128 conexões por IP, inclusive no loopback. Alunos atrás de um mesmo NAT contam como um IP só, então o teto por IP cabe uma sala inteira (até ~100 alunos).
- Um aluno que não mandar nenhum quadro binário nos primeiros 15 s é fechado. Responder ping ou mandar texto não conta.
- Quadros de até 8 MiB do aluno para o painel e de até 16 MiB do painel para o aluno. Acima disso, só a conexão que mandou cai.
- Não há limite de velocidade: um aluno que manda rápido, mas não o bastante para encher a cota, continua gastando a banda e a CPU do painel, e os outros esperam atrás dele na fila.

O protocolo é o de `shared/frames.ts`, e `server/hub.ts` é a versão em TypeScript para desenvolvimento. Mudou um, mude o outro. Os limites desta seção e a cota da fila existem só aqui, porque aquela versão não é usada em prova.

## Porta

TCP 7787 em todas as interfaces. Se ela estiver ocupada, normalmente há outra janela do programa aberta, e o erro explica isso na tela.

## Site embutido

O programa traz o site inteiro e o serve na porta 3067, sem depender do `oblita.giuli.dev`: o professor abre `http://localhost:3067` e os alunos `https://IP:3067`, com um aviso de certificado que se aceita em Avançado e Continuar. Se a porta 3067 estiver ocupada, só o site fica de fora; o hub na 7787 continua. Com `--porta` a 3067 não abre. O CI compila o site antes do programa; localmente, rode `npx vite build` e `node scripts/postbuild.mjs` antes do `cargo build`, senão o programa sai sem o site.

## Firewall

Ao abrir, o programa tenta criar uma regra de entrada para o próprio `.exe` nas redes privadas e públicas, se ela ainda não existir. Isso exige administrador. Sem essa permissão, basta clicar em Permitir no aviso do Windows ou abrir o programa como administrador uma vez. Cancelar esse aviso faz o Windows criar regras de bloqueio chamadas `oblita-host`, e bloqueio vence liberação; abrir como administrador também as apaga. Em computadores de domínio (comum em escolas), a regra precisa ser criada à mão ou pela TI, porque ela não cobre o perfil de domínio.

## Build

O `.exe` publicado vem do CI (`.github/workflows/host.yml`), que compila com MSVC e `--locked`, roda os testes e o `smoke.ps1` e publica na release `host-latest`.

Para testar localmente, depois de `cargo build --release`, rode `bun test e2e/hub-rust.test.ts`, com a porta 7787 livre. A pasta da prova tem o próprio teste, que roda no macOS e no Windows: `cargo build` e `bun test e2e/files-rust.test.ts`, com a porta 17791 livre. Com o toolchain GNU sem MSYS2, o build falha porque o `dlltool` do `rust-mingw` precisa de um `as.exe` que não vem junto; o MSVC não tem esse problema.
