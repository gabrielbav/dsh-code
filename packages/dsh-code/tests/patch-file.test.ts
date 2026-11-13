import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

const root = new URL('..', import.meta.url)
const text = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
const exportsMap = (JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { exports: Record<string, unknown> }).exports

interface Row { id?: string; name?: string; config?: unknown }

function rows(value: unknown): Row[] {
  if (Array.isArray(value)) return value.flatMap(rows)
  if (value === null || typeof value !== 'object') return []
  const row = value as Row & Record<string, unknown>
  return [...typeof row.name === 'string' ? [row] : [], ...Object.values(row).flatMap(rows)]
}

describe('cordis.patch.yml', () => {
  const parsed = load(text)
  const all = rows(parsed)

  it('parses, and every row of this bundle names an export of the package', () => {
    const own = all.filter(r => r.name?.startsWith('@gabrielbav/dsh-code'))
    expect(own.length).toBeGreaterThan(3)
    for (const row of own) {
      const sub = row.name === '@gabrielbav/dsh-code' ? '.' : `.${row.name!.slice('@gabrielbav/dsh-code'.length)}`
      expect(exportsMap[sub], row.name).toBeDefined()
    }
  })

  it('gives the Code preset the network tool and a persona that names the refusal symptoms', () => {
    expect(all.some(r => r.id === 'code-network-tool')).toBe(true)
    const persona = all.find(r => r.id === 'persona')?.config as { prefix?: string } | undefined
    expect(persona?.prefix).toContain('request_network_access')
    expect(persona?.prefix).toContain('CONNECT tunnel failed, response 403')
    expect(persona?.prefix).toContain('never opens: everything still runs')
  })
})
