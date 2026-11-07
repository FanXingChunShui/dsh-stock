#!/usr/bin/env node
/**
 * 校验 npm 打包内容是否完整、是否混入不该发布的文件。
 *
 * 为什么不用 `grep " $file "` 这种文本断言：
 *   npm pack 的文件清单是**按列宽动态对齐**的，文件名后面补若干空格，
 *   例如 `npm notice 8.8kB   index.js           `。
 *   用单空格包裹匹配（`" index.js "`）在列宽变化时会全部误报「缺失」，
 *   而列宽取决于最长文件名的长度——一旦新增一个长文件名就会变。
 *
 * 改用 `npm pack --dry-run --json` 拿结构化结果，与文本格式彻底解耦。
 *
 * 用法：node scripts/verify-pack.mjs
 * 退出码：0 通过，1 失败
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** 必须出现在包里的文件。 */
const REQUIRED = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'package.json',
  'locale/zh.json',
  'locale/en.json',
  'lib/quote.js',
  'lib/score.js',
  'lib/rpc.js',
  'lib/tools.js',
];

/** 绝不能出现在包里的路径前缀。 */
const FORBIDDEN = [
  'node_modules/',
  'tests/',
  '.github/',
  '.git/',
];

/** 读取 package.json，校验 files 字段与 dsh 入口是否自洽。 */
function checkManifest() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const problems = [];

  if (pkg.private !== false) {
    problems.push(`package.json 的 private 必须是 false 才能发布，当前：${pkg.private}`);
  }
  if (!pkg.name) problems.push('package.json 缺少 name');
  if (!pkg.version) problems.push('package.json 缺少 version');
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    problems.push('package.json 缺少 files 字段');
  }
  // dsh 入口必须指向实际存在的文件，否则插件装上后加载不到
  const patch = pkg.dsh?.bundle?.patch;
  if (typeof patch !== 'string') {
    problems.push('package.json 缺少 dsh.bundle.patch');
  } else {
    const rel = patch.replace(/^\.\//, '');
    if (!REQUIRED.includes(rel)) {
      problems.push(`dsh.bundle.patch 指向 ${patch}，但它不在必需文件清单里`);
    }
  }
  return problems;
}

/** 取打包清单。 */
function readPackList() {
  let out;
  try {
    out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`npm pack --dry-run --json 执行失败：${error.message}`);
  }
  // npm 有时会在 JSON 前后混入提示信息，取第一个 '[' 到最后一个 ']'
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error(`npm pack 未返回 JSON。原始输出前 200 字：${out.slice(0, 200)}`);
  }
  const parsed = JSON.parse(out.slice(start, end + 1));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('npm pack --json 返回空数组');
  }
  const files = parsed[0].files;
  if (!Array.isArray(files)) throw new Error('npm pack --json 结果缺少 files 字段');
  return files.map((f) => String(f.path));
}

function main() {
  let failed = false;

  // ── 1. 清单自洽性 ──
  const manifestProblems = checkManifest();
  if (manifestProblems.length > 0) {
    console.error('❌ package.json 校验失败：');
    for (const p of manifestProblems) console.error(`   - ${p}`);
    failed = true;
  } else {
    console.log('✓ package.json 自洽');
  }

  // ── 2. 读取打包清单 ──
  let packed;
  try {
    packed = readPackList();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
  const packedSet = new Set(packed);
  console.log(`\n打包文件共 ${packed.length} 个：`);
  for (const p of packed) console.log(`   ${p}`);

  // ── 3. 必需文件必须都在 ──
  console.log('\n必需文件：');
  for (const need of REQUIRED) {
    if (packedSet.has(need)) {
      console.log(`   ✓ ${need}`);
    } else {
      console.error(`   ❌ 缺失：${need}`);
      failed = true;
    }
  }

  // ── 4. 禁止项不能出现 ──
  console.log('\n排除项：');
  for (const prefix of FORBIDDEN) {
    const hits = packed.filter((p) => p.startsWith(prefix) || p.includes(`/${prefix}`));
    if (hits.length === 0) {
      console.log(`   ✓ 已排除 ${prefix}`);
    } else {
      console.error(`   ❌ 不应打包却出现：${prefix}（${hits.length} 个文件）`);
      for (const h of hits.slice(0, 5)) console.error(`        ${h}`);
      failed = true;
    }
  }

  if (failed) {
    console.error('\n打包校验失败');
    process.exit(1);
  }
  console.log('\n打包校验通过');
}

main();
