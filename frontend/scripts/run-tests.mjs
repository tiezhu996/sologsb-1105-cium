// 用 esbuild 在内存内把 TS 源码与测试脚本打成单个 ESM，再以临时文件加载执行。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = process.cwd()
const entry = path.join(root, 'scripts/commit-engine.test.mjs')
const outFile = path.join(root, 'scripts', `.test-bundle-${Date.now()}.mjs`)

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  sourcemap: 'inline',
  external: [],
  loader: { '.mjs': 'js' },
})

writeFileSync(outFile, result.outputFiles[0].text)
try {
  await import(pathToFileURL(outFile).href)
} finally {
  rmSync(outFile, { force: true })
}
