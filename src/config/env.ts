export function resolveEnvStrings(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('env:')) {
    // an unset env: ref must not fall through as a guessable literal secret/url
    const resolved = process.env[value.slice(4)]
    return resolved === undefined || resolved === '' ? undefined : resolved
  }
  if (Array.isArray(value)) return value.map(resolveEnvStrings)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [k, resolveEnvStrings(v)])
        .filter(([, v]) => v !== undefined),
    )
  }
  return value
}
