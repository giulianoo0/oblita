# oblita_ — Especificação

provas online de código sem cola.

Documento vivo e fonte de verdade do produto. Se algo aqui divergir do código, confira no código e corrija este arquivo. O andamento fica em [PLAN.md](PLAN.md).

Última atualização: 2026-11-04.

## 1. O que é

Plataforma de prova de C e C++ que roda sem internet durante a prova. O professor cria uma sala, os alunos entram pelo IP dele na rede local, fazem a prova em tela cheia compartilhando a tela inteira, e o professor acompanha tudo ao vivo. Tudo fica no PC do professor. No fim, ele exporta um `.zip` completo.

## 2. Cenário real de uso

1. O aluno visita `oblita.giuli.dev` **uma vez** com internet. A página fica baixada.
2. Na hora da prova, a rede corta o acesso a tudo, menos à rede interna. Nenhum endereço web responde.
3. O aluno abre a página baixada, digita o IP do professor e entra.
4. O professor abre o painel na máquina dele, com o programinha rodando.

O corte de rede é feito pela infraestrutura da sala, não pelo aluno. O aluno não desliga o Wi-Fi: se desligar, perde também a rede local.

## 3. Requisitos do dono

### Página inicial
- Status no topo: baixado ou não neste computador.
- Dois caminhos: **Sou aluno** e **Sou professor**.
- O aluno digita o IP direto ali.
- Marca: `oblita_`. Descrição: `provas online de código sem cola.`
- Embeds de link no mesmo estilo do juntos.lol (OpenGraph, Twitter, oEmbed, imagem 1200×630). Logo direta.

### Professor
- Cria a sala montando as questões na tela ou enviando JSON.
- O gabarito é **opcional**. Sem gabarito, o aluno ainda roda e usa os exemplos, e a correção é manual.
- `llms.txt` público explica como uma LLM gera `exam.json` e `solutions.json`.
- Configura: individual ou em equipe (com máximo por equipe), início, senha opcional, exigir rede isolada, gravar telas, habilitar botão Testar.
- **Só uma prova por vez** na máquina, e a sala abre em uma aba só.
- Vê todos em tempo real, com alertas na hora.
- Assiste as gravações num player simples.
- Exporta `.zip` completo, pessoa a pessoa ou grupo a grupo, com nomes dos integrantes e matrícula (opcional), códigos, notas, alertas e gravações.
- Pode rodar **no navegador** ou baixar um **programinha simples em Rust**. O programa é só um console com logs dizendo que está tudo ok. Não tem GPUI: decisão explícita do dono.

### Aluno
- Nome e matrícula opcional. Em modo equipe, cria uma equipe e recebe um código privado, ou entra com o código de um colega.
- Edição colaborativa em tempo real, com nomes nos cursores e seleções, e Ctrl+Z / Cmd+Z estável.
- Entra em tela cheia e compartilha a **tela inteira**. Janela ou aba é recusada, e ele repete.
- Editor igual ao do VS Code (Monaco), com sugestões. Fonte Geist Mono.
- Vários arquivos por questão, com **autosave**.
- **Terminal sempre disponível para rodar o programa.**
- Bate o ponto quando quiser, e o relógio é sincronizado com o do professor.
- **Teste: 1 por minuto**, e roda na máquina do professor.
- A tela da prova é feita de blocos (enunciado, código, entrada e saída; ou enunciado e resposta): cada um recolhe numa faixa, as divisórias redimensionam (com limite por bloco, setas e duplo clique para o padrão), e o cabeçalho arrasta o bloco para o lado, para baixo ou para trocar de lugar, com prévia do destino. Esc ou soltar fora cancela. O menu de cada bloco faz o mesmo pelo teclado, e o do topo restaura o padrão. Um bloco fica sempre aberto. O layout fica guardado por prova no navegador; salvo inválido volta ao padrão (`src/student/blocks.ts`). Em tela estreita os blocos empilham na ordem do layout.

### Vigilância
Abrir DevTools, sair da aba ou qualquer macete gera aviso instantâneo para o professor.

### Segurança
- Gabarito e testes ocultos **nunca** são expostos ao aluno.
- Senha com Argon2. Policy, authorization e token bem feitos.

### Design
Mesma linguagem do juntos.lol: pílulas e cantos grandes sobre fundo cinza, quase sem borda, azul para interação, laranja para a única ação de marca, física de mola em tudo. Sem linha de apoio embaixo de título, botão ou campo. Fontes: **Geist** no site, **Geist Mono** no editor, detalhes em **Geist Serif** (logo e palavra em destaque).

### Stack
React, react-router, Elysia, Vite. Hospedagem em Cloudflare Workers no domínio `oblita.giuli.dev`.

## 4. Fatos verificados

Testados nesta máquina (Edge 156, Windows), não só lidos em documentação:

