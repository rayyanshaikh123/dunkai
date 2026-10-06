import { z } from 'zod'

const file = z.object({ filename: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.(ino|cpp|c|h|hpp|py|json|md)$/), code: z.string().max(12000), description: z.string().max(240).default('Updated source'), language: z.string().max(30).optional(), category: z.string().max(30).default('firmware') })
const result = z.object({ reply: z.string().min(1).max(2000), updated_files: z.array(file).max(5) })
let started = false
self.onmessage = (event) => {
  try {
    if (event.data.type === 'start' && !started) {
      started = true
      const { files, request, target } = event.data
      if (!Array.isArray(files) || files.length > 16 || typeof request !== 'string' || request.length > 1000) throw new Error('The code revision request is too large')
      const sources = files.map((item) => file.parse(item))
      const prompt = `Review this firmware and apply the requested changes. Return JSON {reply,updated_files:[{filename,code,description,language,category}]}. Return complete replacement files only for changed files. Target ${String(target).slice(0,120)}. Use Arduino core/Wire/SPI or MicroPython built-ins for that target, no shell commands or external downloads. Keep actuator outputs off at boot. Explain unimplemented requests. Do not claim tested hardware. Limit output to 2048 tokens.\nSource files: ${JSON.stringify(sources)}\nRequest: ${request}`
      if (prompt.length > 6000) throw new Error('These files exceed the model context limit. Use the editor or revise a smaller project.')
      self.postMessage({ type: 'inference', prompt })
    } else if (event.data.type === 'answer' && started) {
      const parsed = result.parse(JSON.parse(event.data.content))
      if (new Set(parsed.updated_files.map((item) => item.filename)).size !== parsed.updated_files.length) throw new Error('Duplicate revised filenames')
      self.postMessage({ type: 'complete', result: { ...parsed, updated_files: parsed.updated_files.map((item) => ({ ...item, language: item.language || (item.filename.endsWith('.py') ? 'python' : item.filename.endsWith('.md') ? 'text' : 'cpp') })) } })
      self.close()
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Code revision failed' })
    self.close()
  }
}
