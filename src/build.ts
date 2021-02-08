import path from 'path'
import { execSync } from 'child_process'

import { createLambda, BuildOptions, download, File, FileBlob, FileFsRef, glob, getNodeVersion, getSpawnOptions, Lambda, runNpmInstall, runPackageJsonScript } from '@vercel/build-utils'
import type { Route } from '@vercel/routing-utils'
import consola from 'consola'
import fs, { writeJSON } from 'fs-extra'
import resolveFrom from 'resolve-from'
import { gte, gt } from 'semver'

import { endStep, exec, getNuxtConfig, getNuxtConfigName, globAndPrefix, MutablePackageJson, prepareNodeModules, preparePkgForProd, readJSON, startStep, validateEntrypoint } from './utils'
import { prepareTypescriptEnvironment, compileTypescriptBuildFiles, JsonOptions } from './typescript'

interface BuilderOutput {
  watch?: string[];
  output: Record<string, Lambda | File | FileFsRef>;
  routes: Route[];
}

interface NuxtBuilderConfig {
  maxDuration?: number
  memory?: number
  tscOptions?: JsonOptions
  generateStaticRoutes?: boolean
  includeFiles?: string[] | string
  serverFiles?: string[]
  internalServer?: boolean

  buildTimeDependencies?: {
    dependencies: Array<string | [packageName: string, semVer: string]>
    devDependencies: Array<string | [packageName: string, semVer: string]>
  }
  unusedDependencies?: string[]
}