| Fato | Resultado |
|---|---|
| Página HTTPS → `http://IP-privado` com `fetch` | Funciona com a permissão `local-network`, inclusive stream e POST de 1 MB |
| Página HTTPS → `ws://IP-privado` | Funciona com a mesma permissão, com aviso de "deprecated" |
| `fetch` para `http://` dentro de worker ou service worker | **Bloqueado** como conteúdo misto. `ws://` funciona. Por isso a rede fica na thread principal |
| A permissão é pedida por gesto do usuário | Sem gesto, a requisição fica parada ou é negada. Conectar sempre a partir de um clique |
| Página cacheada, com o servidor de origem morto | Mantém a permissão e alcança a rede local. Corte real de WAN ainda não testado |
| HTTPS autoassinado com aviso aceito | `isSecureContext` verdadeiro e `getDisplayMedia` funciona, mas **sem** service worker |
| Página comum escutar em porta | **Impossível**. Direct Sockets exige Isolated Web App |
| Compilador `@yowasp/clang` | C e STL de C++ compilam e rodam. **Sem exceções de C++** |
| Tempo de compilação no Node | C ~2 s no primeiro uso; C++ com STL ~10 s |

**Consequência:** "digitar o IP do professor" exige um programa nativo escutando. O modo só navegador usa WebRTC e exige que os alunos entrem antes do corte. Um F5 sem internet nesse modo não reconecta.

## 5. Arquitetura

```
Cloudflare Worker (oblita.giuli.dev)
  estáticos + /healthz + /signal (Durable Object, só para o modo navegador)

Máquina do professor
  navegador: painel React, gabarito, correção, estado da sala (IndexedDB)
  oblita-host.exe (Rust): repassa bytes, porta 7787, e grava na pasta da prova o que o painel mandar

Máquina do aluno
  navegador: página baixada, editor, vigia, gravação
```

- **O painel do professor é o mesmo** nos dois modos. O hub não entende provas e nunca recebe a senha nem o gabarito.
- **Com o programa**, gravações, respostas, notas e resumos vão para a pasta da prova enquanto a prova acontece. **Só navegador**, ou se o disco falhar, ficam no IndexedDB e saem pelo zip.
- O servidor Elysia em `server/` é um dublê do hub para desenvolvimento e teste. O de produção é `host/`.
- O Worker usa Elysia com `CloudflareAdapter` e um Durable Object `SignalRoom` por código de sala.

### Caminhos de conexão

| Modo | Requisitos | F5 sem internet |
|---|---|---|
| Programa + IP (principal) | Chromium ≥ 147, página baixada, porta liberada, permissão de rede local | Reconecta sozinho |
| Só navegador + código | Todos entram antes do corte, na mesma rede, aba do professor aberta | **Não reconecta** |

## 6. Formatos

Definidos e validados em `shared/exam.ts`, documentados em `public/llms.txt`.

- `exam.json`: `version`, `title`, `durationMin`, `questions[]` do tipo `code`, `choice` ou `text`.
- `solutions.json`: `version`, `solutions[]`.
- A prova é recusada se contiver chaves de gabarito em qualquer nível (`solution`, `answer`, `correct`, `tests`, `hidden`, `reference`, `rubric`, `expected`, `gabarito`, `resposta`...).
- A prova só entra na rede por `examForStudent`, que copia campo a campo.

## 7. Protocolo

`shared/frames.ts`, `shared/protocol.ts`.

**Quadros:** tudo é binário. Tag 1 JSON, tag 2 binário com cabeçalho, tag 3 cifrado, tag 4 comprimido.

**Versão:** `PROTOCOL_VERSION` vai no `hi` e no `hello`. Versões diferentes são recusadas com `version`. A 2 trouxe compressão, prova por partes e o Testar com executável.

**Compressão:** antes de cifrar, quadros JSON e binários a partir de 512 bytes vão em `deflate-raw` (tag 4), se encolherem. Vídeo, miniatura e selo já vêm comprimidos e vão como estão. Quem recebe descomprime em pedaços e para no teto (48 MB para o aluno, 9 MB para o professor), contra bomba de descompressão. Comprimido dentro de comprimido é recusado. Os dois lados mantêm a ordem dos quadros com uma fila por conexão, porque comprimir é assíncrono.

**Prova por partes:** a prova inteira só sai ao conectar ou reconectar (`exam`), com o JSON da parte visível comprimido uma vez para a sala toda e reaproveitado; só a cifra é por aluno. Liberar e retirar mandam só a diferença (`questions`): a questão nova, ou o id retirado. Questão retirada fica guardada no aluno até o fim da conexão, e se voltar vem só o id, sem enunciado nem imagens de novo. Somar tempo e fim de tempo mandam só os relógios (`clocks`). Mensagens iguais para todos são codificadas e comprimidas uma vez por envio. Se o aluno não tiver o que restaurar, reconecta e recebe tudo.

