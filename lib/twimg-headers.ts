/**
 * video.twimg.com / pbs.twimg.com から取得するときのヘッダ。
 * Referer と UA が無いと上流が 403 を返すので、/api/media と動画結合 (lib/video-concat.ts) で共通にする。
 */
export const TWIMG_FETCH_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Referer': 'https://twitter.com/',
  'Origin': 'https://twitter.com',
  'Accept': '*/*',
}
