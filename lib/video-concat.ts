import { execFile } from 'child_process'
import { createWriteStream } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import { promisify } from 'util'
import type { FfmpegBins } from '@/lib/ffmpeg-bin'
import { TWIMG_FETCH_HEADERS } from '@/lib/twimg-headers'

const execFileAsync = promisify(execFile)

export type ConcatMediaType = 'video' | 'gif'

export interface ConcatItem {
  url: string
  type: ConcatMediaType
}

export interface SkippedItem {
  url: string
  reason: string
}

export interface ConcatResult {
  included: string[]
  skipped: SkippedItem[]
}

/** 入力の不備。route では 400 にする */
export class ConcatInputError extends Error {}

/** 1 本も結合できなかった。route では 502 にする */
export class ConcatAllFailedError extends Error {
  constructor(readonly skipped: SkippedItem[]) {
    super('すべての動画の取得または正規化に失敗しました')
  }
}

// ── ffmpeg の引数 ─────────────────────────────────────────────────────────────

/** 1920x1080 横に収め、縦動画は左右に黒帯 (pillarbox) を付ける */
export const NORMALIZE_VF =
  'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30'

export const NORMALIZE_ENC = [
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-ar', '48000', '-ac', '2',
]

const COMMON_ARGS = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']

/**
 * 正規化の引数。-map は必ず video → audio の順にする。concat demuxer はクリップ間で
 * ストリームの並び順が揃っている前提で、食い違うと尺が壊れる。
 * 音声が無いものは anullsrc で無音トラックを足し、全クリップを音声ありに揃える。
 */
export function buildNormalizeArgs(input: string, output: string, hasAudio: boolean): string[] {
  const inputs = hasAudio
    ? ['-i', input, '-map', '0:v:0', '-map', '0:a:0']
    : ['-i', input, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v:0', '-map', '1:a:0', '-shortest']
  return [...COMMON_ARGS, ...inputs, '-vf', NORMALIZE_VF, ...NORMALIZE_ENC, output]
}

/** 音声ストリームの index を 1 行ずつ出す。出力が空なら音声無し */
export function buildProbeArgs(input: string): string[] {
  return ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', input]
}

export function buildConcatList(files: string[]): string {
  return files.map((f) => `file '${f}'\n`).join('')
}

/** output は .part で書くので拡張子から推定させず -f mp4 で指定する */
export function buildConcatArgs(list: string, output: string): string[] {
  return [...COMMON_ARGS, '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output]
}

/** 作業ファイル名。`'` が concat の list に入らないよう連番で命名する */
export function workFileName(i: number, prefix = 'n'): string {
  return `${prefix}${String(i).padStart(4, '0')}.mp4`
}

// ── 入力の検証 ───────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function timestampName(now: Date): string {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
}

/** 出力ファイル名 (拡張子なし)。空ならローカル時刻の YYYYMMDD-HHMMSS */
export function resolveOutputName(input: unknown, now: Date): string {
  if (input !== undefined && input !== null && typeof input !== 'string') {
    throw new ConcatInputError('name は文字列で指定してください')
  }
  const name = (input ?? '').trim().replace(/\.mp4$/i, '')
  if (name === '') return timestampName(now)
  if (/[/\\\u0000-\u001f\u007f]/.test(name) || name.startsWith('.') || name.includes('..')) {
    throw new ConcatInputError(`ファイル名に使えない文字が含まれています: ${name}`)
  }
  return name
}

function isConcatMediaType(type: unknown): type is ConcatMediaType {
  return type === 'video' || type === 'gif'
}

function isTwimgVideoUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'https:' && hostname === 'video.twimg.com'
  } catch {
    return false
  }
}

export function validateItems(items: unknown): ConcatItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ConcatInputError('items に 1 本以上の動画を指定してください')
  }
  return items.map((item, i) => {
    const { url, type } = (item ?? {}) as { url?: unknown; type?: unknown }
    if (!isTwimgVideoUrl(url)) throw new ConcatInputError(`items[${i}].url が video.twimg.com の https URL ではありません`)
    if (!isConcatMediaType(type)) throw new ConcatInputError(`items[${i}].type は video か gif です`)
    return { url, type }
  })
}

// ── 実処理 ───────────────────────────────────────────────────────────────────

export interface ConcatDeps {
  bins: FfmpegBins
  fetch: typeof fetch
  run: (file: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string }>
}

export function defaultRun(file: string, args: string[], options: { cwd: string }): Promise<{ stdout: string }> {
  return execFileAsync(file, args, { ...options, maxBuffer: 16 * 1024 * 1024 })
}

function errorReason(err: unknown): string {
  if (err instanceof Error) {
    // execFile の失敗は stderr を持つ。-loglevel error なので先頭行が原因になる
    const stderr = (err as Error & { stderr?: string }).stderr?.trim()
    return stderr ? stderr.split('\n')[0] : err.message
  }
  return String(err)
}

async function download(url: string, dest: string, deps: ConcatDeps): Promise<void> {
  const res = await deps.fetch(url, { headers: TWIMG_FETCH_HEADERS })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(dest))
}

async function hasAudioStream(input: string, cwd: string, deps: ConcatDeps): Promise<boolean> {
  const { stdout } = await deps.run(deps.bins.ffprobe, buildProbeArgs(input), { cwd })
  return stdout.trim() !== ''
}

/**
 * items を選んだ順に取得・正規化して outPath へ連結する。
 * 失敗した 1 本は skipped に積んで残りで続け、1 本も残らなければ ConcatAllFailedError。
 */
export async function concatVideos(items: ConcatItem[], outPath: string, deps: ConcatDeps): Promise<ConcatResult> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siftly-concat-'))
  try {
    const included: string[] = []
    const skipped: SkippedItem[] = []
    const normalized: string[] = []

    for (const [i, item] of items.entries()) {
      const raw = workFileName(i + 1, 'raw-')
      // 連番は成功した分だけで詰める
      const out = workFileName(normalized.length + 1)
      try {
        await download(item.url, path.join(workDir, raw), deps)
        const hasAudio = item.type === 'gif' ? false : await hasAudioStream(raw, workDir, deps)
        await deps.run(deps.bins.ffmpeg, buildNormalizeArgs(raw, out, hasAudio), { cwd: workDir })
        normalized.push(out)
        included.push(item.url)
      } catch (err) {
        skipped.push({ url: item.url, reason: errorReason(err) })
      } finally {
        await fs.rm(path.join(workDir, raw), { force: true })
      }
    }

    if (normalized.length === 0) throw new ConcatAllFailedError(skipped)

    await fs.writeFile(path.join(workDir, 'list.txt'), buildConcatList(normalized))
    // 途中で落ちても完成品と見分けが付くよう .part に書いてから rename する
    const partPath = `${outPath}.part`
    try {
      await deps.run(deps.bins.ffmpeg, buildConcatArgs('list.txt', partPath), { cwd: workDir })
      await fs.rename(partPath, outPath)
    } catch (err) {
      await fs.rm(partPath, { force: true })
      throw err
    }
    return { included, skipped }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true })
  }
}
