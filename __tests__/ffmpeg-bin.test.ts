import { describe, it, expect, vi } from 'vitest'
import { FFMPEG_NOT_FOUND_MESSAGE, findFfmpegBins, type FfmpegBinDeps } from '@/lib/ffmpeg-bin'

const INSTALL = '/Users/me/.local/share/mise/installs/conda-ffmpeg/9.0.2'

type DepsOverrides = Partial<Omit<FfmpegBinDeps, 'env'>> & { env?: Record<string, string>; executables?: string[] }

function deps({ env = {}, executables = [], ...overrides }: DepsOverrides = {}): FfmpegBinDeps {
  const allowed = new Set(executables)
  return {
    execFile: vi.fn(async () => ({ stdout: `${INSTALL}\n` })),
    access: vi.fn(async (file: string) => {
      if (!allowed.has(file)) throw new Error(`ENOENT ${file}`)
    }),
    env: env as NodeJS.ProcessEnv,
    homedir: '/Users/me',
    cwd: '/repo/Siftly',
    ...overrides,
  }
}

describe('findFfmpegBins', () => {
  it('env の FFMPEG_BIN / FFPROBE_BIN を最優先する', async () => {
    const d = deps({ env: { FFMPEG_BIN: '/x/ffmpeg', FFPROBE_BIN: '/x/ffprobe' }, executables: ['/opt/homebrew/bin/mise'] })
    expect(await findFfmpegBins(d)).toEqual({ ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe' })
    expect(d.execFile).not.toHaveBeenCalled()
  })

  it('mise where の stdout から .mise-bins のパスを組む', async () => {
    const d = deps({
      executables: ['/opt/homebrew/bin/mise', `${INSTALL}/.mise-bins/ffmpeg`, `${INSTALL}/.mise-bins/ffprobe`],
    })
    expect(await findFfmpegBins(d)).toEqual({
      ffmpeg: `${INSTALL}/.mise-bins/ffmpeg`,
      ffprobe: `${INSTALL}/.mise-bins/ffprobe`,
    })
    expect(d.execFile).toHaveBeenCalledWith('/opt/homebrew/bin/mise', ['where', 'conda:ffmpeg'], { cwd: '/repo/Siftly' })
  })

  it('mise は MISE_BIN → /opt/homebrew/bin → ~/.local/bin → PATH の順に探す', async () => {
    const bins = [`${INSTALL}/.mise-bins/ffmpeg`, `${INSTALL}/.mise-bins/ffprobe`]
    const viaLocal = deps({ executables: ['/Users/me/.local/bin/mise', ...bins] })
    await findFfmpegBins(viaLocal)
    expect(viaLocal.execFile).toHaveBeenCalledWith('/Users/me/.local/bin/mise', expect.anything(), expect.anything())

    const viaEnv = deps({ env: { MISE_BIN: '/custom/mise' }, executables: ['/custom/mise', '/opt/homebrew/bin/mise', ...bins] })
    await findFfmpegBins(viaEnv)
    expect(viaEnv.execFile).toHaveBeenCalledWith('/custom/mise', expect.anything(), expect.anything())

    const viaPath = deps({ env: { PATH: '/usr/bin:/somewhere/bin' }, executables: ['/somewhere/bin/mise', ...bins] })
    await findFfmpegBins(viaPath)
    expect(viaPath.execFile).toHaveBeenCalledWith('/somewhere/bin/mise', expect.anything(), expect.anything())
  })

  it('mise が無ければ案内メッセージで失敗する', async () => {
    await expect(findFfmpegBins(deps())).rejects.toThrow(FFMPEG_NOT_FOUND_MESSAGE)
  })

  it('mise where が失敗したら (未 trust / 未 install) 案内メッセージで失敗する', async () => {
    const d = deps({
      executables: ['/opt/homebrew/bin/mise'],
      execFile: vi.fn(async () => { throw new Error('not installed') }),
    })
    await expect(findFfmpegBins(d)).rejects.toThrow(FFMPEG_NOT_FOUND_MESSAGE)
  })

  it('install dir に bin が無ければ案内メッセージで失敗する', async () => {
    await expect(findFfmpegBins(deps({ executables: ['/opt/homebrew/bin/mise'] }))).rejects.toThrow(FFMPEG_NOT_FOUND_MESSAGE)
  })

  it('案内メッセージは mise trust && mise install を示す', () => {
    expect(FFMPEG_NOT_FOUND_MESSAGE).toContain('mise trust && mise install')
  })
})
