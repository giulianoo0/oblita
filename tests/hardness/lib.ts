// Reúne o que os testes de dureza precisam de shared/. É empacotado por build.mjs (esbuild)
// num lib.mjs que o Node 24 importa, porque shared/ usa sintaxe de TS (parameter properties,
// enums) que o modo "strip-only" do Node não aceita.
export { encodeJson, encodeBinary, decodeFrame, deflate, inflate, deflateFrame, inflateFrame, DEFLATE_TAG, COMPRESS_MIN, HubOp, encodeHub, decodeHub } from '../../shared/frames'
export {
  SecureChannel,
  deriveRoomKey,
  newEphemeral,
  newTeacherIdentity,
  signHello,
  verifyHello,
  helloTranscript,
  fingerprint,
  sha256Hex,
  tokenProof,
  verifyTokenProof,
  toB64,
  fromB64,
  randomBytes,
  SEALED_TAG,
} from '../../shared/secure'
export { checkStudentWasm, WASM_LIMITS, WASI_FUNCTIONS } from '../../shared/wasm'
export { RateLimiter, isAllowed } from '../../shared/policy'
export { PROTOCOL_VERSION, MAX_INFLATED_TO_TEACHER, MAX_INFLATED_TO_STUDENT } from '../../shared/protocol'
