#!/usr/bin/env bun
// Usage: bun scripts/import-idol-bbq.ts <path-to-idol-bbq-config.yaml> [out.yaml]
import { readFileSync, writeFileSync } from 'fs'
import { parse } from 'yaml'
import { convertIdolBbqConfig } from '../src/import/idol-bbq'
import { dumpConfigYaml } from '../src/config/yaml'

const [input, output] = process.argv.slice(2)
if (!input) {
  console.error('usage: bun scripts/import-idol-bbq.ts <idol-bbq config.yaml> [out.yaml]')
  process.exit(1)
}

const oldConfig = parse(readFileSync(input, 'utf8'))
const converted = convertIdolBbqConfig(oldConfig)
const warnings: string[] = (converted as any).warnings ?? []
delete (converted as any).warnings

const text = dumpConfigYaml(converted)
if (output) {
  writeFileSync(output, text)
  console.log(`written: ${output}`)
} else {
  process.stdout.write(text)
}
for (const warning of warnings) console.error(`warning: ${warning}`)
