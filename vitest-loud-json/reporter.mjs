import { mkdirSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { inspect } from 'node:util'

function errorRecord(error) {
  const text = value => typeof value === 'string' ? value : inspect(value, { depth: 5 })
  const record = {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: text(error?.message ?? error),
  }
  for (const key of ['type', 'stack', 'code', 'cause']) {
    if (error?.[key] !== undefined) record[key] = text(error[key])
  }
  return record
}

function reasonsFor(data) {
  const reasons = [...data.writeErrors]
  if (data.unhandledErrors.length) reasons.push(`${data.unhandledErrors.length} unhandled error(s) outside test results`)
  if (data.numFailedTests) reasons.push(`${data.numFailedTests} failed test(s)`)
  if (data.numFailedTestFiles) reasons.push(`${data.numFailedTestFiles} failed test file(s), including collection or hook errors`)
  if (data.runReason === 'interrupted') reasons.push('Test run was interrupted')
  if (data.runReason === 'not-finished') reasons.push('Vitest did not finish reporting this run')
  if (data.exitCode !== 0 && (reasons.length === 0 || data.exitCodeAtRunEnd === 0)) {
    reasons.push(`Process exited with code ${data.exitCode}; no cause for this exit was supplied by Vitest at run end (check coverage, teardown and other exit handlers)`)
  }
  return reasons
}

/** Companion for Vitest 4's JSON reporter, intended for `vitest run`. */
export default class LoudJsonReporter {
  onInit(ctx) {
    if (ctx.config.watch) throw new Error('vitest-loud-json requires vitest run (watch mode is unsupported)')
    const json = ctx.config.reporters.find(entry => (Array.isArray(entry) ? entry[0] : entry) === 'json')
    const output = (Array.isArray(json) ? json[1]?.outputFile : undefined)
      ?? (typeof ctx.config.outputFile === 'string' ? ctx.config.outputFile : ctx.config.outputFile?.json)
    if (!json || typeof output !== 'string' || !output.trim()) {
      throw new Error('vitest-loud-json requires the json reporter and an explicit JSON outputFile')
    }
    this.reportFile = resolve(ctx.config.root, output)
    this.sidecar = `${this.reportFile}.errors.json`
    this.data = {
      version: 1,
      reportFile: this.reportFile,
      exitCodeAtRunEnd: null,
      exitCode: null,
      runReason: 'not-finished',
      numFailedTests: 0,
      numFailedTestFiles: 0,
      unhandledErrors: [],
      moduleErrors: [],
      writeErrors: [],
      reasons: [],
    }
    // An early snapshot prevents a previous run's green sidecar from surviving.
    this.save()
    process.once('exit', code => this.finish(Number(process.exitCode ?? code)))
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    this.data.exitCodeAtRunEnd = Number(process.exitCode ?? 0)
    this.data.runReason = reason
    this.data.unhandledErrors = unhandledErrors.map(errorRecord)
    for (const module of modules) {
      this.data.numFailedTests += [...module.children.allTests('failed')].length
      if (!module.ok()) this.data.numFailedTestFiles += 1
      for (const suite of [module, ...module.children.allSuites()]) {
        for (const error of suite.errors()) {
          this.data.moduleErrors.push({ file: module.moduleId, ...errorRecord(error) })
        }
      }
    }
    this.data.reasons = reasonsFor({ ...this.data, exitCode: this.data.exitCodeAtRunEnd })
    this.save()
  }

  save() {
    try {
      mkdirSync(dirname(this.sidecar), { recursive: true })
      writeFileSync(this.sidecar, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    } catch (error) {
      const message = `Cannot write sidecar ${this.sidecar}: ${error.message}`
      if (!this.data.writeErrors.includes(message)) this.data.writeErrors.push(message)
      process.exitCode = 1
    }
  }

  finish(code) {
    this.data.exitCode = code
    this.data.reasons = reasonsFor(this.data)
    this.save()
    this.data.exitCode = Number(process.exitCode ?? code)
    this.data.reasons = reasonsFor(this.data)
    if (this.data.exitCode === 0 && this.data.reasons.length === 0) return
    const lines = [
      `[vitest-loud-json] exit ${this.data.exitCode}; ${this.data.numFailedTests} failed test(s)`,
      ...this.data.reasons.map(reason => `- ${reason}`),
    ]
    for (const error of [...this.data.unhandledErrors, ...this.data.moduleErrors]) {
      lines.push('', `${error.type ?? error.name}: ${error.message}`)
      if (error.stack) lines.push(error.stack)
      if (error.cause) lines.push(`Caused by: ${error.cause}`)
    }
    lines.push('', `Sidecar: ${this.sidecar}`, '[/vitest-loud-json]', '')
    // Exit listeners must write synchronously; async stderr writes can be lost.
    writeSync(2, lines.join('\n'))
  }
}
