import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findFfmpegBins, type FfmpegBins } from '@/lib/ffmpeg-bin'
import {
  ConcatInputError,
  NORMALIZE_ENC,
  NORMALIZE_VF,
  buildConcatArgs,
  buildConcatList,
  buildNormalizeArgs,
  buildProbeArgs,
  concatVideos,
  defaultRun,
  resolveOutputName,
  validateItems,
  workFileName,
} from '@/lib/video-concat'

const execFileAsync = promisify(execFile)

function mapsOf(args: string[]): string[] {
  return args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []))
}

describe('buildNormalizeArgs', () => {
  it('音声ありは入力の video → audio の順に map する', () => {
    const args = buildNormalizeArgs('raw-0001.mp4', 'n0001.mp4', true)
    expect(mapsOf(args)).toEqual(['0:v:0', '0:a:0'])
    expect(args).not.toContain('anullsrc=r=48000:cl=stereo')
    expect(args.slice(args.indexOf('-vf'), -1)).toEqual(['-vf', NORMALIZE_VF, ...NORMALIZE_ENC])
    expect(args.at(-1)).toBe('n0001.mp4')
  })

  it('音声無しは anullsrc を足して video → 無音 audio の順に map する', () => {
    const args = buildNormalizeArgs('raw-0001.mp4', 'n0001.mp4', false)
    expect(mapsOf(args)).toEqual(['0:v:0', '1:a:0'])
    expect(args).toContain('anullsrc=r=48000:cl=stereo')
    expect(args).toContain('-shortest')
    expect(args.slice(args.indexOf('-vf'), -1)).toEqual(['-vf', NORMALIZE_VF, ...NORMALIZE_ENC])
  })

  it('共通オプションを先頭に付ける', () => {
    expect(buildNormalizeArgs('a', 'b', true).slice(0, 5)).toEqual(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'])
  })

  it('1920x1080 / 30fps / h264 + aac 48kHz stereo', () => {
    expect(NORMALIZE_VF).toBe('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30')
    expect(NORMALIZE_ENC.join(' ')).toBe('-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2')
  })
})

describe('probe / concat の引数', () => {
  it('buildProbeArgs は音声ストリームの index だけを出す', () => {
    expect(buildProbeArgs('in.mp4')).toEqual(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', 'in.mp4'])
  })

  it('buildConcatList は 1 行 1 ファイル', () => {
    expect(buildConcatList([workFileName(1), workFileName(2)])).toBe("file 'n0001.mp4'\nfile 'n0002.mp4'\n")
  })

  it('buildConcatArgs は stream copy で faststart、形式は mp4 固定', () => {
    expect(buildConcatArgs('list.txt', 'out.mp4').slice(5)).toEqual(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', 'out.mp4'])
  })

  it('workFileName は 4 桁ゼロ埋め', () => {
    expect(workFileName(1)).toBe('n0001.mp4')
    expect(workFileName(123)).toBe('n0123.mp4')
    expect(workFileName(7, 'raw-')).toBe('raw-0007.mp4')
  })
})

describe('resolveOutputName', () => {
  const now = new Date(2026, 9, 6, 9, 5, 3)

  it('空ならローカル時刻の YYYYMMDD-HHMMSS', () => {
    expect(resolveOutputName('', now)).toBe('20261006-090503')
    expect(resolveOutputName(undefined, now)).toBe('20261006-090503')
    expect(resolveOutputName('   ', now)).toBe('20261006-090503')
  })

  it('末尾の .mp4 を剥がす', () => {
    expect(resolveOutputName('weekly.mp4', now)).toBe('weekly')
    expect(resolveOutputName('猫まとめ.MP4', now)).toBe('猫まとめ')
  })

  it.each(['../x', 'a/b', 'a\\b', '.hidden', 'a..b', 'a\nb', 'a\u0000b'])('%j を拒否する', (name) => {
    expect(() => resolveOutputName(name, now)).toThrow(ConcatInputError)
  })

  it('文字列以外を拒否する', () => {
    expect(() => resolveOutputName(1, now)).toThrow(ConcatInputError)
  })
})

describe('validateItems', () => {
  const ok = { url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/720x1280/a.mp4?tag=12', type: 'video' }

  it('video.twimg.com の video / gif を通す', () => {
    const gif = { url: 'https://video.twimg.com/tweet_video/abc.mp4', type: 'gif' }
    expect(validateItems([ok, gif])).toEqual([ok, gif])
  })

  it('余計なフィールドは落とす', () => {
    expect(validateItems([{ ...ok, extra: 1 }])).toEqual([ok])
  })

  it.each([
    ['空配列', []],
    ['配列でない', 'x'],
    ['twimg 以外の host', [{ ...ok, url: 'https://example.com/a.mp4' }]],
    ['pbs.twimg.com', [{ ...ok, url: 'https://pbs.twimg.com/media/a.jpg' }]],
    ['http', [{ ...ok, url: 'http://video.twimg.com/a.mp4' }]],
    ['未知の type', [{ ...ok, type: 'photo' }]],
    ['null 要素', [null]],
  ])('%s を拒否する', (_, items) => {
    expect(() => validateItems(items)).toThrow(ConcatInputError)
  })
})

// ── 統合テスト: ffmpeg が解決できるときだけ ─────────────────────────────────

const bins: FfmpegBins | null = await findFfmpegBins().catch(() => null)

describe.skipIf(!bins)('concatVideos (ffmpeg)', () => {
  let dir: string
  const sources: Record<string, string> = {}

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siftly-concat-test-'))
    const lavfi = (spec: string) => ['-f', 'lavfi', '-i', spec]
    // 横長 (音あり 2 秒) と縦長 (音無し 1.5 秒)
    sources.landscape = path.join(dir, 'landscape.mp4')
    await execFileAsync(bins!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      ...lavfi('testsrc=size=1280x720:rate=25:duration=2'), ...lavfi('sine=frequency=440:sample_rate=44100:duration=2'),
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', sources.landscape])
    sources.portrait = path.join(dir, 'portrait.mp4')
    await execFileAsync(bins!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      ...lavfi('testsrc=size=720x1280:rate=30:duration=1.5'), '-c:v', 'libx264', sources.portrait])
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  // url の末尾をローカルの素材名として返す fetch。missing は 404
  const fakeFetch = (async (input: string | URL | Request) => {
    const name = String(input).split('/').pop()!.replace(/\.mp4$/, '')
    const file = sources[name]
    if (!file) return new Response(null, { status: 404 })
    return new Response(await fs.readFile(file), { status: 200 })
  }) as typeof fetch

  it('選んだ順に 1920x1080 / 30fps / aac 48k で連結し、失敗した 1 本は skip する', async () => {
    const out = path.join(dir, 'out.mp4')
    const items = [
      { url: 'https://video.twimg.com/x/landscape.mp4', type: 'video' as const },
      { url: 'https://video.twimg.com/x/missing.mp4', type: 'video' as const },
      { url: 'https://video.twimg.com/x/portrait.mp4', type: 'video' as const },
    ]
    const result = await concatVideos(items, out, { bins: bins!, fetch: fakeFetch, run: defaultRun })
    expect(result.included).toEqual([items[0].url, items[2].url])
    expect(result.skipped).toEqual([{ url: items[1].url, reason: 'HTTP 404' }])

    const { stdout } = await execFileAsync(bins!.ffprobe, ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration', '-of', 'json', out])
    const probe = JSON.parse(stdout) as {
      streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }[]
      format: { duration: string }
    }
    const video = probe.streams.find((s) => s.codec_type === 'video')!
    const audio = probe.streams.find((s) => s.codec_type === 'audio')!
    expect(video).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1' })
    expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
    expect(Number(probe.format.duration)).toBeGreaterThan(3.3)
    expect(Number(probe.format.duration)).toBeLessThan(3.8)
    await expect(fs.access(`${out}.part`)).rejects.toThrow()
  }, 60_000)

  it('全件失敗は ConcatAllFailedError', async () => {
    const out = path.join(dir, 'none.mp4')
    await expect(concatVideos([{ url: 'https://video.twimg.com/x/missing.mp4', type: 'gif' }], out,
      { bins: bins!, fetch: fakeFetch, run: defaultRun })).rejects.toMatchObject({ skipped: [{ reason: 'HTTP 404' }] })
    await expect(fs.access(out)).rejects.toThrow()
  })
})