**Hub:** `[u32 conexão][u8 op][dados]`, op 0 abriu, 1 fechou, 2 dados. Endpoints: `GET /ping`, `GET /host-token` (só loopback e origem permitida), `WS /ws/host?token=`, `WS /ws/student`, `WS /ws/files?token=`. Os alunos sobrevivem ao painel recarregar. O painel reconecta sozinho ao programa, com espera crescente até 15 s, quando a permissão de rede local já foi dada. Acima de 256 MiB na fila de envio da aba, o aluno daquela conexão cai e reenvia ao voltar.

**Arquivos:** `src/teacher/fileLink.ts` e `host/src/files_ws.rs`. Pedido `[u32 id][u8 op][u64 offset][u16 tamanho][caminho][corpo]`, resposta `[u32 id][u8 situação][corpo]`. Ops: 1 escrever a partir de um ponto, 2 substituir inteiro, 4 apagar, 6 pasta e espaço livre, 7 prova encerrada e salva. O id 0 é aviso do programa (troca de pasta).

**Fluxos confiáveis:** `event` (alertas, entregas, fim) e `rec` (gravação) têm numeração própria. O professor aceita só o próximo número e confirma; o aluno guarda em disco até a confirmação e reenvia ao reconectar. Alertas nunca esperam atrás de vídeo.

## 8. Segurança

Implementação em `shared/secure.ts` e `shared/policy.ts`, com testes em `shared/secure.test.ts`.

**Como o aluno entra:** só com o IP. O código da sala vem no `hi`, então não é segredo nesse modo. O que protege a entrada é a senha. Sem senha, quem alcança o IP entra, e o ECDH ainda impede a leitura passiva da rede.

**Aperto de mão**

1. Professor → aluno, em claro: `hi { v, code, salt, nonce, pub, password, signPub, sig }`, assinado com a chave ECDSA P-256 da sala.
2. Aluno deriva `roomKey = Argon2id(CÓDIGO + "\0" + senha, salt)`, com 64 MiB, 3 iterações, 1 de paralelismo, 32 bytes.
3. Aluno → professor, em claro: `key { pub }`.
4. Os dois derivam as chaves com ECDH P-256 efêmero e `HKDF(sal = roomKey, info = rótulo + nonce + pubs)`, uma AES-256-GCM por direção.
5. Tudo a partir daqui vai cifrado. O primeiro quadro é o `hello`. Se não abrir, código ou senha estão errados: `refused { password }` em claro e a conexão cai.

**Propriedades**

- A senha nunca trafega. O professor guarda só a chave derivada.
- O hub e quem estiver na rede veem só bytes opacos.
- Cada tentativa de senha custa um Argon2id para quem tenta. Por isso não há bloqueio global, que deixaria um colega impedir os outros de entrar.
- Quadro repetido, fora de ordem ou adulterado é rejeitado (contador no IV).
- **Quem é o professor:** todos da sala sabem a senha, então ela não prova isso. A chave de assinatura prova. O aluno verifica a assinatura, fixa a impressão digital na primeira conexão, e recusa outra chave depois (`impostor`). O painel e o aluno mostram o mesmo **Código do professor**, como `ABC-123`, para conferir com o quadro.
- **Limite conhecido:** na primeira conexão, um colega fazendo ARP spoofing pode se passar pelo professor com a própria chave. O aluno que não conferir o código não percebe. Esse é o risco que sobra, e é por isso que o código aparece grande no painel. Senha fraca também pode ser descoberta offline, ao custo do Argon2id por tentativa.

**Identidade:** no primeiro `hello` o professor entrega, pelo canal cifrado, um token de 256 bits e guarda só o SHA-256. Para reconectar, o aluno manda um HMAC da abertura daquela conexão, com o hash como chave. O token nunca volta pela rede, e a prova não serve em outra conexão. O `clientId` é público para o grupo e não dá acesso.

**Policy:** `shared/policy.ts` é a única tabela do que cada tipo de mensagem pode em cada estado, negando por padrão. `RateLimiter` limita por tipo. Entrega fora de hora é descartada, mas o número avança, para o aluno não travar.

**Hub:** `/ws/host` exige loopback e token. `/host-token` exige loopback e origem permitida (`HUB_ORIGINS`). Limite de conexões por IP, e um aluno abusivo cai sem levar o painel junto.

