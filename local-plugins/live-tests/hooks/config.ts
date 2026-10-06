import { NOTICE_MODES } from './notices'
import type { NoticeMode } from './notices'
import { CONCURRENCY_MODES } from './clash'
import type { Concurrency } from './clash'

export type Runner = 'pytest' | 'node-test' | 'events'

export type StepConfig = {
  argv: readonly string[]
  runner?: Runner
  cwd?: string
  env?: Readonly<Record<string, string>>
  label?: string
  /** Whether run_tests' `args` are appended here; by default only the last step takes them. */
  acceptsArgs?: boolean
}

export type SuiteConfig = {
  description?: string
  cwd?: string
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  /** Whether a background run sends failures before its summary; auto waits until it has run 2 minutes. */
  failureNotices?: NoticeMode
  /** Which runs of the suite may overlap in one folder: other args (the default), none, or any. */
  concurrency?: Concurrency
  steps: readonly StepConfig[]
}

export type TestsConfig = { default: string; suites: Readonly<Record<string, SuiteConfig>> }

export type DetectFiles = {
  pyproject?: string
  packageJson?: string
  hasUvLock?: boolean
  hasPytestIni?: boolean
}

const RUNNERS: readonly string[] = ['pytest', 'node-test', 'events']
const SUITE_FIELDS: readonly string[] = ['description', 'cwd', 'env', 'timeoutMs', 'failureNotices', 'concurrency', 'argv', 'runner', 'steps']
const STEP_FIELDS: readonly string[] = ['argv', 'runner', 'cwd', 'env', 'label', 'acceptsArgs']

type Raw = Record<string, unknown>

/** The config file a message should name: the one a suite comes from, or both for top-level problems. */
export type SourceOf = (suite: string | undefined) => string

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

class ConfigError extends Error {
  constructor(
    readonly why: string,
    readonly where?: string,
  ) {
    super(where === undefined ? why : `${where}: ${why}`)
  }
}

const fail = (why: string): never => {
  throw new ConfigError(why)
}

/** Runs `fn`, naming `where` in its config error unless a deeper part already did. */
const located = <T>(where: string, fn: () => T): T => {
  try {
    return fn()
  } catch (error) {
    if (error instanceof ConfigError && error.where === undefined) throw new ConfigError(error.why, where)
    throw error
  }
}

const checkFields = (raw: Raw, allowed: readonly string[]) => {
  const unknown = Object.keys(raw).find(k => !allowed.includes(k))
  if (unknown !== undefined) fail(`unknown field "${unknown}"; allowed: ${allowed.join(', ')}`)
}

const checkType = (raw: Raw, field: string, isOk: (v: unknown) => boolean, what: string) => {
  if (raw[field] !== undefined && !isOk(raw[field])) fail(`"${field}" must be ${what}`)
}

const checkChoice = (field: string, value: unknown, allowed: readonly string[]) => {
  if (value !== undefined && !allowed.includes(value as string)) fail(`"${field}" is ${JSON.stringify(value)}; allowed: ${allowed.join(', ')}`)
}

const stringMap = (v: unknown): Record<string, string> | undefined => {
  if (v === undefined) return undefined
  const isStrings = isObject(v) && Object.values(v).every(x => typeof x === 'string')
  return isStrings ? (v as Record<string, string>) : fail('"env" must map names to strings, e.g. {"CI": "1"}')
}

const isString = (v: unknown) => typeof v === 'string'

const checkShared = (raw: Raw) => {
  const { argv, runner } = raw
  const isArgv = Array.isArray(argv) && argv.length > 0 && argv.every(isString)
  if (argv !== undefined && !isArgv) {
    fail('"argv" must be a non-empty list of strings, e.g. ["npm", "test", "--"]; a string like "npm test" is not split')
  }
  if (runner !== undefined && !RUNNERS.includes(runner as string)) fail(`"runner" is ${JSON.stringify(runner)}; allowed: ${RUNNERS.join(', ')}`)
  checkType(raw, 'cwd', isString, 'a folder path, relative to the project root')
}

const prune = <T>(fields: Raw) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as T

const normalizeStep = (raw: unknown): StepConfig => {
  if (!isObject(raw)) return fail('a step must be an object like {"argv": ["pytest"]}')
  checkFields(raw, STEP_FIELDS)
  if (raw.argv === undefined) fail('a step needs "argv", e.g. ["npm", "run", "build"]')
  checkShared(raw)
  checkType(raw, 'label', isString, 'a string')
  checkType(raw, 'acceptsArgs', v => typeof v === 'boolean', 'true or false')
  const { argv, runner, cwd, label, acceptsArgs } = raw
  return prune<StepConfig>({ argv, runner, cwd, env: stringMap(raw.env), label, acceptsArgs })
}

