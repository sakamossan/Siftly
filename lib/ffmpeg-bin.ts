import { execFile } from 'child_process'
import { access, constants } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface FfmpegBins {
  ffmpeg: string
  ffprobe: string
}

export interface FfmpegBinDeps {
  execFile: (file: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string }>
  access: (file: string, mode: number) => Promise<void>
  env: NodeJS.ProcessEnv
  homedir: string
  cwd: string
}

export const FFMPEG_NOT_FOUND_MESSAGE =
  'ffmpeg が見つかりません。Siftly ディレクトリで `mise trust && mise install` を実行してください'

const defaultDeps = (): FfmpegBinDeps => ({
  execFile: (file, args, options) => execFileAsync(file, args, options),
  access,
  env: process.env,
  homedir: os.homedir(),
  cwd: process.cwd(),
})

async function isExecutable(file: string, deps: FfmpegBinDeps): Promise<boolean> {
  try {
    await deps.access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * mise 本体のパス。next dev は scripts/run-sync.sh / start.sh から起動され、
 * PATH に mise の shims や bin があるとは限らないので既知の置き場所を先に見る。
 */
async function resolveMise(deps: FfmpegBinDeps): Promise<string | null> {
  const candidates = [
    deps.env.MISE_BIN,
    '/opt/homebrew/bin/mise',
    path.join(deps.homedir, '.local', 'bin', 'mise'),
    ...(deps.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'mise')),
  ]
  for (const candidate of candidates) {
    if (candidate && await isExecutable(candidate, deps)) return candidate
  }
  return null
}

/**
 * ffmpeg / ffprobe を解決する。優先順は env の FFMPEG_BIN / FFPROBE_BIN →
 * Siftly 直下の mise.toml (conda:ffmpeg) の install dir。brew / nix の ffmpeg は見ない。
 */
export async function findFfmpegBins(deps: FfmpegBinDeps = defaultDeps()): Promise<FfmpegBins> {
  const { FFMPEG_BIN, FFPROBE_BIN } = deps.env
  if (FFMPEG_BIN && FFPROBE_BIN) return { ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN }

  const mise = await resolveMise(deps)
  if (mise) {
    try {
      // cwd は Siftly ルートなので project の mise.toml が効く
      const { stdout } = await deps.execFile(mise, ['where', 'conda:ffmpeg'], { cwd: deps.cwd })
      const binDir = path.join(stdout.trim(), '.mise-bins')
      const bins = { ffmpeg: path.join(binDir, 'ffmpeg'), ffprobe: path.join(binDir, 'ffprobe') }
      if (await isExecutable(bins.ffmpeg, deps) && await isExecutable(bins.ffprobe, deps)) return bins
    } catch {
      // 未 trust / 未 install は下の例外に寄せる
    }
  }
  throw new Error(FFMPEG_NOT_FOUND_MESSAGE)
}

let cached: Promise<FfmpegBins> | null = null

/** findFfmpegBins を module スコープでキャッシュする。失敗はキャッシュしない (install 後の再試行を通す) */
export function resolveFfmpegBins(): Promise<FfmpegBins> {
  if (!cached) {
    cached = findFfmpegBins().catch((err) => {
      cached = null
      throw err
    })
  }
  return cached
}