**Painel resistente a aluno adulterado:** qualquer erro ao tratar uma mensagem derruba só aquela conexão. Campos numéricos e de tipo enumerado são conferidos, e horários vêm do relógio do professor. Documento Yjs adulterado é ignorado no que não for texto, sem impedir as outras equipes de encerrar. Salvamento em ritmo fixo de 1 s, só das chaves que mudaram (`src/teacher/roomStore.ts`): o estático uma vez, cada documento de equipe quando muda, alunos, equipes e alertas em chaves próprias, tudo numa transação. A confirmação ao aluno só sai depois de salvo; se o salvamento falhar, ela espera a próxima volta. Um número de sequência pulado (painel recarregou antes de salvar) é aceito e fica visível na cadeia de hash, em vez de travar o fluxo. Fila de correção com uma entrada por equipe e questão, retomada ao recarregar. Cota de 2 GiB de gravação por aluno.

**Programa de aluno no professor (Testar, Rodar de reserva, correção):** é código hostil por definição, e desde a versão 2 o Testar manda o executável já montado pelo aluno, não o código. O que o nosso clang garantia passa a ser conferido antes de instanciar (`shared/wasm.ts`, parser próprio das seções): até 8 MB; só imports de funções `wasi_snapshot_preview1` que o shim oferece; nenhuma memória, tabela ou global importada; exatamente uma memória, com máximo declarado de até 256 MB, sem 64 bits e sem compartilhada; tabelas com máximo de até 100 mil; `_start` e `memory` exportados; sem seção `start`; segmentos de dados com deslocamento constante dentro da memória mínima; até 100 mil funções e 50 mil locais por função; LEB128 limitado a 5 bytes. Recusado não gasta o minuto, e a mensagem diz o motivo.

Todo programa de aluno roda num worker criado dentro de um iframe `sandbox="allow-scripts"` sem `allow-same-origin` (`src/compiler/sandbox.ts`), com CSP sem rede. Origem opaca: lá dentro não há IndexedDB, caches, OPFS, `localStorage`, cookies nem seletor de arquivos, e `fetch` e `importScripts` falham. É a defesa caso uma falha no shim da WASI desse JavaScript ao programa: o gabarito e as gravações do painel ficam fora de alcance. O iframe nasce de `srcdoc` e recebe o código do worker por mensagem, então funciona sem rede. O teste do harness confere tudo isso por dentro do sandbox.

Sem disco: o programa recebe só stdin, stdout e stderr em memória, nenhum diretório pré-aberto, nenhuma variável de ambiente e só `main` de argumento. `fopen`, `opendir` e `open` falham com erro da WASI e o programa segue. O compilador só enxerga a árvore virtual com os arquivos da resposta e os headers do toolchain: `#include` ou `#embed` de caminho absoluto ou subindo pastas não acha nada. Caminhos de arquivo passam por `validPath` (`shared/protocol.ts`): só `/` separa, até 3 pastas e 120 caracteres, cada nome com a regra de `FILE_NAME` (pasta sem extensão), sem `..`, `.`, nome vazio, barra invertida, letra de unidade nem nome reservado do Windows, e um nome não pode ser arquivo e pasta ao mesmo tempo. O compilador monta a árvore aninhada e deixa de fora qualquer caminho inválido; a WASI do clang não resolve `..`, então `#include` só alcança a própria pasta e as de dentro. Nada que o aluno manda vira caminho, URL ou script no professor. Testes em `src/compiler/wasi.test.ts` e `src/compiler/args.test.ts`.

Os limites de tempo cobrem o carregamento: até 30 s para compilar e instanciar o módulo (um módulo feito para demorar a compilar morre aí), e o limite do programa só conta do início dele. A saída para em 1 MB no worker e de novo no painel, que trata o que volta do sandbox como não confiável. Dos testes ocultos o aluno só recebe "N de M": nem saída, nem erro, nem tempo. No caminho do executável, o professor não devolve log de compilação nenhum.

**O que sobra:** o número de ocultos que passaram é um canal lateral (dá para testar hipóteses sobre a entrada, um bit por teste), limitado a 1 por minuto por equipe. Já existia com o código-fonte e não piora com o executável. A nota nunca usa o executável do aluno: a correção final compila no professor o código do documento da equipe.

**Riscos aceitos:** identidades descartáveis podem bater o ponto cedo para ler a prova no modo `clock-in`, e multiplicar o limite de testes. O professor vê cada entrada no painel. Quem exige início sincronizado deve usar o modo "Todos juntos".

**Pasta da prova (`host/src/files.rs`):** o que o programa escreve, onde e com quais garantias.