export async function build (opts: BuildOptions & { config: NuxtBuilderConfig }): Promise<BuilderOutput> {
  const { files, entrypoint, workPath, config = {}, meta = {} } = opts
  // ---------------- Debugging context --------------
  consola.log('Running with @nuxt/vercel-builder version', require('../package.json').version)

  // ----------------- Prepare build -----------------
  startStep('Prepare build')

  // Validate entrypoint
  validateEntrypoint(entrypoint)

  // Get Nuxt directory
  const entrypointDirname = path.dirname(entrypoint)
  // Get Nuxt path
  const entrypointPath = path.join(workPath, entrypointDirname)
  // Get folder where we'll store node_modules
  const modulesPath = path.join(entrypointPath, 'node_modules')

  // Create a real filesystem
  consola.log('Downloading files...')
  await download(files, workPath, meta)

  // Change current working directory to entrypointPath
  process.chdir(entrypointPath)
  consola.log('Working directory:', process.cwd())

  // Read package.json
  let pkg: MutablePackageJson
  try {
    pkg = await readJSON('package.json')
  } catch (e) {
    throw new Error(`Can not read package.json from ${entrypointPath}`)
  }

  // fork-vercel-builder: Remove unused dependencies
  const { dependencies, devDependencies } = pkg
  if (config.unusedDependencies) {
    let removed = 0
    consola.log(`fork-vercel-builder: Removing ${config.unusedDependencies.length} unused devDependencies.`)

    config.unusedDependencies.forEach((packageName) => {
      if (dependencies && packageName in dependencies) {
        delete dependencies[packageName]
        removed += 1
      } else if (devDependencies && packageName in devDependencies) {
        delete devDependencies[packageName]
        removed += 1
      }
    })

    consola.log(`fork-vercel-builder: Removed ${removed} devDependencies.`)
  }
  // fork-vercel-builder: Add build-time dependencies
  (['dependencies', 'devDependencies'] as const).forEach((depType) => {
    if (pkg[depType] && config.buildTimeDependencies?.[depType]) {
      const deps = config.buildTimeDependencies[depType]
      consola.log(`fork-vercel-builder: Adding ${deps.length} dependencies to ${depType}.`)

      deps.forEach((packageInfo) => {
        let packageName: string, semver: string
        if (Array.isArray(packageInfo)) {
          [packageName, semver] = packageInfo
        } else {
          packageName = packageInfo
          semver = '*'
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        pkg[depType]![packageName] = semver
      })
    }
  })
  await writeJSON('package.json', pkg)

  // Node version
  const nodeVersion = await getNodeVersion(entrypointPath, undefined, {}, meta)
  const spawnOpts = getSpawnOptions(meta, nodeVersion)

  // Prepare TypeScript environment if required.
  const usesTypescript = (pkg.devDependencies && Object.keys(pkg.devDependencies).includes('@nuxt/typescript-build')) || (pkg.dependencies && Object.keys(pkg.dependencies).includes('@nuxt/typescript'))
  const needsTypescriptBuild = getNuxtConfigName(entrypointPath) === 'nuxt.config.ts'

  if (usesTypescript) {
    await prepareTypescriptEnvironment({
      pkg, spawnOpts, rootDir: entrypointPath
    })
  }

  // Detect npm (prefer yarn)
  const isYarn = !fs.existsSync('package-lock.json')
  consola.log('Using', isYarn ? 'yarn' : 'npm')

  // Write .npmrc
  if (process.env.NPM_AUTH_TOKEN) {
    consola.log('Found NPM_AUTH_TOKEN in environment, creating .npmrc')
    await fs.writeFile('.npmrc', `//registry.npmjs.org/:_authToken=${process.env.NPM_AUTH_TOKEN}`)
  }

  // Write .yarnclean
  if (isYarn && !fs.existsSync('../.yarnclean')) {
    await fs.copyFile(path.join(__dirname, '../.yarnclean'), '.yarnclean')
  }

  // Cache dir
  const cachePath = path.resolve(entrypointPath, '.vercel_cache')
  await fs.mkdirp(cachePath)

  const yarnCachePath = path.join(cachePath, 'yarn')
  await fs.mkdirp(yarnCachePath)

  // ----------------- Install devDependencies -----------------
  startStep('Install devDependencies')

  // Prepare node_modules
  await prepareNodeModules(entrypointPath, 'node_modules_dev')

  // Install all dependencies
  await runNpmInstall(entrypointPath, [
    '--ignore-optional',
    '--prefer-offline',
    '--frozen-lockfile',
    '--non-interactive',
    '--production=false',
    `--modules-folder=${modulesPath}`,
    `--cache-folder=${yarnCachePath}`
  ], { ...spawnOpts, env: { ...spawnOpts.env, NODE_ENV: 'development' } }, meta)

  // ----------------- Pre build -----------------
  if (pkg.scripts && Object.keys(pkg.scripts).includes('now-build')) {
    startStep('Pre build')
    await runPackageJsonScript(entrypointPath, 'now-build', spawnOpts)
  }

  // ----------------- Nuxt build -----------------
  startStep('Nuxt build')

  let compiledTypescriptFiles: { [filePath: string]: FileFsRef } = {}
  if (needsTypescriptBuild) {
    const { tscOptions } = config
    compiledTypescriptFiles = await compileTypescriptBuildFiles({ rootDir: entrypointPath, spawnOpts, tscOptions })
  }

  // Read nuxt.config.js
  const nuxtConfigName = 'nuxt.config.js'
  const nuxtConfigFile = getNuxtConfig(entrypointPath, nuxtConfigName)

  // Read options from nuxt.config.js otherwise set sensible defaults
  const staticDir = (nuxtConfigFile.dir && nuxtConfigFile.dir.static) ? nuxtConfigFile.dir.static : 'static'
  const publicPath = ((nuxtConfigFile.build && nuxtConfigFile.build.publicPath) ? nuxtConfigFile.build.publicPath : '/_nuxt/').replace(/^\//, '')
  const buildDir = nuxtConfigFile.buildDir ? path.relative(entrypointPath, nuxtConfigFile.buildDir) : '.nuxt'
  const srcDir = nuxtConfigFile.srcDir ? path.relative(entrypointPath, nuxtConfigFile.srcDir) : '.'
  const lambdaName = nuxtConfigFile.lambdaName ? nuxtConfigFile.lambdaName : 'index'
  const usesServerMiddleware = config.internalServer !== undefined ? config.internalServer : !!nuxtConfigFile.serverMiddleware

  await exec('nuxt', [
    'build',
    '--standalone',
    '--no-lock', // #19
    `--config-file "${nuxtConfigName}"`
  ], spawnOpts)

  if (config.generateStaticRoutes) {
    await exec('nuxt', [
      'generate',
      '--no-build',
      '--no-lock', // #19
      `--config-file "${nuxtConfigName}"`
    ], spawnOpts)
  }

  // ----------------- Install dependencies -----------------
  startStep('Install dependencies')

  // Use node_modules_prod
  await prepareNodeModules(entrypointPath, 'node_modules_prod')

  // Only keep core dependency
  const nuxtDep = preparePkgForProd(pkg)
  await fs.writeJSON('package.json', pkg)

  await runNpmInstall(entrypointPath, [
    '--ignore-optional',
    '--prefer-offline',
    '--pure-lockfile',
    '--non-interactive',
    '--production=true',
    `--modules-folder=${modulesPath}`,
    `--cache-folder=${yarnCachePath}`
  ], {
    ...spawnOpts,
    env: {
      ...spawnOpts.env,
      NPM_ONLY_PRODUCTION: 'true'
    }
  }, meta)

  // Validate nuxt version
  const nuxtPkg = require(resolveFrom(entrypointPath, `@nuxt/core${nuxtDep.suffix}/package.json`))
  if (!gte(nuxtPkg.version, '2.4.0')) {
    throw new Error(`nuxt >= 2.4.0 is required, detected version ${nuxtPkg.version}`)
  }
  if (gt(nuxtPkg.version, '3.0.0')) {
    consola.warn('WARNING: nuxt >= 3.0.0 is not tested against this builder!')
  }

  // Cleanup .npmrc
  if (process.env.NPM_AUTH_TOKEN) {
    await fs.unlink('.npmrc')
  }

  // ----------------- Collect artifacts -----------------
  startStep('Collect artifacts')

  // Static files
  const staticFiles = await glob('**', path.join(entrypointPath, srcDir, staticDir))

  // Client dist files
  const clientDistDir = path.join(entrypointPath, buildDir, 'dist/client')
  const clientDistFiles = await globAndPrefix('**', clientDistDir, publicPath)

  // Server dist files
  const serverDistDir = path.join(entrypointPath, buildDir, 'dist/server')
  const serverDistFiles = await globAndPrefix('**', serverDistDir, path.join(buildDir, 'dist/server'))

  // Generated static files
  const generatedDir = path.join(entrypointPath, 'dist')
  const generatedPagesFiles = config.generateStaticRoutes ? await globAndPrefix('**/*.*', generatedDir, './') : {}

  // node_modules_prod
  const nodeModulesDir = path.join(entrypointPath, 'node_modules_prod')
  const nodeModules = await globAndPrefix('**', nodeModulesDir, 'node_modules')

  // fork-vercel-builder: Show install size of dependencies
  const installedPackages = await fs.readdir('node_modules')
  installedPackages.forEach((filename) => {
    const filepath = path.join('node_modules', filename)
    const size = execSync(`du -sb ${filepath} | cut -f1`).toString().trim()
    consola.log(`${filepath}: ${size}`)
  })

  // Lambdas
  const lambdas: Record<string, Lambda> = {}

  const launcherPath = path.join(__dirname, 'launcher.js')
  const launcherSrc = (await fs.readFile(launcherPath, 'utf8'))
    .replace(/__NUXT_SUFFIX__/g, nuxtDep.suffix)
    .replace(/__NUXT_CONFIG__/g, './' + nuxtConfigName)
    .replace(/\/\* __ENABLE_INTERNAL_SERVER__ \*\/ *true/g, String(usesServerMiddleware))

  const launcherFiles = {
    'vercel__launcher.js': new FileBlob({ data: launcherSrc }),
    'vercel__bridge.js': new FileFsRef({ fsPath: require('@vercel/node-bridge') }),
    [nuxtConfigName]: new FileFsRef({ fsPath: path.resolve(entrypointPath, nuxtConfigName) }),
    ...serverDistFiles,
    ...compiledTypescriptFiles,
    ...nodeModules
  }

  // Extra files to be included in lambda
  const serverFiles = [
    ...(Array.isArray(config.includeFiles) ? config.includeFiles : config.includeFiles ? [config.includeFiles] : []),
    ...(Array.isArray(config.serverFiles) ? config.serverFiles : []),
    'package.json'
  ]

  for (const pattern of serverFiles) {
    const files = await glob(pattern, entrypointPath)
    Object.assign(launcherFiles, files)
  }

  // lambdaName will be titled index, unless specified in nuxt.config.js
  lambdas[lambdaName] = await createLambda({
    handler: 'vercel__launcher.launcher',
    runtime: nodeVersion.runtime,
    files: launcherFiles,
    environment: {
      NODE_ENV: 'production'
    },
    //
    maxDuration: config.maxDuration,
    memory: config.memory
  })

  // await download(launcherFiles, rootDir)

  endStep()

  return {
    output: {
      ...lambdas,
      ...clientDistFiles,
      ...staticFiles,
      ...generatedPagesFiles
    },
    routes: [
      { src: `/${publicPath}.+`, headers: { 'Cache-Control': 'max-age=31557600' } },
      ...Object.keys(staticFiles).map(file => ({ src: `/${file}`, headers: { 'Cache-Control': 'max-age=31557600' } })),
      { handle: 'filesystem' },
      { src: '/(.*)', dest: '/index' }
    ]
  }
}
