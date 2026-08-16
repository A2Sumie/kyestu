import { parse, stringify } from 'yaml'
import { compileConfig, type KyestuConfig } from './schema'
import type { EntryDef } from '../loader/loader'

export function parseConfigYaml(text: string): KyestuConfig {
  const config = parse(text) as KyestuConfig
  if (!config || typeof config !== 'object') throw new Error('config file is empty or invalid')
  return config
}

export function loadConfigYaml(text: string): EntryDef[] {
  return compileConfig(parseConfigYaml(text))
}

export function dumpConfigYaml(config: KyestuConfig): string {
  return stringify(config, { indent: 2, lineWidth: 120 })
}