- **Onde:** só dentro da pasta escolhida pelo professor na tela do programa (padrão `Documentos/Oblita`, lembrada em `%APPDATA%/Oblita/host.json`). A rede nunca escolhe nem muda essa pasta. Tudo cai numa subpasta por prova, `<título> <data>`, que o programa cria com a marca `.oblita-sala`. Pasta sem a marca não é tocada, nem para escrever, nem para apagar.
- **O quê:** a estrutura da §14. Vídeo é acrescentado ao arquivo do segmento a cada pedaço; texto é substituído inteiro, gravando num temporário ao lado e renomeando, com `fsync` antes.
- **Só escrita:** nenhuma operação lê, lista, move ou devolve conteúdo de arquivo pela rede. Apagar vale só para arquivo dentro de sala marcada, e as pastas que ficam vazias somem junto.
- **Quem:** `/ws/files` exige loopback, o token do painel e a origem em `HUB_ORIGINS`.
- **Caminho:** só `/` separa, de 2 a 12 nomes, até 120 caracteres UTF-16 por nome e 400 no total. Recusa `..`, `.`, nome vazio, caminho absoluto, letra de unidade, UNC e `\\?\` (barra invertida, `:` e `?` são proibidos, o que também barra fluxo alternativo do NTFS), nome começando com ponto ou espaço, terminando com ponto ou espaço, nomes reservados do Windows (`CON`, `NUL`, `AUX`, `COM1`, `LPT9`, `COM¹`, `CONIN$`, também com extensão), caracteres de controle, invisíveis e de direção. Recusa em vez de corrigir: quem corrige é o painel, com `safeName` sobre nome do aluno, da equipe, dos arquivos de código e título da prova; a extensão do vídeo sai do mime e só pode ser `webm` ou `mp4`.
- **Links:** cada pasta do caminho é conferida sem seguir link; link, junção ou qualquer ponto de nova análise do Windows é recusado. Arquivo novo abre com `create_new`; o existente abre sem seguir link (`O_NOFOLLOW`, `FILE_FLAG_OPEN_REPARSE_POINT`). Depois de abrir, o programa confere pelo próprio arquivo aberto que o caminho real continua dentro da raiz e é o mesmo arquivo (no macOS e Linux, dispositivo e inode; no Windows, hora de criação e tamanho, porque a std estável não expõe o índice do arquivo). A raiz também é conferida a cada pedido: trocada por link ou apagada, para tudo.
- **Limites:** 2 GiB por arquivo, 32 MiB por pedido, 400 GiB e 50 000 arquivos por sala, e sempre 1 GiB livre no disco: a escrita que passaria disso é recusada. O uso da sala é recontado ao reabrir o programa.
- **Limite conhecido:** quem já escreve na pasta da prova com a conta do professor pode trocar uma pasta por junção entre a conferência e a abertura; a conferência pelo arquivo aberto pega o caso comum, mas no Windows ela é por hora de criação e tamanho, não por índice. Não há teste automático de junção (criar uma exige Windows e o CI não testa isso ainda); o teste de link simbólico roda no macOS e no Linux.

**Outras defesas:** saída de zip sanitizada contra `../` e nomes reservados do Windows. CSV neutraliza fórmulas. Enunciados e nomes só viram texto, nunca HTML. O CSP não está definido ainda (ver PLAN).

## 9. Vigilância

`src/student/proctor.ts`. Cada sinal gera alerta na hora, com miniatura. Sinais indicam, não provam: o professor decide olhando a gravação.

| Sinal | Como |
|---|---|
| Tela inteira | `getDisplayMedia` e checagem de `displaySurface === 'monitor'` depois de compartilhar |
| Parou de compartilhar | evento `ended` da trilha |
| Saiu da tela cheia | `fullscreenchange` |
| Saiu da aba ou janela | `visibilitychange`, `blur`, `hasFocus` a cada 1 s |
| DevTools encaixado | área útil menor que a tela, em tela cheia |
| DevTools aberto | `debugger` em worker descartável, detectando a pausa |
| Atalhos | F12, Ctrl+Shift+I/J/C e outros, bloqueados e alertados |
| Segundo monitor | `screen.isExtended` |
| Colar de fora | `paste` diferente do que foi copiado na prova |
| Internet voltou | testes a endereços públicos a cada 10 s |
| Sem sinal / desconectou | batimento a cada 2 s, alerta após 6 s |

**Sem depender de administrar as máquinas:** decisão do dono. Ninguém vai passar de PC em PC, então GPO não é parte do produto. O próprio sistema identifica o DevTools, a página fica travada em tela cheia, e sair dela avisa o professor na hora, com som. Onde a instituição já administrar as máquinas, `DeveloperToolsAvailability = 2` e o bloqueio de extensões por GPO são reforços opcionais. Extensão fica fora do nosso controle, e com a rede fechada o ganho de quem usa é pequeno.

**Por integrante:** em equipe, cada pessoa continua com vigia, alertas, gravação e estado próprios. O painel mostra por equipe quem está ativo e quem desfocou, ao vivo. Pedido explícito do dono.

**Estável:** todo batimento (2 s) leva o estado completo. O professor compara os estados e gera ele mesmo o alerta de transição, então um evento perdido não some.

**Selo visual (verificação pelo professor):** o único sinal que não depende da palavra do navegador do aluno.

1. A cada 3 s o professor envia ao aluno um código aleatório de 10 bits (`beacon`).
2. A página desenha o código num selo preto e branco fixo no canto superior direito da tela.
3. O aluno recorta essa região **da captura real da tela**, em resolução nativa, e envia em PNG.
4. O professor decodifica. Se o código não for nenhum dos últimos 3 enviados, e isso se repetir 2 vezes seguidas, gera `beacon-missing`, mesmo que o estado diga que está tudo certo.

Pega janela por cima, prova minimizada, captura congelada ou de outra coisa, e divergência entre o estado dito e a tela real. É um alerta, nunca bloqueia, porque uma falha de leitura não pode tirar alguém da prova.

**Honestidade sobre os limites:** "impossível de burlar" não existe numa página web, e o produto não deve prometer isso. Quem controla a própria máquina pode, com esforço real, falsificar a captura e o selo no navegador, usar máquina virtual, ou olhar um celular. **Não detectável por uma página:** celular, segunda pessoa, máquina virtual, placa de captura, extensões, janelas excluídas da captura e cliente adulterado. Compensações: selo visual, gravação, cadeia de hash nos alertas, e um fiscal na sala.

A prova só é enviada a quem já está pronto (tela, tela cheia, sem segundo monitor, rede isolada se exigida). Durante a prova, sair da tela cheia, segundo monitor e internet de volta cobrem o conteúdo com uma tela opaca até corrigir.

**Queda do compartilhamento de tela:** decisão do dono, "continua sem tela, não pode é crashar". Durante a prova ela não bloqueia nada: gera o alerta grave `share-ended` como antes, mostra um aviso fixo no rodapé com **Compartilhar de novo**, e para gravador, miniatura e selo sem erro. Ao compartilhar de novo, tudo volta, e a gravação continua no próximo número de segmento. Quem reconecta sem tela ainda recebe a prova, se já a tinha. O selo só conta falha de quem está com a tela ligada, então a queda não vira `beacon-missing` em série.

**Falhas no aluno:** nada pode deixar a sessão quebrada. Gravador que falha tenta de novo poucas vezes, espaçado. Disco cheio ou bloqueado: alertas e entregas ficam na memória e são reenviados ao reconectar, pedaços de gravação ficam na memória até 64 MB, e um aviso pede para não recarregar a página. Mensagem malformada do professor é ignorada. Conexão que cai no meio de um envio solta os botões presos e reenvia ao voltar.

## 10. Gravação

`src/student/recorder.ts`, `src/teacher/Player.tsx`.

- `MediaRecorder` em segmentos de 60 s, numa cópia da trilha reduzida para até 1280×720 e 5 quadros por segundo, com 250 kbps: no máximo ~110 MB por hora por aluno. A captura original continua em resolução nativa, porque o selo precisa dela. Cada segmento toca sozinho, e uma perda custa só um pedaço.
- O próximo segmento começa antes do anterior parar, então não há buraco.
- Guarda no disco do aluno, envia em pedaços de 3 s, e apaga quando o professor confirma.
- O professor só confirma o pedaço depois de gravado: na pasta da prova pelo programa ou, se o disco falhar, no IndexedDB. Se os dois falharem, não confirma, avisa no painel, e a conexão cai para o aluno reenviar dali. O trecho que caiu no navegador volta para o arquivo quando o segmento fecha e o disco responde.
- O painel avisa quando o espaço vai acabar: menos de 2 GB livres, ou menos de 30 min no ritmo atual. Confere ao criar a sala e a cada 30 s, pelo programa ou por `navigator.storage.estimate()`.
- O player não abre o que foi para a pasta, porque o programa não lê arquivos pela rede: o trecho se abre pela pasta.
- O player refaz o arquivo com `mediabunny`, sem recodificar, para a busca funcionar.
- Miniatura de 320 px a cada 3 s, em WebP quando o navegador gera (JPEG senão). Ao abrir um aluno, 1280 px a cada 1 s.
- Medido com `node tests/bandwidth/run.mjs` (Chrome capturando uma tela sintética de editor com digitação, 60 s): antes 716 KB por minuto por aluno (vídeo 570, miniatura 139, selo 7); depois 496 KB (vídeo 368, miniatura 121, selo 7), cerca de 31% a menos. Uma tela sintética pesa menos que o bitrate; tela que satura o bitrate cai pelo menos na proporção de 400 para 250 kbps.

## 11. Execução de código

`src/compiler/`, com `@yowasp/clang` e `@bjorn3/browser_wasi_shim`.

- **Rodar:** no navegador do aluno em WebAssembly. Se não der, cai para a máquina do professor, com limite de 1 a cada 5 s.
- **Testar:** o aluno compila aqui mesmo, como no Rodar, e manda só o executável. Erro de compilação aparece na hora e não gasta o minuto. O professor confere o executável (seção 8) e roda as amostras e os ocultos com os mesmos limites. Sem compilador no aluno, vai o código e o professor compila, como antes. 1 por minuto por pessoa ou grupo, e no máximo **um teste pendente por equipe**: o segundo é recusado ("já tem um teste na fila") sem gastar o minuto. O aluno vê a posição na fila. Vê os exemplos por completo e, dos testes ocultos, só "N de M".
- **Correção final:** sempre compila no professor, a partir do documento da equipe. O executável do aluno nunca vale nota.
- **Fila do professor** (`shared/jobs.ts`): a correção final passa na frente de testes e execuções. Vagas de execução: metade dos núcleos, de 1 a 4 (cada uma pode usar 256 MB). Compiladores: um quarto dos núcleos e um por 4 GB de memória, de 1 a 2, cada um com o próprio worker do clang (C++ com STL passa de meio GB). Um teste com executável pronto não espera atrás de quem precisa compilar.
- **Limites explícitos:** 256 MB de memória (`--max-memory`), 5 s, 1 MB de saída, compilação em até 60 s.
- Cada execução tem seu worker, encerrado no limite de tempo. No professor, ele nasce dentro do sandbox de origem opaca.
- **Limites do compilador:** sem exceções de C++. `try/catch` compila, mas um `throw` executado encerra com mensagem clara, inclusive `vector::at` e `stoi`. Recursão profunda estoura antes do nativo. Sem rede, threads e arquivos.

## 12. Andamento e tempo

Dois modos, escolhidos ao criar a sala. Quem controla e encerra é sempre o professor. O dono descartou o relógio por questão iniciado pelo aluno.

| Modo | Questões | Tempo |
|---|---|---|
| **Livre** | Todas liberadas de uma vez | Duração total. Início `clock-in` (cada um quando quiser) ou `global` (todos juntos). Encerra sozinho ao acabar |
| **Manual** | O professor libera e retira cada questão, ao vivo | O professor define o tempo de cada questão ao liberar (opcional), pode somar tempo e fechar antes. Sem relógio geral: acaba quando ele encerra |

**Regras do modo manual**

- Vale igual para toda a sala: liberar e retirar afeta todos juntos.
- **Revelação:** ao liberar, os alunos veem uma contagem de 3 s em tela inteira, com o dígito rolando como na tela de manutenção do juntos. O conteúdo só sai do professor quando ela acaba, então não dá para ler antes pelo DevTools, e o tempo da questão começa nesse instante. Depois o título aparece grande com o Dia text reveal (`src/ui/DiaTextReveal.tsx`, trazido do lawcore), voa até o lugar dele no enunciado, e o resto varre com o shimmer. Quem entra depois recebe a questão sem contagem.
- Questão não liberada nunca chega ao aluno: nem título, nem enunciado, nem exemplos, nem código inicial.
- O código inicial só entra no documento da equipe quando a questão é liberada.
- **Ao fechar uma questão** (tempo acabou ou o professor retirou), o professor congela a resposta naquele instante e corrige aquela versão. Edições posteriores são ignoradas. O CRDT não rejeita uma atualização por questão, então o congelamento é feito na entrega, no professor.
- Questão com o tempo esgotado fica visível e somente leitura. Questão retirada some da tela do aluno.
- Retirar e liberar de novo é permitido: a questão volta com o que já tinha, e a entrega é refeita ao fechar outra vez.
- O aluno que entra depois recebe o que estiver liberado naquele momento.

**Relógio:** sincronia estilo NTP com o professor a cada 15 s, ficando com a medida de menor atraso. Depois da primeira medida é monotônico, então mudar a hora do computador não dá tempo extra.

**Imagens:** o enunciado aceita imagem embutida em base64 (png, jpeg, webp, gif), e o montador reduz para até 1600 px. Endereço externo e SVG são recusados. Prova com até 12 MB.

## 13. Equipes e edição colaborativa

Decisão do dono, substituindo os grupos definidos pelo professor e a trava por questão.

**Equipes**

- Na sala em equipe, um aluno cria a equipe com um nome e recebe um **código privado**. Os colegas entram com esse código, até o máximo definido pelo professor.
- O código é gerado pelo professor e só vai para quem está na equipe. A lista de equipes enviada aos alunos nunca contém códigos.
- Dá para sair ou trocar de equipe até a prova ser liberada para ela. Depois disso, só o professor move alguém.
- Cada integrante tem a própria tela gravada e vigiada. A resposta, o relógio e a nota são da equipe.

**Edição**

- Yjs com `y-monaco`. O documento vive em todo mundo e no professor, e funciona também na prova individual, para o desfazer ser igual nos dois modos.
- Cada integrante vê os cursores e seleções dos outros. O nome inteiro aparece em cima do cursor enquanto o colega mexe; parado, fica só a inicial, para não cobrir a linha de cima. Pontinhos coloridos na aba da questão e na lista de arquivos mostram onde cada colega está.
- **Ctrl+Z / Cmd+Z** usa `Y.UndoManager`, que desfaz só o que a própria pessoa fez, sem apagar o que o colega escreveu. Refazer com Ctrl+Y e Ctrl+Shift+Z / Cmd+Shift+Z.
- Quem fica sem rede continua editando. Ao voltar, troca-se o vetor de estado e tudo se mescla, sem conflito.
- O professor semeia o código inicial. Os alunos nunca semeiam, senão dois integrantes duplicariam o texto.
- Criar, renomear e apagar arquivos e pastas também é compartilhado. Renomear copia o texto para a nova chave, e não entra no desfazer. Os arquivos ficam por caminho (`lib/util.h`) em `files:<questão>`; pasta vazia fica em `dirs:<questão>`. Renomear ou apagar pasta mexe em tudo de dentro numa transação, e quem estava num arquivo dela vai junto.
- A lista de arquivos é uma árvore (`src/student/FileExplorer.tsx`): pastas primeiro, ordem alfabética, recolhíveis, F2 ou duplo clique renomeia, Delete apaga com confirmação que diz quantos arquivos saem junto. O único arquivo de código não pode ser apagado, nem a pasta que tem todos. Header novo nasce com `#pragma once`.
- O professor guarda o documento da equipe e extrai dele o que vê, corrige e exporta.
- Múltipla escolha e texto continuam com a última edição valendo, porque não precisam de mescla.
- As mensagens de cursor passam só entre a equipe, e não são salvas.

