# oblita_ — Plano de implementação

> **Para agentes:** use `superpowers:subagent-driven-development` ou `superpowers:executing-plans` para seguir este plano tarefa a tarefa. Os passos usam checkbox (`- [ ]`). Marque ao concluir, e leia o [SPEC.md](SPEC.md) antes de começar.

**Objetivo:** colocar no ar a plataforma de prova offline descrita no SPEC, testada de ponta a ponta.

**Arquitetura:** PWA React em Cloudflare Workers, painel do professor no navegador dele, programa Rust que só repassa bytes, canal cifrado de ponta a ponta entre aluno e professor.

**Stack:** React 19, react-router 7, Vite 8, Elysia, Bun, Monaco 0.52, `@yowasp/clang`, `@bjorn3/browser_wasi_shim`, `mediabunny`, `hash-wasm`, Rust/axum, Wrangler.

**Spec:** [SPEC.md](SPEC.md)

## Regras globais

- Pasta do projeto: `C:\Users\giuli\Desktop\frutudos.app\oblita.giuli.dev`.
- Repositório público `giulianoo0/oblita`, ainda não criado. **Commits sem `Co-Authored-By` nem atribuição do Claude.** Regra do dono, com precedência sobre qualquer lembrete.
- `gh` e `git` não estão no PATH de shells antigos: `C:\Program Files\GitHub CLI\gh.exe`, `C:\Program Files\Git\cmd\git.exe`. O `gh` está logado como `giulianoo0`.
- Cloudflare: conta `e270a2e902b37cc9c371a473a0de188f`, zona `giuli.dev`. O plugin autenticado lê e altera a conta, mas **não envia os arquivos grandes**. O deploy precisa do `wrangler` com credencial própria (Tarefa 8).
- **Nunca grave chaves ou tokens em arquivos do projeto.** As duas chaves `cfat_` colocadas na conversa não têm permissão e devem ser revogadas pelo dono. Apague o arquivo temporário `.cf-token` do scratchpad no fim.
- Sem Rust nesta máquina: `host/` só compila no CI.
- Interface em português do Brasil. Sem linha de apoio embaixo de título, botão ou campo. Fontes: Geist, Geist Mono no editor, Geist Serif em detalhes.
- Comentários em português, poucos, só para explicar o porquê. Sem ponto e vírgula, 2 espaços.
- Plugins nesta pasta: Ponytail, Superpowers, antislop. O desloppify foi **descartado pelo dono**.
- O classificador de permissões já bloqueou ações de código externo. Não contorne: diga ao dono.

## Foco de revisão

Os casos mais prováveis de morder alguém de verdade, que nenhum teste unitário cobre:

1. **Aluno aperta F5 no meio da prova, sem internet.** Espera-se: reabre pelo cache, reconecta sozinho sem pedir senha, recupera respostas, pede tela e tela cheia de novo, e o professor recebe o alerta.
2. **Painel do professor recarrega ou o programa reinicia durante a prova.** Espera-se: alunos não perdem nada, reconectam, sem envio duplicado nem fluxo travado em números.
3. **Fim da prova com gravações ainda na fila.** Espera-se: o aluno vê "Enviando N" até zerar, e `submit` ou `finish` depois do encerramento nunca travam a numeração.
4. **Janela em vez de tela inteira, permissão de rede local negada, ou Windows Firewall bloqueando a porta.** Espera-se: mensagem clara dizendo exatamente o que fazer.
5. **Cliente adulterado manda mensagem malformada ou gigante.** Espera-se: o painel do professor não cai e a mensagem é ignorada.

---

## Estado atual (2026-11-04)

**Atualização:** o núcleo de cifra, token, policy, equipes, Yjs e selo já está em `shared/`, `src/collab/`, `src/student/session.ts` e `src/teacher/room.ts`, com 30 testes passando. As Tarefas 1, 1B (passos 1 a 7) e 1C (passos 1 a 4) estão feitas no núcleo. Dois subagents ligam as telas: aluno (`CodeWorkspace`, `ExamPage`, `collabEditor.ts`) e professor (`NewRoom`, `Dashboard`, `StudentDetail`, `exportZip`). A Tarefa 2 está com o subagent do professor. O aluno entra só com o IP: o código da sala vem no `hi`.

