import { test, expect } from 'bun:test'
import ts from 'typescript'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * Shim drift detection (review §5.2-3): tsconfig.typecheck.json maps
 * @kyestu/spider and @kyestu/render to hand-written shims in src/types/,
 * so the root typecheck never sees the real packages/ sources and a shim
 * can silently drift from the vendored code on an upstream sync.
 *
 * These tests import the REAL modules (bun resolves the workspace packages)
 * and assert, per module:
 *   forward — every value the shim declares exists on the real module with a
 *             matching shape (function/class vs object vs primitive);
 *   reverse — every real top-level value export is declared in the shim;
 *   registry — spiderRegistry's shim declares exactly the real registry's
 *             public methods (both directions).
 * Type-only declarations cannot be checked at runtime; values can.
 */

type ValueKind = 'function' | 'object' | 'string' | 'number' | 'boolean'

interface ShimSurface {
  /** exported value name -> declared shape */
  values: Map<string, ValueKind>
  /** members declared on the SpiderRegistry class (spider shim only) */
  registryMethods: string[]
}

function kindOfTypeNode(node: ts.TypeNode | undefined): ValueKind {
  if (!node) return 'object'
  if (ts.isFunctionTypeNode(node)) return 'function'
  if (node.kind === ts.SyntaxKind.StringKeyword) return 'string'
  if (node.kind === ts.SyntaxKind.NumberKeyword) return 'number'
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return 'boolean'
  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return 'string'
    if (ts.isNumericLiteral(node.literal)) return 'number'
  }
  return 'object'
}

function parseShim(shimPath: string, moduleName: string): ShimSurface {
  const source = ts.createSourceFile(shimPath, readFileSync(shimPath, 'utf8'), ts.ScriptTarget.Latest, true)
  const moduleDecl = source.statements.find(
    (statement): statement is ts.ModuleDeclaration =>
      ts.isModuleDeclaration(statement) && statement.name.text === moduleName,
  )
  if (!moduleDecl?.body || !ts.isModuleBlock(moduleDecl.body)) {
    throw new Error(`${shimPath}: no 'declare module ${moduleName}' block found`)
  }
  const statements = [...moduleDecl.body.statements]

  const declaredTypes = new Map<string, ts.InterfaceDeclaration | ts.ClassDeclaration>()
  for (const statement of statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declaredTypes.set(statement.name.text, statement)
    }
  }

  const values = new Map<string, ValueKind>()
  let registryMethods: string[] = []
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      values.set(statement.name.text, 'function')
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      values.set(statement.name.text, 'function') // typeof class === 'function'
    } else if (ts.isEnumDeclaration(statement)) {
      values.set(statement.name.text, 'object')
    } else if (ts.isModuleDeclaration(statement) && statement.name) {
      values.set(statement.name.text, 'object') // namespace
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        values.set(declaration.name.text, kindOfTypeNode(declaration.type))
        if (declaration.name.text === 'spiderRegistry' && declaration.type && ts.isTypeReferenceNode(declaration.type)) {
          const registryType = declaredTypes.get(declaration.type.typeName.getText(source))
          if (!registryType) throw new Error(`${shimPath}: spiderRegistry type not declared in the shim`)
          registryMethods = registryType.members
            .filter((member) => {
              if (!member.name) return false
              const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined
              return !modifiers?.some((modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
            })
            .map((member) => member.name!.getText(source))
        }
      }
    }
    // interfaces / type aliases are type-only: nothing to check at runtime
  }
  return { values, registryMethods }
}

function realKind(value: unknown): ValueKind {
  const t = typeof value
  return t === 'function' ? 'function' : t === 'object' ? 'object' : (t as ValueKind)
}

const spiderShimPath = fileURLToPath(new URL('../src/types/kyestu-spider.d.ts', import.meta.url))
const renderShimPath = fileURLToPath(new URL('../src/types/kyestu-render.d.ts', import.meta.url))

const cases = [
  { moduleName: '@kyestu/spider', shimPath: spiderShimPath },
  { moduleName: '@kyestu/render', shimPath: renderShimPath },
] as const

for (const { moduleName, shimPath } of cases) {
  test(`${moduleName}: every shim-declared value exists on the real module with a matching shape`, async () => {
    const real = (await import(moduleName)) as Record<string, unknown>
    const shim = parseShim(shimPath, moduleName)
    const problems: string[] = []
    for (const [name, kind] of shim.values) {
      if (!(name in real)) {
        problems.push(`shim declares '${name}' but the real module does not export it (stale shim?)`)
        continue
      }
      const actual = realKind(real[name])
      if (actual !== kind) {
        problems.push(`'${name}': shim says ${kind}, real module has ${actual}`)
      }
    }
    expect(problems).toEqual([])
  })

  test(`${moduleName}: every real value export is declared in the shim (no unshimmed additions)`, async () => {
    const real = (await import(moduleName)) as Record<string, unknown>
    const shim = parseShim(shimPath, moduleName)
    const missing = Object.keys(real).filter((name) => !shim.values.has(name))
    expect(missing).toEqual([])
  })
}

test('@kyestu/spider: spiderRegistry shim covers the real registry method set, both directions', async () => {
  const { spiderRegistry } = (await import('@kyestu/spider')) as { spiderRegistry: object }
  const shim = parseShim(spiderShimPath, '@kyestu/spider')
  expect(shim.registryMethods.length).toBeGreaterThan(0)

  const realMethods = new Set<string>()
  let proto = Object.getPrototypeOf(spiderRegistry)
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor' && typeof (spiderRegistry as Record<string, unknown>)[name] === 'function') {
        realMethods.add(name)
      }
    }
    proto = Object.getPrototypeOf(proto)
  }

  const undeclared = [...realMethods].filter((name) => !shim.registryMethods.includes(name))
  expect(undeclared, 'real registry methods missing from the shim').toEqual([])
  const phantom = shim.registryMethods.filter((name) => !realMethods.has(name))
  expect(phantom, 'shim registry methods that do not exist on the real registry').toEqual([])
})
