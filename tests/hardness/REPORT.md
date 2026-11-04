# Testes de dureza do Oblita

Ataques e carga contra o hub real em Rust (host/), numa subnet sem acesso a internet. Branch dureza (a partir de escala-e-ui).

## Ambiente

- Laboratorio: admin@arch (12 nucleos, 15 GB RAM), podman rootless.
- Imagem localhost/oblita-lab (rust:1-bookworm + chromium + node 24 + python3 + iproute2/netcat; usuario lab, WORKDIR /work).
- Rede oblita-lab-net (--internal, 10.89.77.0/24): sem saida, confirmado dentro dos containers do teste: net:OFFLINE dns:NODNS ip:NOIP (IP, DNS e HTTPS falham).
- O build (cargo --release/--offline e npm ci) roda num container na rede padrao do podman (internet so para baixar dependencias); os ataques rodam na rede interna, offline.
- Container de carga: oblita-lab-hub (--init, rede interna). Os testes de disco/abuso/recuperacao/wasm rodam em containers efemeros podman run --rm (cada um com seu proprio loopback).
- Nada fora de ~/oblita-lab foi tocado; containers criados tem prefixo oblita-lab- e sao removidos ao fim.

Por que hub + alunos + painel no mesmo container: /ws/host, /ws/files e /host-token exigem loopback. O painel simulado fala por 127.0.0.1, entao divide o container com o hub; os alunos conectam em 127.0.0.1 (contam como um IP so, e exatamente o caso NAT). O caso "de fora do loopback" usa o IP de eth0 (10.89.77.x) da subnet interna.

## Como rodar

Da raiz do repo, dentro de um container na rede interna (-v .../src:/work -w /work, HOME=/tmp):

    node tests/hardness/build.mjs        # empacota shared/ -> tests/hardness/lib.mjs (esbuild)
    node tests/hardness/smoke-flow.mjs   # fluxo completo de ponta a ponta (sanidade)
    node tests/hardness/abuse.mjs        # abuso de rede/acesso
    node tests/hardness/disk.mjs         # /ws/files (sobe o proprio hub)
    node tests/hardness/wasm.mjs         # dureza do validador de wasm
    node tests/hardness/recovery.mjs     # queda/recuperacao (sobe o proprio hub)
    node tests/hardness/load.mjs --students=100 --minutes=12   # carga

load.mjs espera um hub ja no ar na porta 7787 do mesmo container (os demais sobem o hub sozinhos). O lado aluno e o lado painel do protocolo estao em net.mjs, reusando shared/ de verdade (handshake ECDH + Argon2id, quadros AES-GCM, compressao, policy, validador de wasm).

Verificacao cruzada (tambem rodada na arch, nunca no Mac do usuario): cargo test (18 ok), cargo test --offline, tsc -b (limpo), bun test shared/ e2e/hub.test.ts (89 ok), bun test shared/wasm.test.ts (25 ok).

## Numeros de carga (100 alunos, 12 min)

Video sintetico 250-400 kbps por aluno (pedacos de 3 s), miniatura a cada 3 s, Yjs digitando a cada ~1 s, beat a cada 2 s, Testar com wasm ~1/s alternando valido/invalido.

| Metrica | Valor |
|---|---|
| RSS maximo do hub | 46,5 MiB (40,4 aos 30 s, plano a partir de 2 min) |
| RSS final | 46,5 MiB |
| CPU medio / maximo do hub | 3,3% / 4,0% de 1 nucleo |
| Latencia event->ack (ida e volta) p50 | 4,7 ms (35 900 amostras) |
| Latencia p99 | 59,3 ms (inclui cifra e fila do simulador, nao so o hub) |
| Latencia maxima | 110 ms |
| Video repassado | 2,73 GiB em 12 min (~3,9 MiB/s) |
| Alunos conectados ao longo do teste | 100 estaveis |
| Testes (wasm) processados | 719 (576 ok, 143 invalidos recusados) |

RSS sobe de 40 para 46 MiB nos 2 primeiros minutos (buffers do tokio e das filas aquecendo) e fica plano nos 10 minutos seguintes: nada cresce sem limite. O hub so repassa bytes; as filas de envio sao limitadas (STUDENT_QUEUE_BYTES 64 MiB, HOST_QUEUE_BYTES 256 MiB, IP_SHARE_BYTES 32 MiB por IP) e devolvem os bytes ao sair da fila (Charge/Drop).