**Publicado:** https://oblita.giuli.dev está no ar (Worker `oblita`, domínio próprio). `node e2e/prod.mjs` passa 24 de 24: site, embeds, sinalização em produção e o caminho do aluno com o domínio inacessível (abre pelo cache, alcança o hub pelo IP, compilador carrega). Faltando: a permissão de rede local foi concedida por script, então o pedido real ao usuário ainda não foi visto. `navigator.storage.persist()` volta falso em origem nova, então o cache pode ser despejado se o disco lotar. Publicar de novo: `npx vite build --outDir dist-deploy --emptyOutDir`, `node scripts/postbuild.mjs dist-deploy`, `npx wrangler deploy --assets dist-deploy`. O `wrangler` está logado por OAuth nesta máquina, com escopo amplo: o dono pode rodar `npx wrangler logout` no fim.

Concluído e sem execução completa no navegador até agora:

- `shared/`: formatos, quadros, protocolo, cifra e policy. **15 testes passando** (`bun test shared`).
- `src/teacher/`: motor da sala com aperto de mão, token, policy, prova única e `holdTab`; painel, detalhe, player e zip.
- `src/net/`, `src/compiler/`, `src/student/proctor.ts`, `recorder.ts`.
- `src/pages/Home.tsx`: nova página inicial, ainda não vista em execução.
- `public/`, `scripts/`, `worker/`, `wrangler.jsonc`: service worker, logo, embeds, Durable Object.
- `host/` e `.github/workflows/host.yml`: **nunca compilados**. O `smoke.ps1` só passou contra um mock em Node.

Em andamento em subagents: telas do aluno e do professor, e **testes de WASM** (`ac23fe7e1497e8d0c`, em `tests/` e `src/compiler/`).

Se o contexto for compactado antes de eles voltarem, os resultados chegam como notificação. Se não chegarem, confira com `ListAgents` e olhe os arquivos.

Bloqueio conhecido: enquanto as telas não forem ligadas ao núcleo novo, o projeto não compila.

---

### Tarefa 1: Canal cifrado no aluno

Só comece depois que o subagent da tela do aluno terminar, porque ele também mexe em `session.ts`.

**Arquivos:** modificar `src/student/session.ts`.

**Interfaces**
- Consome: `SecureChannel`, `deriveRoomKey`, `newEphemeral`, `fromB64`, `toB64` de `shared/secure.ts`; `TeacherPlain`, `StudentPlain` de `shared/protocol.ts`.
- Produz: `begin(via, roomCode, name, enrollment?, groupId?, password?)`. A tela já chama com essa assinatura.

- [ ] **Passo 1:** guardar em `Saved`: `roomKey?: string` (base64), `roomSalt?: string`, `token?: string`. Tirar `roomCode` do `hello`, mantendo em `Saved`.
- [ ] **Passo 2:** em `onFrame`, decodificar antes do canal. Se a tag for 1, tratar só `hi` e `refused`. Em `hi`: gerar efêmera, usar `roomKey` salva se `roomSalt === salt`, senão derivar com `deriveRoomKey(roomCode, password, salt)`; salvar; enviar `{ t: 'key', pub }` em claro; criar o canal com `SecureChannel.create('student', eph, teacherPub, roomKey, nonce, teacherPub, eph.pub)`; enviar o `hello` cifrado.
- [ ] **Passo 3:** todo envio passa por `channel.seal`, e toda recepção com tag 3 por `channel.open`, mantendo a ordem. Aplicar em `send`, `pumpRec` e `sendFrame`. Antes do canal, nada é enviado. Recepção que falha derruba o link.
- [ ] **Passo 4:** `refused` com `password`: limpar `roomKey`, `closing = true`, manter o formulário. Não apagar respostas.
- [ ] **Passo 5:** `welcome.token`: salvar em `saved.token`, e enviar no `hello` seguinte.
- [ ] **Passo 6:** tirar `attach → sendHello`: agora o `hello` só sai depois do `hi`.
- [ ] **Passo 7:** derivar a chave no clique de entrar, para mostrar "Entrando…" em vez de travar.
- [ ] **Verificação:** `npx tsc -p . --noEmit` sem erros em `session.ts`.

