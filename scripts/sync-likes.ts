#!/usr/bin/env npx tsx
/**
 * Chrome Canary を使って x.com のいいね履歴をキャプチャし、Siftly にインポートする
 *
 * 初回は x.com へのログインが必要 (セッションは .playwright-session/ に保存される)
 * 通常の Chrome を閉じる必要はない (Canary は別プロセス)
 *
 * Usage:
 *   npx tsx scripts/sync-likes.ts --username <handle>             # 差分取得 (前回の続きから)
 *   npx tsx scripts/sync-likes.ts --username <handle> --init      # 同期地点を保存 (取得はしない)
 *   npx tsx scripts/sync-likes.ts --username <handle> --no-post   # JSON ファイル保存のみ
 *   npx tsx scripts/sync-likes.ts --username <handle> --login     # セッション再取得
 *   npx tsx scripts/sync-likes.ts --username <handle> --headed    # ブラウザを表示して実行
 */

import { chromium, type Page } from 'playwright'
import { existsSync, readFileSync, writeFileSync as fsWriteFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

// ── Config ──

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROFILE_DIR = resolve(__dirname, '..', '.playwright-session', 'canary-profile')
const SIFTLY_URL = process.env.SIFTLY_URL || 'http://localhost:3000'
const CHROME_CANARY = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
const SCROLL_INTERVAL_MS = 900
const STAGNATION_THRESHOLD = 8
const STAGNATION_EXTRA_WAIT_MS = 2000
const SESSION_DIR = resolve(__dirname, '..', '.playwright-session')

// ── Sync state (前回の最新ツイートIDを保存) ──

interface SyncState {
  lastTweetId: string
  syncedAt: string
}

function syncStatePath(username: string): string {
  return resolve(SESSION_DIR, `last-sync-${username}.json`)
}

function loadSyncState(username: string): SyncState | null {
  const path = syncStatePath(username)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function saveSyncState(username: string, lastTweetId: string): void {
  mkdirSync(SESSION_DIR, { recursive: true })
  const state: SyncState = { lastTweetId, syncedAt: new Date().toISOString() }
  fsWriteFileSync(syncStatePath(username), JSON.stringify(state, null, 2))
}

// ── CLI args ──

function parseArgs() {
  const args = process.argv.slice(2)
  let username = ''
  let noPost = false
  let forceLogin = false
  let init = false
  let headed = false

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--username':
      case '-u':
        username = args[++i] ?? ''
        break
      case '--no-post':
        noPost = true
        break
      case '--login':
        forceLogin = true
        break
      case '--init':
        init = true
        break
      case '--headed':
        headed = true
        break
    }
  }

  if (!username) {
    console.error('Usage: npx tsx scripts/sync-likes.ts --username <handle>')
    console.error('')
    console.error('Options:')
    console.error('  --username, -u <handle>   X のユーザー名 (必須)')
    console.error('  --init                    同期地点だけ保存して終了 (次回から差分取得)')
    console.error('  --no-post                 Siftly に POST せず JSON ファイルに保存')
    console.error('  --login                   セッションを再取得')
    console.error('  --headed                  ブラウザを表示して実行 (既定は headless)')
    process.exit(1)
  }

  username = username.replace(/^@/, '')
  return { username, noPost, forceLogin, init, headed }
}

// ── Helpers ──

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close()
      resolve()
    })
  })
}

function hasSession(): boolean {
  return existsSync(PROFILE_DIR)
}

// ── Injection script (derived from BOOKMARKLET_SCRIPT in app/import/page.tsx) ──

