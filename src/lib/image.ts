// Reduz a imagem antes de embutir: a prova inteira viaja numa só mensagem.
const MAX_SIDE = 1600
const QUALITY = 0.85

export async function imageToMarkdown(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const url = canvas.toDataURL('image/webp', QUALITY)
  const alt = file.name.replace(/\.[^.]+$/, '').replace(/[[\]()]/g, ' ')
  return `![${alt}](${url})`
}
