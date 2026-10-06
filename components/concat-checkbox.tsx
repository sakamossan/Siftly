'use client'

import type { BookmarkWithMedia } from '@/lib/types'
import { useConcatSelection, type ConcatSelectionItem } from '@/lib/concat-selection'

function isVideoUrl(url: string): boolean {
  return url.includes('video.twimg.com') || url.includes('.mp4')
}

/** 結合対象にできる media か。mp4 直リンクを持つ video / gif だけ */
export function isConcatable(item: BookmarkWithMedia['mediaItems'][number] | null): boolean {
  return item !== null && (item.type === 'video' || item.type === 'gif') && isVideoUrl(item.url)
}

function toSelectionItem(bookmark: BookmarkWithMedia, media: BookmarkWithMedia['mediaItems'][number]): ConcatSelectionItem {
  const thumb = media.thumbnailUrl && !isVideoUrl(media.thumbnailUrl) ? media.thumbnailUrl : undefined
  const text = bookmark.text.replace(/https?:\/\/t\.co\/[^\s]+/g, '').trim().slice(0, 60)
  return {
    url: media.url,
    type: media.type as ConcatSelectionItem['type'],
    mediaId: media.id,
    tweetId: bookmark.tweetId,
    authorHandle: bookmark.authorHandle,
    ...(thumb ? { thumb } : {}),
    ...(text ? { text } : {}),
  }
}

interface ConcatCheckboxProps {
  bookmark: BookmarkWithMedia
  className?: string
}

/** first media を動画結合の選択に出し入れする。選択中は選んだ順の番号を出す */
export default function ConcatCheckbox({ bookmark, className = '' }: ConcatCheckboxProps) {
  const { items, toggle } = useConcatSelection()
  const media = bookmark.mediaItems[0] ?? null
  if (!media || !isConcatable(media)) return null

  const index = items.findIndex((x) => x.url === media.url)
  const selected = index >= 0

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={selected ? `結合の選択から外す (${index + 1} 番目)` : '結合に選ぶ'}
      title={selected ? `結合の ${index + 1} 番目` : '結合に選ぶ'}
      // 行の role=button とカード内の <video> を発火させない
      onClick={(e) => { e.stopPropagation(); toggle(toSelectionItem(bookmark, media)) }}
      onKeyDown={(e) => e.stopPropagation()}
      className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold tabular-nums transition-colors ${
        selected
          ? 'bg-indigo-600 border border-indigo-400 text-white'
          : 'bg-black/50 border border-zinc-500 hover:border-zinc-300 text-transparent'
      } ${className}`}
    >
      {selected ? index + 1 : ''}
    </button>
  )
}