const INJECT_SCRIPT = `
(function() {
  window.__siftlyTweets = [];
  window.__siftlySeen = new Set();
  window.__siftlyCount = 0;
  // 前回同期時の最新ツイートID (addInitScript で埋め込み)
  window.__siftlyStopAtId = null;
  // 前回同期済みのツイートに到達したかどうか
  window.__siftlyHitLastSync = false;

  function addTweet(t) {
    if (!t || !t.rest_id || window.__siftlySeen.has(t.rest_id)) return;
    // 前回の最新ツイートに到達したらフラグを立てて、それ以降は追加しない
    if (window.__siftlyStopAtId && t.rest_id === window.__siftlyStopAtId) {
      window.__siftlyHitLastSync = true;
      return;
    }
    if (window.__siftlyHitLastSync) return;

    window.__siftlySeen.add(t.rest_id);
    var leg = t.legacy || {};
    var usr = (t.core && t.core.user_results && t.core.user_results.result && t.core.user_results.result.legacy) || {};
    var rawMedia = (leg.extended_entities && leg.extended_entities.media) || (leg.entities && leg.entities.media) || [];
    var media = rawMedia.map(function(m) {
      var thumb = m.media_url_https || '';
      if (m.type === 'video' || m.type === 'animated_gif') {
        var variants = m.video_info && m.video_info.variants || [];
        var mp4s = variants.filter(function(v) { return v.content_type === 'video/mp4' && v.url; })
          .sort(function(a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
        if (mp4s.length) return { type: m.type === 'animated_gif' ? 'gif' : 'video', url: mp4s[0].url };
        if (thumb) return { type: 'photo', url: thumb };
        return null;
      }
      return thumb ? { type: 'photo', url: thumb } : null;
    }).filter(Boolean);

    window.__siftlyTweets.push({
      id: t.rest_id,
      author: usr.name || 'Unknown',
      handle: '@' + (usr.screen_name || 'unknown'),
      avatar: usr.profile_image_url_https || '',
      timestamp: leg.created_at || '',
      text: leg.full_text || leg.text || '',
      media: media,
      hashtags: (leg.entities && leg.entities.hashtags || []).map(function(h) { return h.text; }),
      urls: (leg.entities && leg.entities.urls || []).map(function(u) { return u.expanded_url; }).filter(Boolean)
    });
    window.__siftlyCount = window.__siftlyTweets.length;
  }

  function isTweetObj(o) {
    if (!o || typeof o !== 'object') return false;
    if (typeof o.rest_id !== 'string' || o.rest_id.length < 15) return false;
    var leg = o.legacy;
    if (!leg) return false;
    // ツイートは full_text または text を必ず持つ (ユーザーオブジェクト等を除外)
    return leg.full_text !== undefined || leg.text !== undefined;
  }
  function unwrapTweet(t) {
    if (!t) return null;
    if (t.__typename === 'TweetWithVisibilityResults' || t.__typename === 'TweetWithVisibilityResult') return t.tweet || t;
    return t;
  }
  function deepFindTweets(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    if (Array.isArray(obj)) { obj.forEach(function(item) { deepFindTweets(item, depth + 1); }); return; }
    if (obj.tweet_results && obj.tweet_results.result) { var tw = unwrapTweet(obj.tweet_results.result); if (tw) addTweet(tw); }
    else if (isTweetObj(obj)) { addTweet(unwrapTweet(obj)); }
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && k !== 'quoted_status_result') {
        deepFindTweets(obj[k], depth + 1);
      }
    }
  }

  function isApiUrl(u) {
    return u.includes('/graphql/') || u.includes('/i/api/') || u.includes('/2/timeline');
  }

  var origFetch = window.fetch;
  window.fetch = async function() {
    var r = await origFetch.apply(this, arguments);
    try {
      var u = arguments[0] instanceof Request ? arguments[0].url : String(arguments[0]);
      if (isApiUrl(u)) {
        var ct = r.headers.get('content-type') || '';
        if (ct.includes('json')) {
          var d = await r.clone().json();
          deepFindTweets(d, 0);
        }
      }
    } catch (ex) {}
    return r;
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var xhrUrls = new WeakMap();
  XMLHttpRequest.prototype.open = function() {
    xhrUrls.set(this, String(arguments[1] || ''));
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    var xhr = this, u = xhrUrls.get(xhr) || '';
    if (isApiUrl(u)) {
      xhr.addEventListener('load', function() {
        try { deepFindTweets(JSON.parse(xhr.responseText), 0); } catch (ex) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
`