### Tarefa 1B: Equipes com código e edição colaborativa

Ver SPEC, seção 13. Depende do subagent da tela do aluno ter terminado. Substitui `lock`, `lock-state` e `choose-group` no protocolo, na policy, em `room.ts`, `session.ts` e na tela.

**Arquivos**
- Criar: `src/collab/examDoc.ts`, `src/collab/examDoc.test.ts`, `src/student/collabEditor.ts`.
- Modificar: `shared/protocol.ts`, `shared/policy.ts`, `src/teacher/room.ts`, `src/teacher/NewRoom.tsx`, `src/teacher/exportZip.ts`, `src/student/session.ts`, `src/student/ExamPage.tsx`, `src/student/CodeWorkspace.tsx`, `vite.config.ts`.

**Interfaces**
- `ExamDoc`: `doc: Y.Doc`, `files(questionId): Y.Map<Y.Text>`, `lang(questionId)`, `seed(questionId, lang, fileName, content)`, `snapshot(questionId): { type: 'code', lang, files }`, `addFile`, `renameFile`, `removeFile`.
- Mensagens binárias, nos dois sentidos: `y-sync` (vetor de estado), `y-update`, `y-aware`.
- Equipe: `team-create { name }`, `team-join { code }`, `team-leave`; resposta `team { groupId, name, code, members } | null`, e `team-error { reason }`.

- [ ] **Passo 1:** apelidar `monaco-editor` para `monaco-editor/esm/vs/editor/editor.api` em `vite.config.ts`, porque o `y-monaco` importa o pacote inteiro.
- [ ] **Passo 2:** escrever os testes de `ExamDoc`: dois documentos com edições concorrentes convergem, `UndoManager` só desfaz a origem local, e `snapshot` reflete os arquivos.
- [ ] **Passo 3:** implementar `ExamDoc`. Rodar `bun test src/collab`. Esperado: passam.
- [ ] **Passo 4:** professor: `room.teamDoc(team)`, semente no momento em que a equipe recebe a prova, repasse de update e cursor para os outros integrantes, extração para `team.answers` a cada 500 ms, persistência em base64 no snapshot.
- [ ] **Passo 5:** professor: equipes criadas pelos alunos, `teamCodes` fora de `config`, `config.maxTeamSize`. O campo `config.groups` passa a crescer em tempo real, sem código, e `NewRoom` troca a lista de grupos pelo máximo por equipe.
- [ ] **Passo 6:** policy: `y-sync`, `y-update`, `y-aware` só em prova. `team-*` só em modo equipe, sem prova liberada, e sem fase encerrada. `team-join` com limite baixo por conexão. Update até 512 KiB, e update inválido derruba a conexão.
- [ ] **Passo 7:** aluno: um `ExamDoc` por sessão, salvo em `saved.docState` a cada 1 s, com troca de vetor de estado ao receber `welcome`. Rodar e Testar usam `snapshot`.
- [ ] **Passo 8:** `collabEditor.ts`: um `MonacoBinding` e um `Y.UndoManager` por arquivo, mantidos vivos ao trocar de arquivo; `addCommand` para Ctrl+Z, Ctrl+Y e Ctrl+Shift+Z; `Awareness` com nome e cor; folha de estilo com `.yRemoteSelection-<id>` e `.yRemoteSelectionHead-<id>::after { content: "<nome>" }`, escapando o nome.
- [ ] **Passo 9:** tela: passo "Criar equipe / Entrar com código" antes da tela cheia, código visível para copiar, lista de integrantes, e sair da equipe.
- [ ] **Passo 10:** Tarefa 4 ganha: dois alunos na mesma equipe editam ao mesmo tempo e convergem; o Ctrl+Z de um não apaga o texto do outro; o cursor do colega aparece com o nome; um fica offline, edita, volta, e tudo se mescla; código errado é recusado; equipe cheia é recusada.

