import { zipSync, strToU8 } from 'fflate'

self.onmessage = (event) => {
  try {
    const { output, files } = event.data
    if (!output || JSON.stringify(output).length > 500000 || !files || Object.keys(files).length > 3) throw new Error('Project export exceeds the size limit')
    const archive: Record<string, Uint8Array> = {
      'README.md': strToU8('# DunkAI project review archive\n\nUnverified engineering output. Review component identity, pin mapping, power, electrical behavior and manufacturing constraints before building. This archive is not fabrication approval.\n\nProject state: project.json\nPCB handoff: pcb-ir.json\nBOM: bom.csv\nFirmware: firmware/\nBoard previews: board/\n'),
      'project.json': strToU8(JSON.stringify(output, null, 2)),
    }
    if (output.pcb_ir) archive['pcb-ir.json'] = strToU8(JSON.stringify(output.pcb_ir, null, 2))
    const cell = (value: unknown) => { const text = String(value ?? ''); return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"` }
    const rows = Array.isArray(output.bom?.rows) ? output.bom.rows : []
    const columns = ['reference','component','manufacturer','mfr_part','package','lcsc','build_quantity','unit_price_usd','extended_price_usd','stock','price_checked_at','source_url','price_basis','status','status_reason']
    archive['bom.csv'] = strToU8([columns.map(cell).join(','), ...rows.map((row: Record<string, unknown>) => columns.map((column)=>cell(row[column])).join(','))].join('\r\n'))
    const sources = Array.isArray(output.code_generation?.files) ? output.code_generation.files : []
    if (sources.length > 16) throw new Error('Too many firmware files')
    for (const source of sources) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(source.filename) || typeof source.code !== 'string' || source.code.length > 100000) throw new Error('Invalid firmware filename or content')
      archive[`firmware/${source.filename}`] = strToU8(source.code)
    }
    for (const [name, content] of Object.entries(files)) {
      if (!['pcb.svg','schematic.svg','circuit.json'].includes(name) || typeof content !== 'string' || content.length > 700000) throw new Error('Invalid board export')
      archive[`board/${name}`] = strToU8(content)
    }
    const data = zipSync(archive, {level:6})
    self.postMessage({data:data.buffer}, {transfer:[data.buffer]})
  } catch (error) { self.postMessage({error:error instanceof Error?error.message:'Project export failed'}) }
  self.close()
}
