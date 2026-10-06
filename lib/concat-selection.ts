'use client'

import { useCallback, useSyncExternalStore } from 'react'

/** 動画結合のために選んだ動画。選んだ順に並ぶ。キーは url (同じ動画が複数の bookmark に出るため) */
export interface ConcatSelectionItem {
  url: string
  type: 'video' | 'gif'
  mediaId: string
  tweetId: string
  authorHandle: string
  thumb?: string
  /** 本文の先頭 60 字 */
  text?: string
}

export const STORAGE_KEY = 'siftly-concat-selection'

// ── 純粋関数 ─────────────────────────────────────────────────────────────────

/** 未選択なら末尾に足し、選択済みなら取り除く */
export function toggle(list: ConcatSelectionItem[], item: ConcatSelectionItem): ConcatSelectionItem[] {
  return list.some((x) => x.url === item.url)
    ? list.filter((x) => x.url !== item.url)
    : [...list, item]
}

export function remove(list: ConcatSelectionItem[], url: string): ConcatSelectionItem[] {
  return list.filter((x) => x.url !== url)
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

function isSelectionItem(v: unknown): v is ConcatSelectionItem {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.url === 'string' &&
    (o.type === 'video' || o.type === 'gif') &&
    typeof o.mediaId === 'string' &&
    typeof o.tweetId === 'string' &&
    typeof o.authorHandle === 'string' &&
    isOptionalString(o.thumb) &&
    isOptionalString(o.text)
}

/** localStorage の値を読む。壊れた JSON は [] にし、型の違う要素は捨てる */
export function parse(raw: string | null): ConcatSelectionItem[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter(isSelectionItem) : []
  } catch {
    return []
  }
}

// ── store ────────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>()
const EMPTY: ConcatSelectionItem[] = []
let cache: { raw: string | null; items: ConcatSelectionItem[] } = { raw: null, items: EMPTY }

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function getSnapshot(): ConcatSelectionItem[] {
  const raw = readRaw()
  // raw 文字列が同じなら同じ参照を返す (useSyncExternalStore の再描画ループを避ける)
  if (raw !== cache.raw) cache = { raw, items: parse(raw) }
  return cache.items
}

function getServerSnapshot(): ConcatSelectionItem[] {
  return EMPTY
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // 別タブでの変更を拾う
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

function write(update: (list: ConcatSelectionItem[]) => ConcatSelectionItem[]) {
  const next = update(getSnapshot())
  try {
    if (next.length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch { /* ignore */ }
  listeners.forEach((l) => l())
}

export function useConcatSelection() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const has = useCallback((url: string) => items.some((x) => x.url === url), [items])
  return {
    items,
    has,
    toggle: useCallback((item: ConcatSelectionItem) => write((list) => toggle(list, item)), []),
    remove: useCallback((url: string) => write((list) => remove(list, url)), []),
    removeMany: useCallback((urls: string[]) => {
      const drop = new Set(urls)
      write((list) => list.filter((x) => !drop.has(x.url)))
    }, []),
    clear: useCallback(() => write(() => []), []),
  }
}
