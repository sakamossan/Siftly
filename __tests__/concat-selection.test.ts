import { describe, it, expect } from 'vitest'
import { parse, remove, toggle, type ConcatSelectionItem } from '@/lib/concat-selection'

function item(n: number): ConcatSelectionItem {
  return { url: `https://video.twimg.com/${n}.mp4`, type: 'video', mediaId: `m${n}`, tweetId: `t${n}`, authorHandle: 'a' }
}

describe('toggle', () => {
  it('選んだ順に末尾へ足す', () => {
    expect(toggle(toggle(toggle([], item(3)), item(1)), item(2)).map((x) => x.mediaId)).toEqual(['m3', 'm1', 'm2'])
  })

  it('同じ url の 2 回目は除去になり、残りの順序は保つ', () => {
    const list = [item(1), item(2), item(3)]
    expect(toggle(list, item(2)).map((x) => x.mediaId)).toEqual(['m1', 'm3'])
  })

  it('url が同じなら mediaId が違っても同じ動画として扱う', () => {
    const other = { ...item(1), mediaId: 'other', tweetId: 'other' }
    expect(toggle([item(1)], other)).toEqual([])
  })
})

describe('remove', () => {
  it('url で取り除く', () => {
    expect(remove([item(1), item(2)], item(1).url)).toEqual([item(2)])
  })
})

describe('parse', () => {
  it('正しい値を読む', () => {
    const list = [item(1), { ...item(2), type: 'gif' as const, thumb: 'https://pbs.twimg.com/a.jpg', text: 'hi' }]
    expect(parse(JSON.stringify(list))).toEqual(list)
  })

  it.each([null, '', '{', 'null', '{"url":"x"}', '42'])('%j は []', (raw) => {
    expect(parse(raw)).toEqual([])
  })

  it('型の違う要素は捨てる', () => {
    const raw = JSON.stringify([item(1), { ...item(2), type: 'photo' }, { url: 1 }, null, { ...item(3), thumb: 3 }])
    expect(parse(raw)).toEqual([item(1)])
  })
})