// ── Auto-scroll ──

async function autoScroll(page: Page): Promise<number> {
  let stagnant = 0
  let lastCount = 0

  while (true) {
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight)
      const col = document.querySelector('[data-testid="primaryColumn"]')
      if (col) col.scrollTo(0, col.scrollHeight)
    })

    await page.waitForTimeout(SCROLL_INTERVAL_MS)

    const currentCount: number = await page.evaluate(() => (window as any).__siftlyCount ?? 0)

    // 前回同期済みのツイートに到達したらスクロール停止
    const hitLastSync: boolean = await page.evaluate(() => (window as any).__siftlyHitLastSync ?? false)
    if (hitLastSync) {
      console.log(`  ✅ 前回の同期地点に到達: ${currentCount} tweets captured`)
      return currentCount
    }

    if (currentCount > lastCount) {
      if (currentCount % 50 === 0 || currentCount - lastCount >= 10) {
        console.log(`  📥 ${currentCount} tweets captured...`)
      }
      stagnant = 0
      lastCount = currentCount
    } else {
      stagnant++
      if (stagnant >= STAGNATION_THRESHOLD) {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        await page.waitForTimeout(STAGNATION_EXTRA_WAIT_MS)
        const finalCount: number = await page.evaluate(() => (window as any).__siftlyCount ?? 0)
        if (finalCount === lastCount) {
          console.log(`  ✅ スクロール完了: ${finalCount} tweets captured`)
          return finalCount
        }
        stagnant = 0
        lastCount = finalCount
      }
    }
  }
}

// ── POST to Siftly ──