Painel/aluno lento: um painel que faz o upgrade e nao le, com um aluno despejando video a toda: o aluno e derrubado assim que sua parte da fila do painel passa de 32 MiB (IP_SHARE_BYTES), o hub continua de pe e o RSS pico fica em 43,5 MiB. O painel nunca cai por excesso de dados.

## Achados e consertos

### 1. Teto por IP nao cabia uma sala atras de NAT (corrigido)

MAX_PER_IP = 16 derrubava alunos quando a sala inteira vinha de um mesmo IP (NAT). Reproducao: 100 alunos do mesmo IP -> 16 entravam, 84 recusados. Contraria o requisito do dono (salas atras de NAT funcionam, ate 100 alunos), ja que alunos atras de um mesmo NAT contam como um IP so no hub.

Conserto: MAX_PER_IP = 128 (host/src/main.rs). Cabe a sala (ate ~100), segue abaixo do teto global de 512, e a memoria por IP ja e limitada a parte por IP_SHARE_BYTES (32 MiB). Teste que falhava antes e passa depois: e2e/hub-rust.test.ts e tests/hardness/abuse.mjs. host/README.md atualizado.

## Tabela de ataques

Legenda: OK = comportou-se como esperado (defesa funcionou).

### Abuso de rede/acesso (abuse.mjs) - 19/19

| Ataque | Esperado | Observado | Passou |
|---|---|---|---|
| /host-token origem errada | 403 | 403 | OK |
| /host-token sem origem | 403 | 403 | OK |
| /ws/host token errado | recusado | 403 | OK |
| /ws/host sem token | recusado | 403 | OK |
| /ws/files token errado | recusado | 403 | OK |
| /ws/files origem errada | recusado | 403 | OK |
| /ws/files sem origem | recusado | 403 | OK |
| /ws/host de fora do loopback (eth0) | recusado | 403 | OK |
| /ws/files de fora do loopback (eth0) | recusado | 403 | OK |
| /ws/student de fora do loopback | 101 (aluno da LAN entra) | 101 | OK |
| Quadro > 8 MiB aluno->hub | so essa conexao cai; hub de pe | conexao fechada, hub vivo | OK |
| Bomba de descompressao (tag 4, infla > 9 MiB) | painel rejeita, sem OOM | rejeitado, Node/painel vivos | OK |
| Compressao aninhada (tag 4 dentro de tag 4) | rejeitada | conexao cai, hub vivo | OK |
| Tag desconhecida (apos decifrar) | conexao cai | conexao cai, hub vivo | OK |
| Replay de quadro cifrado | rejeitado (contador fora de ordem) | rejeitado, conexao cai | OK |
| Aluno fingindo enquadramento de painel | tratado como quadro comum | hub vivo | OK |
| 300 handshakes invalidos (Argon2 no atacante) | custo ~zero de CPU no hub | dCPU < 0,2 s no hub | OK |
| Slowloris: 400 conexoes pre-upgrade paradas | /ping responde, aluno legitimo entra | ping ok, aluno entra, dRSS ~5 MiB | OK |
| 100 alunos do mesmo IP (NAT) | 100 entram e recebem welcome | 100/100 (apos conserto) | OK |

Notas:
- Argon2 em massa: o hub nao faz Argon2, so repassa bytes. O custo do Argon2id e do atacante. O painel so faz 1 assinatura ECDSA barata por conexao nova. 300 handshakes invalidos custam < 0,2 s de CPU ao hub.
- Peer id falsificado / falar como professor: o conn e atribuido pelo hub; o aluno so fala no proprio socket e nao injeta no conn de outro nem assume o papel do painel (exige loopback + token em /ws/host).

### Quadros truncados / fora de ordem

Um quadro truncado ou fora de ordem nao abre no SecureChannel (contador no IV) e derruba so aquela conexao; uma tag inesperada faz o decodeFrame lancar e o painel descarta a conexao. Verificados em abuse.mjs (replay, tag desconhecida) e em shared/secure.test.ts / shared/frames.test.ts.

### Disco - /ws/files (disk.mjs 7/7 + host cargo tests 18/18)

