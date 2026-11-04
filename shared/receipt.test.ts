import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { checksumOf, hashFiles, issueReceipt, manifestOf, openReceipt, parseBody, parseReceiptBlock, receiptText } from './receipt'
import { fingerprint, newTeacherIdentity } from './secure'
import type { Answer } from './protocol'

const answers: Record<string, Answer> = {
  q2: { type: 'text', text: 'ação\n' },
  q1: { type: 'code', lang: 'c', files: { 'main.c': 'int main(){}\n', 'lib/util.h': '#pragma once\n' } },
  q3: { type: 'choice', selected: ['a', 'b'] },
}
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const fields = async () => ({ roomId: 'r1', title: 'Prova', name: 'Ana', at: 1000, files: await hashFiles(answers) })

describe('comprovante', () => {
  test('a lista é a do sha256sum, em ordem, e dá para refazer fora do Oblita', async () => {
    const files = await hashFiles(answers)
    expect(files.map(([path]) => path)).toEqual(['q1/lib/util.h', 'q1/main.c', 'q2/resposta.txt', 'q3/resposta.txt'])
    expect(files[1][1]).toBe(sha('int main(){}\n'))
    expect(files[3][1]).toBe(sha('a, b\n'))
    expect(manifestOf(files).split('\n')[1]).toBe(`${sha('int main(){}\n')}  q1/main.c`)
    expect(await checksumOf(files)).toBe(sha(manifestOf(files)))
  })

  test('o checksum muda com um byte, e não com a ordem das questões', async () => {
    const base = await checksumOf(await hashFiles(answers))
    const shuffled = await checksumOf(await hashFiles({ q3: answers.q3, q1: answers.q1, q2: answers.q2 }))
    expect(shuffled).toBe(base)
    const changed = await checksumOf(await hashFiles({ ...answers, q2: { type: 'text', text: 'ação ' } }))
    expect(changed).not.toBe(base)
  })

  test('sem resposta também tem comprovante, com a lista vazia', async () => {
    const identity = await newTeacherIdentity()
    const opened = await openReceipt(await issueReceipt(identity, { ...(await fields()), files: [] }))
    expect(opened?.body.files).toEqual([])
    expect(opened?.body.checksum).toBe(sha(''))
  })

  test('assinatura válida abre, e diz de quem é', async () => {
    const identity = await newTeacherIdentity()
    const opened = await openReceipt(await issueReceipt(identity, await fields()))
    expect(opened?.fp).toBe(await fingerprint(identity.publicRaw))
    expect(opened?.body.id).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  })

  test('cada comprovante tem um ID próprio', async () => {
    const identity = await newTeacherIdentity()
    const a = parseBody(await issueReceipt(identity, await fields()))
    const b = parseBody(await issueReceipt(identity, await fields()))
    expect(a.id).not.toBe(b.id)
    expect(a.checksum).toBe(b.checksum)
  })

  test('alterar qualquer coisa invalida', async () => {
    const identity = await newTeacherIdentity()
    const receipt = await issueReceipt(identity, await fields())
    expect(await openReceipt({ ...receipt, body: receipt.body.replace('"Ana"', '"Bia"') })).toBeNull()
    // Forjar exige a chave: assinar outra coisa com outra chave não fica com o código do professor.
    const other = await issueReceipt(await newTeacherIdentity(), await fields())
    expect((await openReceipt(other))?.fp).not.toBe(await fingerprint(identity.publicRaw))
    expect(await openReceipt({ ...receipt, signPub: other.signPub })).toBeNull()
    expect(await openReceipt({ ...receipt, sig: 'lixo' })).toBeNull()
  })

  test('lista que não fecha com o checksum é recusada mesmo com assinatura boa', async () => {
    const identity = await newTeacherIdentity()
    const receipt = await issueReceipt(identity, await fields())
    const body = { ...parseBody(receipt), checksum: sha('outra coisa') }
    const { signHello } = await import('./secure')
    const text = JSON.stringify(body)
    const sig = await signHello(identity, new TextEncoder().encode(`oblita-comprovante-v1|${text}`) as Uint8Array<ArrayBuffer>)
    expect(await openReceipt({ body: text, sig, signPub: receipt.signPub })).toBeNull()
  })

  test('o texto baixado volta a ser o comprovante, e um nome não forja linhas', async () => {
    const identity = await newTeacherIdentity()
    const receipt = await issueReceipt(identity, { ...(await fields()), name: 'Ana\nID da entrega: FALSO' })
    const text = receiptText(receipt, 'H8A-NRA')
    expect(text).not.toContain('\nID da entrega: FALSO')
    expect(text).toContain('H8A-NRA')
    expect(parseReceiptBlock(`bom dia\r\n${text.replace(/\n/g, '\r\n')}`)).toEqual(receipt)
    expect(parseReceiptBlock('sem bloco nenhum')).toBeNull()
  })
})
