// O mesmo hub do server/, em porta própria, para quando outra cópia já estiver na 7787.
import { createHub } from '../../server/hub'

const port = Number(process.argv[2])
const token = process.argv[3] ?? crypto.randomUUID()
createHub(token).listen({ hostname: '0.0.0.0', port })
console.log(`hub de teste na porta ${port}`)