## 14. Exportação

`src/teacher/layout.ts` define a estrutura, a mesma no zip e na pasta da prova. Com o programa, a pasta é gravada durante a prova: vídeo a cada pedaço, texto no máximo a cada 3 s quando muda, e o que sai da estrutura (como `sem-resposta.txt` de quem respondeu) é apagado. Quando a prova encerra, a correção termina e nada ficou no navegador, o painel e o programa mostram "Tudo salvo em <pasta>".

`src/teacher/exportZip.ts`: o zip, para o modo só navegador e para o que ficou no IndexedDB. Sem compressão, com ZIP64, gravado direto no disco. Sem a API de salvar em disco, vai sem vídeo.

```
<título>.zip  ou  <pasta escolhida>/<título> <data>/
  resumo.csv, prova.json
  alunos/<nome (matrícula)>/
    resumo.txt, alertas.csv, gravacao/0000.mp4
    q1/main.cpp, q1/lib/util.h, q1/nota.txt   (subpastas do aluno, cada nome pelo safeName)
  grupos/<grupo>/
    resumo.txt, q1/..., <integrante (matrícula)>/alertas.csv, .../gravacao/
```

## 15. Offline

`public/sw.js`, `scripts/postbuild.mjs`, `src/lib/offline.ts`. O service worker baixa tudo antes de instalar. O Workers limita cada arquivo a 25 MiB, então o compilador (72 MB) é publicado em gzip e aberto pelo service worker. Payload de cerca de 30 MB pela rede.

