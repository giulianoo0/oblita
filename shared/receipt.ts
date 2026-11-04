// Comprovante de entrega: o professor assina o que recebeu, e o aluno guarda a prova disso.
// O checksum é reproduzível sem o Oblita: é o SHA-256 da lista no formato do sha256sum, feita com
// o conteúdo dos arquivos que a exportação grava (SPEC §14).
import type { Answer } from './protocol'
import { fingerprint, fromB64, randomBytes, sha256Hex, signHello, toB64, verifyHello, type TeacherIdentity } from './secure'

export type ReceiptFile = [path: string, sha256: string]

export interface ReceiptBody {
  v: 1
  id: string
  roomId: string
  title: string
  name: string
  enrollment?: string
  team?: string
  at: number
  files: ReceiptFile[]
  checksum: string
  // Último elo da cadeia de eventos do aluno: amarra o histórico de alertas a esta entrega.
  events?: string
}

// `body` vai como texto: a assinatura vale para estes bytes exatos, sem depender de como o JSON é refeito.
export interface Receipt {
  body: string
  sig: string
  signPub: string
}

export interface OpenedReceipt {
  receipt: Receipt
  body: ReceiptBody
  fp: string
}

const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
// Separa do aperto de mão, assinado com a mesma chave: nada que o aluno escreva vira um "hi" válido.
const SIGNED_PREFIX = 'oblita-comprovante-v1|'
const BLOCK_BEGIN = '-----INICIO COMPROVANTE OBLITA-----'
const BLOCK_END = '-----FIM COMPROVANTE OBLITA-----'

const signedBytes = (body: string) => new TextEncoder().encode(SIGNED_PREFIX + body) as Uint8Array<ArrayBuffer>

export function answerFiles(answer: Answer): [string, string][] {
  if (answer.type === 'code') return Object.entries(answer.files)
  if (answer.type === 'text') return [['resposta.txt', answer.text]]
  return [['resposta.txt', answer.selected.join(', ') + '\n']]
}

export async function hashFiles(answers: Record<string, Answer | undefined>): Promise<ReceiptFile[]> {
  const files: ReceiptFile[] = []
  for (const [questionId, answer] of Object.entries(answers)) {
    if (!answer) continue
    for (const [name, content] of answerFiles(answer)) files.push([`${questionId}/${name}`, await sha256Hex(content)])
  }
  return files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

export const manifestOf = (files: ReceiptFile[]) => files.map(([path, hash]) => `${hash}  ${path}\n`).join('')
export const checksumOf = (files: ReceiptFile[]) => sha256Hex(manifestOf(files))

export function newReceiptId() {
  const chars = Array.from(randomBytes(12), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`
}

export async function issueReceipt(identity: TeacherIdentity, fields: Omit<ReceiptBody, 'v' | 'id' | 'checksum'>): Promise<Receipt> {
  const body = JSON.stringify({ v: 1, id: newReceiptId(), ...fields, checksum: await checksumOf(fields.files) } satisfies ReceiptBody)
  return { body, sig: await signHello(identity, signedBytes(body)), signPub: identity.publicRaw }
}

// Null para assinatura errada ou checksum que não fecha com a lista. Quem chamou ainda confere
// se `fp` é o código do professor que ele conhece: a assinatura sozinha só diz que alguém assinou.
export async function openReceipt(receipt: Receipt): Promise<OpenedReceipt | null> {
  try {
    if (!(await verifyHello(receipt.signPub, receipt.sig, signedBytes(receipt.body)))) return null
    const body = JSON.parse(receipt.body) as ReceiptBody
    if (body.v !== 1 || !Array.isArray(body.files) || (await checksumOf(body.files)) !== body.checksum) return null
    return { receipt, body, fp: await fingerprint(receipt.signPub) }
  } catch {
    return null
  }
}

// Só para leitura: os nomes vêm do aluno, e uma quebra de linha forjaria linhas do comprovante.
const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')

export const parseBody = (receipt: Receipt) => JSON.parse(receipt.body) as ReceiptBody

export function receiptText(receipt: Receipt, fp: string) {
  const body = parseBody(receipt)
  const armored = toB64(new TextEncoder().encode(JSON.stringify(receipt)))
  return [
    'Comprovante de entrega oblita_',
    '',
    `ID da entrega:      ${body.id}`,
    `Checksum (SHA-256): ${body.checksum}`,
    `Prova:              ${oneLine(body.title)}`,
    `Aluno:              ${oneLine(body.name)}${body.enrollment ? ` (${oneLine(body.enrollment)})` : ''}`,
    ...(body.team ? [`Equipe:             ${oneLine(body.team)}`] : []),
    `Recebido em:        ${new Date(body.at).toLocaleString('pt-BR')}`,
    `Código do professor: ${fp}`,
    '',
    'Arquivos recebidos (formato do sha256sum). O checksum é o SHA-256 destas linhas:',
    ...(body.files.length ? body.files.map(([path, hash]) => `${hash}  ${oneLine(path)}`) : ['(nenhuma resposta)']),
    '',
    'Assinatura do professor. Cole este bloco em Conferir, no painel, para validar:',
    BLOCK_BEGIN,
    ...(armored.match(/.{1,76}/g) ?? []),
    BLOCK_END,
    '',
  ].join('\n')
}

export function parseReceiptBlock(text: string): Receipt | null {
  const start = text.indexOf(BLOCK_BEGIN)
  const end = text.indexOf(BLOCK_END)
  if (start < 0 || end < start) return null
  try {
    const armored = text.slice(start + BLOCK_BEGIN.length, end).replace(/\s+/g, '')
    const parsed = JSON.parse(new TextDecoder().decode(fromB64(armored))) as Receipt
    return typeof parsed.body === 'string' && typeof parsed.sig === 'string' && typeof parsed.signPub === 'string' ? parsed : null
  } catch {
    return null
  }
}
