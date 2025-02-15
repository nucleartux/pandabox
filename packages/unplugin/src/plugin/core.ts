import { loadConfig } from '@pandacss/config'
import type { LoadConfigResult, ParserResultBeforeHookArgs, RequiredBy } from '@pandacss/types'
import { createFilter } from '@rollup/pluginutils'
import { type TransformResult, type UnpluginFactory } from 'unplugin'
import type { HmrContext, Plugin } from 'vite'

import { createContext, type PandaPluginContext } from '../plugin/create-context'
import { ensureAbsolute } from './ensure-absolute'

const _fileId = 'panda.css'
const _virtualModuleId = 'virtual:' + _fileId
const ids = {
  virtualModuleId: 'virtual:' + _fileId,
  resolvedVirtualModuleId: '\0' + _virtualModuleId,
}

export interface PandaPluginOptions extends Partial<PandaPluginHooks> {
  /** @see https://panda-css.com/docs/references/config#cwd */
  cwd?: string
  /** @see https://panda-css.com/docs/references/cli#--config--c-1 */
  configPath?: string | undefined
  /**
   * If set, output the generated CSS to the filesystem instead of the virtual module (`virtual:panda.css`).
   * @see https://panda-css.com/docs/references/cli#--outfile
   */
  outfile?: string | undefined
  /**
   * @see https://www.npmjs.com/package/@rollup/pluginutils#include-and-exclude
   * @default `[/\.[cm]?[jt]sx?$/]`
   */
  include?: string | RegExp | (string | RegExp)[]
  /**
   * @see https://www.npmjs.com/package/@rollup/pluginutils#include-and-exclude
   * @default [/node_modules/]
   */
  exclude?: string | RegExp | (string | RegExp)[]
  /**
   * Will remove unused CSS variables and keyframes from the generated CSS
   */
  optimizeCss?: boolean
}

export interface PandaPluginHooks {
  /**
   * A transform callback similar to the `transform` hook of `vite` that allows you to modify the source code before it's parsed.
   */
  transform: (args: Omit<ParserResultBeforeHookArgs, 'configure'>) => TransformResult | void
}

export const unpluginFactory: UnpluginFactory<PandaPluginOptions | undefined> = (rawOptions) => {
  const options = resolveOptions(rawOptions ?? {})
  const filter = createFilter(options.include, options.exclude)
  const outfile = options.outfile ? ensureAbsolute(options.outfile, options.cwd) : ids.resolvedVirtualModuleId

  let _ctx: PandaPluginContext
  let initPromise: Promise<PandaPluginContext> | undefined

  const getCtx = async () => {
    await init()
    if (!_ctx) throw new Error('@pandabox/unplugin context not initialized')
    return _ctx as PandaPluginContext
  }

  const init = () => {
    if (initPromise) return initPromise
    // @ts-expect-error
    initPromise = loadConfig({ cwd: options.cwd, file: options.configPath }).then((conf: LoadConfigResult) => {
      _ctx = createContext({ root: options.cwd, conf })
    })

    return initPromise
  }

  return {
    name: 'unplugin-panda',
    enforce: 'pre',
    resolveId(id) {
      if (id === ids.virtualModuleId) {
        return ids.resolvedVirtualModuleId
      }
    },
    async load(id) {
      if (id !== outfile) return

      const ctx = await getCtx()
      const sheet = ctx.panda.createSheet()
      const css = ctx.toCss(sheet, options)

      return css
    },

    transformInclude(id) {
      return filter(id)
    },
    async transform(code, id) {
      const ctx = await getCtx()
      const { panda } = ctx

      let transformResult: TransformResult = { code, map: undefined }

      if (options.transform) {
        const result = options.transform({ filePath: id, content: code }) || code
        if (typeof result === 'string') {
          transformResult.code = result
        } else if (result) {
          transformResult = result
        }
      }

      panda.project.addSourceFile(id, transformResult.code)
      const parserResult = panda.project.parseSourceFile(id)
      if (!parserResult) return null

      if (!parserResult.isEmpty()) {
        ctx.files.set(id, code)
      }

      return null
    },
    vite: {
      async configureServer(server) {
        const ctx = await getCtx()

        const sources = new Set([ctx.panda.conf.path, ...(ctx.panda.config.dependencies ?? [])])
        sources.forEach((file) => server.watcher.add(file))
        server.watcher.on('change', async (filePath) => {
          if (!sources.has(filePath)) return

          await ctx.reloadContext()

          const timestamp = Date.now()
          const invalidate = (file: string) => {
            const mod = server.moduleGraph.getModuleById(file)
            if (mod) {
              server.moduleGraph.invalidateModule(mod, new Set(), timestamp, true)
            }
          }

          // Parse/Invalidate all files with new config
          ctx.files.forEach((_content, file) => {
            invalidate(file)
            ctx.panda.project.parseSourceFile(file)
          })

          // Invalidate CSS
          invalidate(outfile)
        })
      },
      async handleHotUpdate(hmr: HmrContext) {
        const ctx = await getCtx()
        if (!ctx.files.has(hmr.file)) return

        // Invalidate CSS
        const mod = hmr.server.moduleGraph.getModuleById(outfile)
        if (mod) {
          hmr.server.moduleGraph.invalidateModule(mod, new Set(), hmr.timestamp, true)
        }
      },
    } as Plugin,
  }
}

const resolveOptions = (options: PandaPluginOptions): RequiredBy<PandaPluginOptions, 'cwd'> => {
  return {
    ...options,
    cwd: options.cwd || process.cwd(),
    configPath: options.configPath,
    include: options.include || [/\.[cm]?[jt]sx?$/],
    exclude: options.exclude || [/node_modules/, /styled-system/],
    optimizeCss: options.optimizeCss ?? true,
  }
}
