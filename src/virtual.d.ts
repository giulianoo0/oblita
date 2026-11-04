// Código do run.worker já empacotado num arquivo só, para o sandbox criar o worker sem baixar nada.
declare module 'virtual:run-worker' {
  const source: string
  export default source
}

// Versão deste build, definida no vite.config.ts.
declare const __BUILD__: { id: string; protocol: number }
