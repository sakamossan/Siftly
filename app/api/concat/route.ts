import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { resolveFfmpegBins } from '@/lib/ffmpeg-bin'
import {
  ConcatAllFailedError,
  ConcatInputError,
  concatVideos,
  defaultRun,
  resolveOutputName,
  validateItems,
} from '@/lib/video-concat'

export const runtime = 'nodejs'

const OUTPUT_DIR = path.join(os.homedir(), 'Movies', 'x-likes')

// ffmpeg を並走させないよう 1 本ずつに絞る
let running = false

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let items
  let name
  try {
    const body = await request.json() as { items?: unknown; name?: unknown }
    items = validateItems(body.items)
    name = resolveOutputName(body.name, new Date())
  } catch (err) {
    const message = err instanceof ConcatInputError ? err.message : 'Invalid JSON body'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  if (running) {
    return NextResponse.json({ error: '別の結合が実行中です' }, { status: 409 })
  }
  running = true
  try {
    let bins
    try {
      bins = await resolveFfmpegBins()
    } catch (err) {
      console.error('Concat ffmpeg resolve error:', err)
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true })
    const outPath = path.join(OUTPUT_DIR, `${name}.mp4`)
    if (await exists(outPath)) {
      return NextResponse.json({ error: `同名のファイルがあります: ${outPath}` }, { status: 409 })
    }

    const { included, skipped } = await concatVideos(items, outPath, { bins, fetch, run: defaultRun })
    return NextResponse.json({ path: outPath, included, skipped })
  } catch (err) {
    if (err instanceof ConcatAllFailedError) {
      return NextResponse.json({ error: err.message, skipped: err.skipped }, { status: 502 })
    }
    console.error('Concat error:', err)
    return NextResponse.json(
      { error: `Failed to concat videos: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  } finally {
    running = false
  }
}
