export type SkillFrontmatter = {
  description: string | null
  name: string | null
  present: boolean
}

export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  if (lines[0]?.trim() !== '---') {
    return { description: null, name: null, present: false }
  }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end === -1) return { description: null, name: null, present: false }

  const values = new Map<string, string>()
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    const match = /^([a-zA-Z][\w-]*):\s*(.*)$/u.exec(line)
    if (!match) continue
    const key = match[1]
    const rawValue = match[2]
    if (key === undefined || rawValue === undefined) continue

    if ((rawValue === '|' || rawValue === '>') && index + 1 < end) {
      const block: string[] = []
      while (index + 1 < end) {
        const next = lines[index + 1]
        if (next === undefined || !/^\s+/u.test(next)) break
        index += 1
        block.push(next.trim())
      }
      values.set(key, block.join(rawValue === '>' ? ' ' : '\n').trim())
      continue
    }

    values.set(key, unquote(rawValue.trim()))
  }

  return {
    description: nonEmpty(values.get('description')),
    name: nonEmpty(values.get('name')),
    present: true,
  }
}

function nonEmpty(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null
}

function unquote(value: string) {
  const first = value[0]
  const last = value.at(-1)
  return value.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))
    ? value.slice(1, -1)
    : value
}