### Tarefa 1C: Vigia estável por integrante e selo visual

Ver SPEC, seção 9.

**Arquivos**
- Criar: `shared/beacon.ts`, `shared/beacon.test.ts`.
- Modificar: `shared/protocol.ts`, `shared/policy.ts`, `src/teacher/room.ts`, `src/teacher/Dashboard.tsx`, `src/student/session.ts`, `src/student/ExamPage.tsx`.

**Interfaces**
- `beaconCells(code): boolean[][]`, com 7 colunas e 2 linhas, cantos fixos para sincronia e 10 bits de dados.
- `decodeBeacon(read: (col, row) => number): number | null`.
- `BEACON = { cols: 7, rows: 2, cellVw: 1 }`.
- Mensagens: `beacon { code }` do professor; `beacon-frame` binário (PNG) do aluno; `beat { at, status }`.
- Novo alerta: `beacon-missing`, severo.

- [ ] **Passo 1:** testes: toda célula de todos os 1024 códigos faz ida e volta, ruído leve decodifica igual, imagem sem selo devolve `null`.
- [ ] **Passo 2:** implementar `shared/beacon.ts`. Rodar `bun test shared`.
- [ ] **Passo 3:** professor: `onBeat` compara com o último estado e gera `focus-lost`, `fullscreen-exit`, `share-ended` quando o evento do aluno não chegou. Sem duplicar quando ele chegar, usando janela de 2 s.
- [ ] **Passo 4:** professor: enviar `beacon` a cada 3 s para quem está em prova, guardar os 3 últimos, decodificar `beacon-frame` em canvas, 2 falhas seguidas geram `beacon-missing`. Só depois de 1 decodificação bem-sucedida, ou 15 s, para não alertar no início.
- [ ] **Passo 5:** aluno: componente `Beacon` fixo no canto superior direito, com `position: fixed`, células de `1vw`, preto e branco puros, sem animação. Recorte da região na `FrameGrabber`, mapeando a escala da tela para o vídeo.
- [ ] **Passo 6:** painel: `Dashboard` mostra por equipe cada integrante com um ponto de estado e o rótulo "desfocado", e chip "selo ausente" no ladrilho.
- [ ] **Passo 7:** E2E: enviar um PNG falso ou nenhum, e ver `beacon-missing`; adulterar `status` para sempre ok e ver o selo acusar.
- [ ] **Validação real (dono):** medir falso positivo do selo com escala de tela de 125% e 150% no Windows e em 1366×768.

### Tarefa 2: Sala com senha e prova única

**Arquivos:** modificar `src/teacher/NewRoom.tsx`, `src/teacher/Dashboard.tsx`.

**Interfaces:** consome `Room.create(config, exam, solutions, password)`, `activeRoom()`, `room.holdTab()`, `room.hasPassword`.

- [ ] **Passo 1:** em `NewRoom`, campo "Senha da sala (opcional)" com `type=password` e `autoComplete="new-password"`. Passar para `Room.create`, sem guardar em nenhum outro lugar.
- [ ] **Passo 2:** ao abrir `NewRoom`, chamar `activeRoom()`. Se houver, mostrar a prova aberta com o botão "Abrir", e sem formulário.
- [ ] **Passo 3:** trocar o rótulo "Compilador para os alunos" por "Botão Testar para os alunos". O campo continua `config.compiler`. O Rodar é sempre disponível.
- [ ] **Passo 4:** em `Dashboard`, chamar `room.holdTab()` ao carregar. Se `false`, mostrar "Esta sala está aberta em outra aba" sem conectar.
- [ ] **Passo 5:** mostrar no cartão de conexão: IP, código da sala, e um ícone de cadeado se `room.hasPassword`.
- [ ] **Verificação:** criar sala com senha, tentar criar outra e ver o bloqueio, abrir em duas abas e ver a mensagem.

### Tarefa 3: Integrar e compilar

**Arquivos:** `tsconfig.json`, o que os erros apontarem.