async function postToSiftly(data: { bookmarks: unknown[]; source: string }): Promise<void> {
  const jsonStr = JSON.stringify(data)
  const blob = new Blob([jsonStr], { type: 'application/json' })

  const formData = new FormData()
  formData.append('file', blob, 'likes.json')
  formData.append('source', 'like')

  const url = `${SIFTLY_URL}/api/import`
  console.log(`📤 POST ${url} ...`)

  const res = await fetch(url, { method: 'POST', body: formData })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Import failed (${res.status}): ${text}`)
  }

  const result = await res.json()
  console.log(`✅ インポート完了:`)
  console.log(`   imported: ${result.imported}`)
  console.log(`   skipped:  ${result.skipped}`)
  console.log(`   parsed:   ${result.parsed}`)
}

// ── Main ──

async function main() {
  const { username, noPost, forceLogin, init, headed } = parseArgs()

  if (!existsSync(CHROME_CANARY)) {
    console.error('❌ Google Chrome Canary が見つかりません。')
    console.error('   https://www.google.com/chrome/canary/ からインストールしてください。')
    process.exit(1)
  }

  // Check Siftly server (unless --no-post or --init)
  if (!noPost && !init) {
    try {
      await fetch(`${SIFTLY_URL}/api/stats`)
    } catch {
      console.error(`❌ Siftly サーバー (${SIFTLY_URL}) に接続できません。\n   先に npm run dev を起動してください。`)
      process.exit(1)
    }
  }

  const needLogin = forceLogin || !hasSession()
  // ログイン時は人が x.com を操作するので必ず表示する。それ以外は --headed のときだけ表示。
  // executablePath 指定時の headless は chromium-headless-shell ではなく Chrome 実体の
  // --headless (new headless) になるので、cookie を持つ canary-profile をそのまま使える。
  const headless = !needLogin && !headed

  if (needLogin) {
    console.log('🔐 Chrome Canary でログインしてください (初回のみ)')
    console.log('   セッションは .playwright-session/ に保存されます')
  }

  if (init) {
    console.log('🏁 同期地点を設定します')
  } else {
    const state = loadSyncState(username)
    if (state) {
      console.log(`🔄 差分取得: 前回同期 ${state.syncedAt} (ID: ${state.lastTweetId}) 以降`)
    } else {
      console.log('⚠️  同期地点が未設定です。先に --init で同期地点を設定してください。')
      process.exit(1)
    }
  }
  console.log(`🚀 Chrome Canary で ${username} のいいね履歴をキャプチャ`)

  // launchPersistentContext: セッション (cookies等) が PROFILE_DIR に永続保存される
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME_CANARY,
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 900 },
  })

  const page = await context.newPage()

  try {
    if (needLogin) {
      // ログインフロー
      await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' })
      await waitForEnter('x.com にログイン完了後、Enter を押してください...')
    }

    // ページ読み込み前にインターセプトスクリプトを仕込む
    // stopAtId を init script に埋め込む (page.evaluate では初期ロードに間に合わない)
    const prevState = init ? null : loadSyncState(username)!
    const stopAtId = prevState?.lastTweetId ?? null
    const script = INJECT_SCRIPT.replace(
      'window.__siftlyStopAtId = null;',
      `window.__siftlyStopAtId = ${stopAtId ? `"${stopAtId}"` : 'null'};`
    )
    await page.addInitScript(script)
    console.log('📡 API インターセプト準備完了')

    const likesUrl = `https://x.com/${username}/likes`
    console.log(`🌐 ${likesUrl} を開いています...`)
    await page.goto(likesUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    await page.waitForTimeout(3000)

    // Check if redirected to login (session expired)
    if (page.url().includes('/login') || page.url().includes('/i/flow/login')) {
      console.error('❌ セッションが期限切れです。--login フラグで再ログインしてください。')
      if (headless) {
        console.error('   headless 実行を x.com が弾いている可能性もあります。--headed で再実行して切り分けてください。')
      }
      process.exit(1)
    }

    if (init) {
      // --init: 初期ロードの API レスポンスから同期地点を保存
      const tweets = await page.evaluate(() => (window as any).__siftlyTweets)
      if (tweets.length === 0) {
        console.log('⚠️  いいねが見つかりませんでした。')
        if (headless) console.log('   headless 実行を x.com が弾いている可能性があります。--headed で再実行してください。')
        process.exit(0)
      }
      saveSyncState(username, tweets[0].id)
      console.log(`✅ 同期地点を保存: ${tweets[0].id} (${tweets[0].timestamp})`)
      console.log('   次回実行時はこの地点以降の新しいいいねだけ取得します')
      return
    }

    console.log('📜 自動スクロール開始...')
    const count = await autoScroll(page)

    if (count === 0) {
      console.log('✅ 新しいいいねはありません')
      if (headless) console.log('   0 件が想定外なら headless を x.com が弾いた可能性があるので --headed で再実行してください。')
      // 同期地点は更新しない
      return
    }

    const tweets = await page.evaluate(() => (window as any).__siftlyTweets)
    const data = { bookmarks: tweets, source: 'like' as const }
    console.log(`📦 ${tweets.length} tweets を取得`)

    // 最新のツイートID (配列の先頭 = 最も最近いいねしたもの) を保存
    saveSyncState(username, tweets[0].id)
    console.log(`💾 同期地点を更新: ${tweets[0].id}`)

    if (noPost) {
      const { writeFileSync } = await import('fs')
      const outPath = `likes-${username}-${new Date().toISOString().slice(0, 10)}.json`
      writeFileSync(outPath, JSON.stringify(data, null, 2))
      console.log(`💾 ${outPath} に保存しました`)
    } else {
      await postToSiftly(data)
    }
  } finally {
    await page.close()
    await context.close()
  }
}

main().catch((err) => {
  console.error('❌ エラー:', err.message ?? err)
  process.exit(1)
})
