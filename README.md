# oblita_

provas online de código sem cola.

Prova de C e C++ que roda sem internet: o aluno abre a página já baixada, digita o IP do professor e faz a prova em tela cheia, com a tela gravada. Tudo fica no computador do professor.

- Site: https://oblita.giuli.dev
- Programa do professor: [última versão](https://github.com/giulianoo0/oblita/releases/latest/download/oblita-host.exe)
- Formato das provas: [`public/llms.txt`](public/llms.txt)
- Especificação: [`SPEC.md`](SPEC.md), andamento: [`PLAN.md`](PLAN.md)

## Desenvolvimento

```bash
npm install
npm run build
npx bun server/index.ts --hub
```

```bash
npx bun test shared src/collab e2e/hub.test.ts
```

Publicar: `npm run deploy`.