- [ ] **Passo 1:** integrar o relatório dos subagents de aluno e de WASM, incluindo os flags recomendados.
- [ ] **Passo 2:** corrigir `Countdown` em `src/ui/kit.tsx`, que recebe `ms` fixo e congela: aceitar função.
- [ ] **Passo 3:** rodar `npx tsc -p . --noEmit` e `npx tsc -p worker`. Esperado: zero erros.
- [ ] **Passo 4:** rodar `npm run build`. Esperado: `dist/` com `precache.json`, `llvm.core-*.wasm.gz`, e nenhum arquivo acima de 25 MiB.
- [ ] **Passo 5:** rodar `npx wrangler deploy --dry-run --outdir .wrangler/dry`. Esperado: Worker empacota com Elysia e Durable Object.
- [ ] **Passo 6:** conferir na página o `/llms.txt`, a imagem de compartilhamento e a logo em Geist Serif.

### Tarefa 4: Teste de ponta a ponta

Teste automatizado do Foco de Revisão no navegador real, para não depender de teste manual.

**Arquivos:** criar `e2e/run.mjs`.

**Base:** CDP puro com Edge headless, igual a `tests/run-wasm.mjs`. Edge: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. Flags: `--use-fake-ui-for-media-stream`, `--auto-select-desktop-capture-source="Entire screen"`. Permissões com `Browser.setPermission` usando `local-network` e `loopback-network`. Contextos isolados com `Target.createBrowserContext`. Simular rede isolada com `Network.setBlockedURLs` nos endereços de `PROBES`. Servidor: `bun server/index.ts --hub`, servindo `dist/` em `localhost:3000` e hub em `7787`. Cliques com `Runtime.evaluate` e `userGesture: true`.

- [ ] **Passo 1:** professor cria sala com senha, conecta no hub.
- [ ] **Passo 2:** 2 alunos entram pelo IP da rede local. Senha errada: `refused`. Senha certa: entram.
- [ ] **Passo 3:** confirmar por captura do tráfego no hub que o enunciado **não** aparece em claro. Confirmar que a prova não contém campos de gabarito no aluno.
- [ ] **Passo 4:** bater ponto, editar, rodar em WASM, testar: segundo teste em menos de 60 s é limitado.
- [ ] **Passo 5:** alertas: `exitFullscreen`, blur, atalho F12. Professor recebe em menos de 1 s.
- [ ] **Passo 6:** F5 no aluno: reconecta sem senha e recupera respostas.
- [ ] **Passo 7:** F5 no painel: alunos continuam, sem perder numeração.
- [ ] **Passo 8:** rejeitar outro `clientId` com token errado.
- [ ] **Passo 9:** encerrar, confirmar notas e fila zerada, exportar zip, conferir o zip com `Expand-Archive`. Nome malicioso `../../x` fica dentro da pasta.
- [ ] **Passo 10:** tocar a gravação e buscar no meio. Se a captura em headless não funcionar, rodar com janela visível.
- [ ] **Verificação:** `node e2e/run.mjs` termina com código 0.

### Tarefa 5: Testes de WASM

- [ ] **Passo 1:** receber o relatório do subagent, e revisar os casos marcados como `knownLimit`.
- [ ] **Passo 2:** refletir no `public/llms.txt` e no SPEC os limites reais que afetam o aluno.
- [ ] **Verificação:** `node tests/run-wasm.mjs` termina com código 0.

### Tarefa 6: Revisão fina

**Referências:** `skills/ponytail-review/SKILL.md` e `skills/antislop-code/SKILL.md`, nos caches de plugin em `~/.claude/plugins/cache/`.

- [ ] **Passo 1:** revisão de correção e segurança por subagent novo, sem ver as conclusões anteriores, em `shared/`, `src/teacher/room.ts`, `src/student/session.ts`, `host/src/main.rs`.
- [ ] **Passo 2:** corrigir o que for confirmado, e repetir os testes.
- [ ] **Passo 3:** limpar comentários que só repetem o código, seguindo `antislop-code`, sem tocar em lógica.
- [ ] **Passo 4:** organizar: `src/student/session.ts` e `src/teacher/room.ts` têm centenas de linhas, então dividir por responsabilidade só onde a fronteira for clara. Apagar `scripts/try-clang.mjs` se os testes o cobrirem. Tirar `home-mock` do CSS, e `@elysiajs/static` se não for usado.
- [ ] **Passo 5:** definir `Content-Security-Policy` em `public/_headers`: `default-src 'self'`, `connect-src` com `http:` e `ws:` para IP local, `worker-src 'self' blob:`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' blob: data:`, `media-src blob:`, `script-src 'self' 'wasm-unsafe-eval'`. Confirmar que Monaco e o compilador seguem funcionando.
- [ ] **Verificação:** todos os testes passam depois da limpeza.

