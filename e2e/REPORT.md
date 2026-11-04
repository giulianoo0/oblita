# Teste de ponta a ponta: relatório da parada

Interrompido a pedido do dono em 2026-11-03. **O teste nunca passou inteiro e nunca terminou com código 0.** Depois desta parada ele ainda não foi rodado de novo.

## Execuções

Todas em Edge 156 headless, com `--no-build`.

| Execução | Seções | Código da página | Resultado |
|---|---|---|---|
| 1 | 1 a 10 | antes da correção do `blur` | 111 ok, 13 falhas |
| 2 | 1 a 10 | antes da correção do `blur` | 123 ok, 7 falhas |
| 3 | só 1, 2, 3, 4 e 7 | com a correção do `blur` | 75 ok, 1 falha |

Na execução 1, várias falhas vieram de um erro na fixture do próprio teste (`20002` no lugar de `200027`), que fazia aparecer "Ocultos: 1 de 3". Corrigida, a execução 2 mostrou "2 de 3".

## Situação por passo

| Passo | Situação | Última execução | Observação |
|---|---|---|---|
| 1 Página inicial | passou | 3 | 8/8 |
| 2 Professor cria a sala | passou | 3 | 12/12 |
| 3 Alunos entram | passou | 3 | 16/16 |
| 4 Tela, rede e liberação | passou | 3 | 16/16 |
| 5 Colaboração | passou | 2 | 12/12, sem repetir depois da correção |
| 6 Terminal e Testar | passou | 2 | 10/10, sem repetir depois da correção |
| 7 Vigilância | falhou | 3 | 22/23 |
| 8 Resiliência | falhou | 2 | 12/17, sem repetir depois da correção |
| 9 Fim, notas, zip e player | falhou | 2 | 0/1. Zip e player **não chegaram a rodar** |
| 10 Segredo do gabarito | passou, com ressalva | 2 | 14/14, mas nessa execução a prova não foi encerrada |

Ressalva do passo 10: a execução 1 também deu 14/14 com a prova encerrada, mas nela as questões 2 e 3 não foram respondidas. A busca não incluiu OCR nas imagens capturadas.

## Falhas

Cada execução limpa `e2e/shots/`, então as fotos das execuções 1 e 2 não existem mais.

### Passo 7: aba escondida

- **Sintoma:** a página de Ana estava `hidden` e sem foco, mas "Saiu da aba" não chegou ao painel em 1500 ms.
- **Execução 3:** o alerta só apareceu 38972 ms depois, perto de a aba voltar. Enquanto isso, o painel registrou "Sem sinal" e "Prova fora da tela".
- **Execução 2:** não apareceu em 15 s.
- **Causa:** não encontrada. **O dono mandou deixar anotado e seguir em frente.**
- **Medido depois (`e2e/hidden-probe.mjs`):** numa página simples, com e sem janela, com e sem gravação, o aviso chegou em 2 a 3 s, a maior parte só para trocar de aba, e os timers continuaram. Então a hipótese de o navegador congelar a aba não se confirmou. A diferença está no app ou no teste, em algo que a sonda não reproduz, como o contexto isolado de navegador ou a emulação de foco.
- **Continua em aberto:** não se sabe se um aluno real teria esse atraso. Vale conferir no teste com janela, em dois computadores.

### Passo 8: F5 de Ana (execução 2)

- **Sintoma:** "Recarregou a página" não apareceu em 16 s. Ana recebeu `welcome` e depois `ack` do evento 29.

### Passo 8: depois de recarregar o painel (execução 2)

- **Sintoma:** o detalhe de Ana mostrou "Registro alterado": a cadeia de eventos quebrou.

### Passo 8: falhas em sequência (execução 2)

"Alerta novo depois de recarregar", "Conexão caiu" e "Reconectar" falharam logo depois. Provável efeito do teste ter ficado na tela de detalhe. Dedução pela ordem do código, não conferida em foto.

### Passo 8: hub caiu (execução 1)

O painel não reconectou sozinho em 9 s, e precisou de clique em "Reconectar". Depois da parada, o painel ganhou tentativa automática a cada 3 s, ainda não testada.

### Passo 8: mescla offline

"Editam sem conexão" passou na execução 2, mas a seção parou antes da mescla. **A mescla depois de reconectar não foi confirmada.**

### Passo 9

- **Execução 2:** "Encerrar" não foi encontrado, provavelmente pelo painel preso no detalhe. Não verificado.
- **Execução 1:** "Encerrar" e "Enviando zera" passaram. Notas e correção manual falharam, com respostas incompletas pelo erro da fixture.
- **Nunca confirmados:** notas corretas e correção manual.
- **Nunca rodaram:** zip, nome hostil no zip e busca no player.

## Análise depois da parada

Lendo o código, sem rodar de novo:

- **F5 perde alerta e quebra o registro (causa provável das duas falhas do F5, corrigida):** o aluno guarda o número e o hash do último evento no disco de forma assíncrona. Um F5 logo depois de um evento volta com valores antigos. O evento seguinte sai com um número que o professor já viu, é confirmado e descartado, e o hash não encadeia. Agora o `welcome` traz o último número e hash conhecidos, e o aluno continua a partir deles.
- **Painel recarregado acusava adulteração falsa (corrigida):** o professor salva a cada 1 s. Recarregando, podia ter um hash mais antigo que o do aluno. Agora a cadeia é reancorada depois de uma recarga do próprio painel.

## Defeitos corrigidos

- `src/student/proctor.ts`: o `blur` pegava a saída de foco de qualquer campo da página e gerava "Saiu da janela" falso. Agora só vale `e.target === window`. Antes eram 36 alertas no painel, 31 deles em Ana. Sem teste dedicado.

## Substituído no teste

- **`getDisplayMedia`:** trilha de canvas que desenha o selo da página. A chamada real em headless respondeu `monitor`, 800x600.
- **Janela recusada:** `getSettings` alterado para devolver `window`.
- **Parar de compartilhar:** `track.stop()` mais um evento `ended` sintético.
- **Colar e copiar:** `ClipboardEvent` sintético.
- **Hub:** porta 17787, com `fetch` e `WebSocket` do painel desviados só no teste, porque a 7787 estava ocupada. O caminho sem desvio não rodou.
- **`showSaveFilePicker`:** substituto escrito, nunca executado.
- **Foco:** emulado, exceto no teste da aba.

## Problemas visuais

Só uma foto foi olhada, `28-alertas.png` da execução 2, depois sobrescrita:

- Barra de rolagem horizontal na lista de alertas.
- Miniatura no ladrilho cortada à esquerda, com a trilha de teste. Causa não verificada.

A revisão de design não foi feita.

## Não testado

- `--visible` e `--slow` foram escritos e nunca executados.
- `e2e/run.mjs` ainda tem linhas de depuração (`depuração`, `visibilidade em Ana`, `dumpAlerts`) e a opção `--only`.
