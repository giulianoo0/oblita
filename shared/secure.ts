// Canal cifrado de ponta a ponta entre aluno e professor. O hub e a rede só veem bytes opacos.
//
// A senha nunca trafega: os dois lados derivam a mesma chave com Argon2id(código + senha) e a
// usam como sal do HKDF sobre um ECDH efêmero. Senha errada não abre o primeiro quadro, e
// cada tentativa custa um Argon2id inteiro para quem está tentando.
import { argon2id } from 'hash-wasm'

const ARGON = { iterations: 3, parallelism: 1, memorySize: 64 * 1024, hashLength: 32 } as const
const INFO = 'oblita-canal-v1'
export const SEALED_TAG = 3
const IV_BYTES = 12
const TAG_BYTES = 16

export const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
export const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n))

export async function deriveRoomKey(roomCode: string, password: string, salt: Uint8Array) {
  return argon2id({ ...ARGON, password: `${roomCode.toUpperCase()}\0${password.normalize('NFKC')}`, salt, outputType: 'binary' })
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface Ephemeral {
  pair: CryptoKeyPair
  pub: Uint8Array<ArrayBuffer>
}

export async function newEphemeral(): Promise<Ephemeral> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  return { pair, pub: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) }
}

type Side = 'student' | 'teacher'

// Cifra e decifra em fila: a ordem dos quadros é parte do protocolo.
export class SecureChannel {
  private sendCounter = 0n
  private recvCounter = 0n
  private sendChain: Promise<unknown> = Promise.resolve()
  private recvChain: Promise<unknown> = Promise.resolve()

  private constructor(
    private sendKey: CryptoKey,
    private recvKey: CryptoKey,
    private sendDir: number,
  ) {}

  static async create(side: Side, mine: Ephemeral, theirPub: Uint8Array<ArrayBuffer>, roomKey: Uint8Array<ArrayBuffer>, nonce: Uint8Array<ArrayBuffer>, teacherPub: Uint8Array<ArrayBuffer>, studentPub: Uint8Array<ArrayBuffer>) {
    const peer = await crypto.subtle.importKey('raw', theirPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, mine.pair.privateKey, 256)
    const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
    const info = new Uint8Array([...new TextEncoder().encode(INFO), ...nonce, ...teacherPub, ...studentPub])
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: roomKey, info }, base, 512))
    const importAes = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    const toTeacher = await importAes(bits.slice(0, 32))
    const toStudent = await importAes(bits.slice(32))
    return side === 'student' ? new SecureChannel(toTeacher, toStudent, 1) : new SecureChannel(toStudent, toTeacher, 2)
  }

  private iv(dir: number, counter: bigint) {
    const iv = new Uint8Array(IV_BYTES)
    const view = new DataView(iv.buffer)
    view.setUint32(0, dir)
    view.setBigUint64(4, counter)
    return iv
  }

  seal(frame: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const counter = this.sendCounter++
    const job = this.sendChain.then(async () => {
      const iv = this.iv(this.sendDir, counter)
      const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.sendKey, frame))
      const out = new Uint8Array(1 + IV_BYTES + body.length)
      out[0] = SEALED_TAG
      out.set(iv, 1)
      out.set(body, 1 + IV_BYTES)
      return out
    })
    this.sendChain = job.catch(() => {})
    return job
  }

  // O contador tem de ser exatamente o próximo: quadro repetido ou fora de ordem é rejeitado.
  open(frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const job = this.recvChain.then(async () => {
      if (frame[0] !== SEALED_TAG || frame.length < 1 + IV_BYTES + TAG_BYTES) throw new Error('quadro sem cifra')
      const iv = frame.slice(1, 1 + IV_BYTES)
      const view = new DataView(iv.buffer)
      const dir = this.sendDir === 1 ? 2 : 1
      if (view.getUint32(0) !== dir || view.getBigUint64(4) !== this.recvCounter) throw new Error('quadro fora de ordem')
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.recvKey, frame.slice(1 + IV_BYTES))
      this.recvCounter++
      return new Uint8Array(plain)
    })
    this.recvChain = job.catch(() => {})
    return job
  }
}

// Todos da sala sabem a senha, então ela não prova quem é o professor. Esta chave prova:
// ele assina cada abertura, e o painel mostra a impressão digital para os alunos conferirem.
export interface TeacherIdentity {
  privateJwk: JsonWebKey
  publicRaw: string
}

const SIGN = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN_HASH = { name: 'ECDSA', hash: 'SHA-256' } as const
const FP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export async function newTeacherIdentity(): Promise<TeacherIdentity> {
  const pair = await crypto.subtle.generateKey(SIGN, true, ['sign', 'verify'])
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicRaw: toB64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
  }
}

export function helloTranscript(code: string, salt: string, nonce: string, pub: string) {
  return new TextEncoder().encode(`oblita-hi-v1|${code}|${salt}|${nonce}|${pub}`) as Uint8Array<ArrayBuffer>
}

export async function signHello(identity: TeacherIdentity, transcript: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey('jwk', identity.privateJwk, SIGN, false, ['sign'])
  return toB64(new Uint8Array(await crypto.subtle.sign(SIGN_HASH, key, transcript)))
}

export async function verifyHello(publicRaw: string, signature: string, transcript: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey('raw', fromB64(publicRaw), SIGN, false, ['verify'])
  return crypto.subtle.verify(SIGN_HASH, key, fromB64(signature), transcript)
}

export async function fingerprint(publicRaw: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64(publicRaw)))
  const chars = Array.from(digest.subarray(0, 6), (b) => FP_ALPHABET[b % FP_ALPHABET.length]).join('')
  return `${chars.slice(0, 3)}-${chars.slice(3)}`
}

// O token nunca volta pela rede: o aluno prova que o tem, preso a esta conexão.
async function hmacKey(tokenHash: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(tokenHash), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function tokenProof(tokenHash: string, transcript: Uint8Array<ArrayBuffer>) {
  return toB64(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(tokenHash), transcript)))
}

export async function verifyTokenProof(tokenHash: string, proof: string, transcript: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.verify('HMAC', await hmacKey(tokenHash), fromB64(proof), transcript)
}