### Tarefa 7: Repositório e CI do programa

- [ ] **Passo 1:** conferir com `git status` que não há segredo, e procurar por `cfat_` no projeto. Esperado: nenhuma ocorrência.
- [ ] **Passo 2:** `git init -b main`, identidade local só do repositório (`giulianoo0`, e-mail noreply do GitHub). Commit sem co-autor.
- [ ] **Passo 3:** `gh repo create giulianoo0/oblita --public --source . --push`.
- [ ] **Passo 4:** acompanhar o CI do `host.yml`. Corrigir erros de compilação do Rust até passar, incluindo o smoke test real.
- [ ] **Passo 5:** commitar o `Cargo.lock` gerado pelo CI.
- [ ] **Passo 6:** confirmar que o link de download em `Dashboard` (`/releases/latest/download/oblita-host.exe`) baixa o arquivo sem login. Baixar e rodar nesta máquina contra o painel: é o único teste real do Rust.

### Tarefa 8: Deploy

Falta credencial. Pergunte ao dono qual prefere, e não crie token sem ele pedir:

1. Ele roda `npx wrangler login` no próprio terminal, autorizando no navegador.
2. Ele gera uma chave com **Conta → Workers Scripts: Editar** e **Zona `giuli.dev` → Zone: Ler, DNS: Editar, Workers Routes: Editar**.
3. Com autorização explícita dele, criar pelo plugin um token temporário com só essas permissões, com validade de um dia.

- [ ] **Passo 1:** `npm run deploy`. Esperado: Worker `oblita` no ar, e domínio personalizado `oblita.giuli.dev` criado.
- [ ] **Passo 2:** `curl https://oblita.giuli.dev/healthz` retorna `ok`. `curl -I` em `/sw.js` tem `Cache-Control: no-cache`.
- [ ] **Passo 3:** abrir em navegador real e conferir "Baixado neste computador".
- [ ] **Passo 4:** repetir o fluxo com a origem real: o modo só navegador pelo `/signal` em produção, e o aluno pelo IP.
- [ ] **Passo 5:** conferir o embed do link com um validador de OpenGraph.
- [ ] **Passo 6:** apagar `.cf-token` do scratchpad, e lembrar o dono de revogar as chaves da conversa.

### Tarefa 9: Validação no mundo real

Só o dono consegue fazer isso, com outras máquinas.

- [ ] Dois computadores reais num roteador sem saída para a internet, Chrome estável, com o programa rodando.
- [ ] Rede de verdade da faculdade: isolamento de clientes e firewall.
- [ ] Confirmar o texto do pedido de permissão de rede local, e se ele aparece uma vez só.
- [ ] Testar a abertura real do DevTools encaixado e solto, com a tela de cada aluno, para medir falsos positivos.
- [ ] Testar Alt+Tab em tela cheia no Windows com Keyboard Lock.
- [ ] Medir a compilação de C++ num notebook fraco, e 40 alunos no mural.

## Depois do lançamento, se fizer sentido

- Sugestões semânticas com clangd em WASM (exige COOP/COEP e 2 GB iniciais).
- Terminal interativo com `cin` em tempo real (exige SharedArrayBuffer).
- Exceções de C++ com build próprio do compilador (wasi-sdk 33 ou mais novo).
- WebTransport para cifra sem depender do `ws://`, que o Chrome marca como obsoleto em HTTPS.
- Fallback HTTPS servido pelo programa, para quem nunca baixou a página.
- Reconexão do modo só navegador, hoje impossível depois de um F5 sem internet.