const normalizeSuite = (raw: unknown, name: string): SuiteConfig => {
  if (!isObject(raw)) return fail(`suite "${name}" must be an object with "argv" (one command) or "steps" (several)`)
  located(`suite "${name}"`, () => checkFields(raw, SUITE_FIELDS))
  if (raw.argv === undefined && raw.steps === undefined) {
    return fail(`suite "${name}" needs "argv" (one command, e.g. ["uv", "run", "pytest"]) or "steps" (a list of {"argv": [...]})`)
  }
  return located(`suite "${name}"`, () => {
    checkShared(raw)
    checkType(raw, 'description', isString, 'a string')
    checkType(raw, 'timeoutMs', v => typeof v === 'number' && v > 0, 'a positive number of milliseconds')
    checkType(raw, 'steps', v => Array.isArray(v) && v.length > 0, 'a non-empty list of steps')
    const { steps, argv, runner, description, cwd, timeoutMs, failureNotices, concurrency } = raw
    checkChoice('failureNotices', failureNotices, NOTICE_MODES)
    checkChoice('concurrency', concurrency, CONCURRENCY_MODES)
    const rawSteps = (steps ?? [prune<Raw>({ argv, runner })]) as readonly unknown[]
    const normalized = rawSteps.map((s, i) => located(`suite "${name}", step ${i + 1}`, () => normalizeStep(s)))
    return prune<SuiteConfig>({ description, cwd, env: stringMap(raw.env), timeoutMs, failureNotices, concurrency, steps: normalized })
  })
}

const EXAMPLE = '{"suites": {"unit": {"argv": ["pytest"], "runner": "pytest"}}}'

const checkTop = (raw: unknown): Raw => {
  if (!isObject(raw) || !isObject(raw.suites)) return fail(`needs a "suites" object, e.g. ${EXAMPLE}`)
  if (Object.keys(raw.suites).length === 0) fail(`"suites" is empty; add at least one, e.g. ${EXAMPLE}`)
  return raw
}

export const normalizeConfig = (raw: unknown, sourceOf: SourceOf = () => '.claude/tests.json'): TestsConfig => {
  const blamed = <T>(suite: string | undefined, fn: () => T): T => {
    try {
      return fn()
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      const hint = 'Fix the file and call run_tests again; the live-tests:setup-tests skill has the field reference.'
      throw new Error(`tests config error in ${sourceOf(suite)}: ${error.message}\n${hint}`)
    }
  }
  const top = blamed(undefined, () => checkTop(raw))
  const names = Object.keys(top.suites as Raw)
  const suites = Object.fromEntries(names.map(n => [n, blamed(n, () => normalizeSuite((top.suites as Raw)[n], n))]))
  const chosen = top.default ?? names[0]
  blamed(undefined, () => {
    if (typeof chosen !== 'string' || !(chosen in suites)) fail(`"default" is ${JSON.stringify(chosen)}, but the suites are: ${names.join(', ')}`)
  })
  return { default: chosen as string, suites }
}

/** Which file to name in an error: a suite's own file (local wins, as in the merge), else whichever files exist. */
export const configSource =
  (shared: unknown, local: unknown, paths: { shared: string; local: string }): SourceOf =>
  suite => {
    const hasSuite = (file: unknown) => suite !== undefined && isObject(file) && isObject(file.suites) && suite in file.suites
    if (hasSuite(local)) return paths.local
    if (hasSuite(shared)) return paths.shared
    const present = [shared === undefined ? undefined : paths.shared, local === undefined ? undefined : paths.local].filter(isString)
    return present.join(' or ')
  }

export const noConfigReply = (folder: string) =>
  `No test suites are configured or detected in ${folder} (looked for pytest in pyproject.toml or pytest.ini, and a "test" script in package.json).\n` +
  `To set it up, write ${folder}/.claude/tests.json, for example:\n` +
  '{"suites": {"unit": {"argv": ["uv", "run", "pytest"], "runner": "pytest"}}}\n' +
  'then call run_tests again. The live-tests:setup-tests skill has templates for other projects (node --test, build steps, subfolders, other test runners).'

/** Same rule as settings: the local file wins, suite by suite. */
export const mergeConfigs = (shared: unknown, local: unknown): unknown => {
  if (!isObject(local)) return shared
  if (!isObject(shared)) return local
  const suites = { ...(isObject(shared.suites) ? shared.suites : {}), ...(isObject(local.suites) ? local.suites : {}) }
  return { ...shared, ...local, suites }
}

const parsePackage = (text: string): Raw | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

const detectPython = (files: DetectFiles) => {
  const usesPytest = files.hasPytestIni === true || /pytest/.test(files.pyproject ?? '')
  if (!usesPytest) return undefined
  const argv = files.hasUvLock ? ['uv', 'run', 'pytest'] : ['python', '-m', 'pytest']
  return { argv, runner: 'pytest' as const }
}

const detectNode = (files: DetectFiles) => {
  const pkg = files.packageJson === undefined ? undefined : parsePackage(files.packageJson)
  const script = isObject(pkg?.scripts) ? pkg.scripts.test : undefined
  if (typeof script !== 'string') return undefined
  const runner: Runner = /node\s+(\S+\s+)*--test\b/.test(script) ? 'node-test' : 'events'
  return { argv: ['npm', 'test', '--'], runner }
}

/** A config in the file's own (shorthand) form, or undefined when nothing is recognised. */
export const detectConfig = (files: DetectFiles) => {
  const suite = detectPython(files) ?? detectNode(files)
  return suite === undefined ? undefined : { suites: { default: suite } }
}

export const stepArgv = (step: StepConfig, isLast: boolean, args: readonly string[]): readonly string[] =>
  (step.acceptsArgs ?? isLast) ? [...step.argv, ...args] : step.argv
