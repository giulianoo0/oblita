// A prova e o gabarito do teste. Os marcadores só existem no gabarito: se aparecerem no aluno, vazou.
export const MARK = {
  stdin: 'HIDDEN_IN_MARK_Z9',
  stdout: 'HIDDEN_OUT_MARK_K4',
  reference: 'REFERENCE_MARK_Q7',
  rubric: 'RUBRIC_MARK_W2',
  // Entrada e saída numéricas do teste oculto: um vazamento parcial também aparece.
  number: '1073519642',
  sum: '1073719669',
}

export const STATEMENT = 'ENUNCIADO_PUBLICO_Q1'

export const exam = {
  version: 1,
  title: 'Prova E2E de Algoritmos',
  durationMin: 90,
  questions: [
    {
      id: 'q1',
      type: 'code',
      title: 'Soma de dois inteiros',
      statement: `${STATEMENT}: leia dois inteiros da entrada e imprima a soma deles.`,
      points: 3,
      languages: ['c', 'cpp'],
      samples: [{ stdin: '2 3\n', stdout: '5\n' }],
    },
    {
      id: 'q2',
      type: 'choice',
      title: 'Complexidade',
      statement: 'Qual é a complexidade da busca binária?',
      points: 1,
      options: [
        { id: 'a', text: 'Linear' },
        { id: 'b', text: 'Logarítmica' },
      ],
    },
    {
      id: 'q3',
      type: 'text',
      title: 'Pilha',
      statement: 'Explique o que é uma pilha.',
      points: 2,
    },
  ],
}

export const solutions = {
  version: 1,
  solutions: [
    {
      questionId: 'q1',
      type: 'code',
      reference: { lang: 'c', code: `// ${MARK.reference}\n#include <stdio.h>\nint main(void) { int a, b; scanf("%d %d", &a, &b); printf("%d\\n", a + b); return 0; }\n` },
      tests: [
        { stdin: '40 2\n', stdout: '42\n', points: 1 },
        { stdin: `${MARK.number} 20002 ${MARK.stdin}\n`, stdout: `${MARK.sum}\n`, points: 1 },
        // Falha sempre: é o que prova que o aluno vê N de M, e não só "passou".
        { stdin: '1 1\n', stdout: `${MARK.stdout}\n`, points: 1 },
      ],
    },
    { questionId: 'q2', type: 'choice', correct: ['b'] },
    { questionId: 'q3', type: 'text', rubric: `${MARK.rubric}: estrutura LIFO.` },
  ],
}

export const HEADER = '#define SOMA(a, b) ((a) + (b))\n'

export const PROGRAM = [
  '#include <stdio.h>',
  '#include "util.h"',
  '',
  'int main(void) {',
  '    int a, b;',
  '    if (scanf("%d %d", &a, &b) != 2) return 1;',
  '    printf("%d\\n", SOMA(a, b));',
  '    return 0;',
  '}',
  '',
].join('\n')

export const BROKEN = '#include <stdio.h>\n\nint main(void) {\n    printf("sem ponto e virgula")\n    return 0;\n}\n'

export const LOOP = '#include <stdio.h>\n\nint main(void) {\n    while (1) {}\n    return 0;\n}\n'