| Ataque | Esperado | Observado | Passou |
|---|---|---|---|
| Escrita valida dentro da sala | status 0 | 0 | OK |
| Path traversal (22 formas: ../, absoluto, backslash, UNC, \\?\, :stream, ::$DATA, CON/aux/com1, NUL, unicode RTL/zero-width, ponto/espaco inicial/final, .oblita-sala) | todas recusadas | 22/22 recusadas, nada fora da raiz | OK |
| Symlink plantado na pasta (sala->fora) | escrita recusada, alvo externo intacto | recusada, alvo intacto | OK |
| Escrita concorrente de 60 arquivos | todas gravam, sem corromper | 60/60, hub vivo | OK |
| write_at idempotente (reenvio do mesmo pedaco) | sem duplicar | conteudo correto | OK |

Cobertos por cargo test (host/src/files.rs): limites por arquivo/sala/arquivos, reserva de disco livre, symlink multiplataforma (unix), pasta sem a marca .oblita-sala intocada, raiz trocada por link no meio.

Nao da para testar aqui: encher 82 GB de disco de verdade (cota e reserva sao exercidas com free_space injetado no teste de cargo limits_stop_before_the_disk_fills); juncao do Windows (CI e laboratorio sao Linux).

### Sandbox / wasm (wasm.mjs 7/7 + shared/wasm.test.ts 25/25)

O validador (shared/wasm.ts) le so a estrutura das secoes e nao executa o programa.

| Ataque | Esperado | Observado | Passou |
|---|---|---|---|
| Imports proibidos (env, WASI fora da lista, memoria/tabela/global/tag importadas) | recusado | recusado | OK |
| Memoria sem maximo / compartilhada / 64-bit / > 256 MB | recusado | recusado | OK |
| Secoes malformadas / fora de ordem / repetidas / tamanho mentido | recusado | recusado | OK |
| LEB128 > 5 bytes | recusado | recusado | OK |
| Secao start | recusado | recusado | OK |
| Funcoes/locais/tabelas demais; dados fora da memoria | recusado | recusado | OK |
| Laco infinito (estrutura valida) | aceita estrutura < 1 ms (laco e limite de runtime) | ok, 0,09 ms | OK |
| Recursao profunda (estrutura valida) | aceita estrutura, < 1 ms | ok, 0,05 ms | OK |
| Secao declara 1e9 funcoes / 1e9 exports | recusado sem iterar (nao trava) | recusado, < 0,1 ms | OK |
| Executavel > 8 MB | recusado por tamanho | recusado, < 0,1 ms | OK |

O validador nao e travavel por logica do programa nem por contagens mentidas. Limites de runtime (laco infinito, saida gigante, recursao) sao do worker no sandbox de iframe allow-scripts sem rede (browser, src/compiler/sandbox.ts): 5 s, 1 MB de saida, 256 MB de memoria, fora do escopo do hub.

Nao testado nesta rodada: o sandbox de iframe no chromium headless (a imagem tem chromium, mas o harness existente tests/run-wasm.mjs e feito para o Edge no Windows). O isolamento do iframe e coberto pelo harness do navegador do repo.

### Recuperacao (recovery.mjs 7/7)

| Cenario | Esperado | Observado | Passou |
|---|---|---|---|
| Painel cai: alunos continuam conectados no hub | 10 mantidos | 10 durante e depois | OK |
| Painel reconecta: hub reapresenta todos os alunos | 10 OP_OPEN + re-welcome | 10/10 | OK |
| Hub encerra limpo no SIGTERM | sem panico | sem panico no log | OK |
| Hub morto (SIGKILL): sockets dos alunos caem | todos detectam | todos | OK |
| Hub ressuscita: alunos reconectam e retomam (token) | 10 de volta, resumidos | 10/10 resumidos | OK |
| Rede de um aluno cortada: reconecta e reenvia | welcome aceito, sessao retomada | ok | OK |
| Dado confirmado nao regride; reenvio sem perda/duplicata | lastRec monotonico ate 3 | retomou em 2, final 3 | OK |

Nada crashou. O hub e sem estado de prova: mata-lo e subi-lo nao perde dado confirmado (o que o painel ja confirmou/salvou), e o protocolo retransmite o pendente ao reconectar.

## Resumo

- 1 achado, corrigido: teto por IP de 16 -> 128, para salas atras de NAT funcionarem.
- Todo o resto das defesas do hub e do protocolo se comportou como a SPEC descreve, sob carga e sob abuso, numa rede sem internet.
