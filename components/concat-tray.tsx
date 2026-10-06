'use client'

import { useState } from 'react'
import { Film, Loader2, Play, X } from 'lucide-react'
import { useConcatSelection } from '@/lib/concat-selection'

interface ConcatResponse {
  path?: string
  included?: string[]
  skipped?: { url: string; reason: string }[]
  error?: string
}

type TrayStatus =
  | { kind: 'idle' }
  | { kind: 'done'; path: string; included: number; skipped: { url: string; reason: string }[] }
  | { kind: 'error'; message: string; skipped: { url: string; reason: string }[] }

// components/nav.tsx の <aside> の幅と揃える
const NAV_WIDTH = '228px'

/** 動画結合の選択トレイ。選択 0 件かつ結果表示も無いときは描画しない */
export default function ConcatTray() {
  const { items, remove, removeMany, clear } = useConcatSelection()
  const [name, setName] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<TrayStatus>({ kind: 'idle' })

  if (items.length === 0 && status.kind === 'idle') return null

  async function handleConcat() {
    setRunning(true)
    setStatus({ kind: 'idle' })
    try {
      const res = await fetch('/api/concat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map(({ url, type }) => ({ url, type })), name }),
      })
      const data = await res.json() as ConcatResponse
      if (!res.ok || !data.path) {
        setStatus({ kind: 'error', message: data.error ?? `HTTP ${res.status}`, skipped: data.skipped ?? [] })
        return
      }
      // 結合できた分だけ外し、skip した分は選択に残す
      removeMany(data.included ?? [])
      setName('')
      setStatus({ kind: 'done', path: data.path, included: data.included?.length ?? 0, skipped: data.skipped ?? [] })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err), skipped: [] })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div
      className="fixed bottom-0 right-0 z-40 border-t border-zinc-800 bg-zinc-900/95 backdrop-blur-sm px-6 py-3"
      style={{ left: NAV_WIDTH }}
    >
      {items.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="shrink-0 flex items-center gap-1.5 text-sm text-zinc-300">
            <Film size={14} className="text-indigo-400" />
            <span className="font-semibold tabular-nums">{items.length}</span>
            <span className="text-zinc-500">本</span>
          </div>

          {/* 選んだ順の一覧 */}
          <ol className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto">
            {items.map((item, i) => (
              <li
                key={item.url}
                className="shrink-0 flex items-center gap-2 max-w-56 pl-1 pr-1.5 py-1 rounded-lg bg-zinc-800/70 border border-zinc-700/50"
                title={item.text}
              >
                <span className="shrink-0 w-4 text-center text-[10px] font-bold text-indigo-300 tabular-nums">{i + 1}</span>
                {item.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media?url=${encodeURIComponent(item.thumb)}`}
                    alt=""
                    className="shrink-0 w-8 h-8 rounded object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="shrink-0 w-8 h-8 rounded flex items-center justify-center bg-zinc-700/60">
                    <Play size={10} className="text-zinc-400" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-[10px] text-zinc-400 truncate">@{item.authorHandle}</p>
                  <p className="text-[11px] text-zinc-300 truncate">{item.text ?? (item.type === 'gif' ? 'GIF' : 'Video')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => remove(item.url)}
                  disabled={running}
                  className="shrink-0 p-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                  aria-label="選択から外す"
                >
                  <X size={11} />
                </button>
              </li>
            ))}
          </ol>

          <button
            type="button"
            onClick={clear}
            disabled={running}
            className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 disabled:opacity-50"
          >
            全解除
          </button>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="YYYYMMDD-HHMMSS"
            disabled={running}
            className="shrink-0 w-44 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleConcat}
            disabled={running}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
          >
            {running && <Loader2 size={12} className="animate-spin" />}
            結合
          </button>
        </div>
      )}

      {status.kind !== 'idle' && (
        <div className={`flex items-start gap-2 text-xs ${items.length > 0 ? 'mt-2' : ''}`}>
          <div className="flex-1 min-w-0">
            {status.kind === 'done' ? (
              <p className="text-emerald-400">
                {status.path} に {status.included} 本を結合しました
                {status.skipped.length > 0 && <span className="text-amber-400"> (skipped {status.skipped.length})</span>}
              </p>
            ) : (
              <p className="text-red-400">{status.message}</p>
            )}
            {status.skipped.map((s) => (
              <p key={s.url} className="text-zinc-500 truncate" title={s.url}>skip: {s.reason} — {s.url}</p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setStatus({ kind: 'idle' })}
            className="shrink-0 p-0.5 rounded text-zinc-500 hover:text-zinc-200"
            aria-label="結果を閉じる"
          >
            <X size={11} />
          </button>
        </div>
      )}
    </div>
  )
}