**Versão:** cada build tem um nome (data e commit curto) que aparece discreto no topo da página inicial, da prova e do painel (`<BuildVersion />`), junto do protocolo. O manifesto do precache guarda o nome e a `PROTOCOL_VERSION` de cada versão.

**Atualização segura:** a versão nova baixa em segundo plano. Fora de prova, a página inicial avisa e aplica ao recarregar. Durante a prova, a aba nunca recarrega sozinha: ao receber a prova, a página fixa a própria versão, e um F5 abre a mesma. O service worker guarda as duas últimas versões, a fixada e qualquer uma que uma aba aberta diga estar usando.

**Rebaixar ou subir para falar com o professor:** se o aluno for recusado com `version` e houver em cache uma versão com o protocolo do professor, a página fixa essa versão, recarrega nela e avisa. Durante a prova (o professor trocou de versão no meio), oferece a troca num aviso, com um clique. Sem versão compatível em cache, diz quem precisa atualizar. A fixação some quando o aluno sai da prova, e expira sozinha em 12 h.

**Execução isolada sem rede:** o sandbox do professor (seção 8) não baixa nada: o código do worker vai dentro do próprio pacote, então não há arquivo extra no precache.

## 16. Decisões em aberto

- Sugestões do editor hoje vêm de tabelas locais, não de análise semântica. clangd em WASM exige COOP/COEP e 2 GB iniciais, e precisa ser avaliado.
- Terminal com entrada interativa exige SharedArrayBuffer (COOP/COEP). Hoje a entrada é informada antes de rodar.
- Fallback HTTPS servido pelo próprio programa, para quem nunca baixou a página.

## 17. Fora de escopo

Identificar celular ou segunda pessoa. Servidor central de provas. Firefox e Safari, que não têm as APIs necessárias e são recusados.
