#!/usr/bin/env npx tsx
/**
 * Chrome Canary を使って x.com のいいね履歴をキャプチャし、Siftly にインポートする
 *
 * 初回は x.com へのログインが必要 (セッションは .playwright-session/ に保存される)
 * 通常の Chrome を閉じる必要はない (Canary は別プロセス)
 *
 * Usage:
 *   npx tsx scripts/sync-likes.ts --username <handle>
 *   npx tsx scripts/sync-likes.ts --username <handle> --no-post   # JSON ファイル保存のみ
 *   npx tsx scripts/sync-likes.ts --username <handle> --login     # セッション再取得
 */

import { chromium, type Page } from 'playwright'
import { existsSync } from 'fs'
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

// ── CLI args ──

function parseArgs() {
  const args = process.argv.slice(2)
  let username = ''
  let noPost = false
  let forceLogin = false

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
    }
  }

  if (!username) {
    console.error('Usage: npx tsx scripts/sync-likes.ts --username <handle>')
    console.error('')
    console.error('Options:')
    console.error('  --username, -u <handle>   X のユーザー名 (必須)')
    console.error('  --no-post                 Siftly に POST せず JSON ファイルに保存')
    console.error('  --login                   セッションを再取得')
    process.exit(1)
  }

  username = username.replace(/^@/, '')
  return { username, noPost, forceLogin }
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

  function addTweet(t) {
    if (!t || !t.rest_id || window.__siftlySeen.has(t.rest_id)) return;
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
    return o && typeof o === 'object' && typeof o.rest_id === 'string' && o.rest_id.length > 5 && (o.legacy || o.core);
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
  const { username, noPost, forceLogin } = parseArgs()

  if (!existsSync(CHROME_CANARY)) {
    console.error('❌ Google Chrome Canary が見つかりません。')
    console.error('   https://www.google.com/chrome/canary/ からインストールしてください。')
    process.exit(1)
  }

  // Check Siftly server (unless --no-post)
  if (!noPost) {
    try {
      await fetch(`${SIFTLY_URL}/api/stats`)
    } catch {
      console.error(`❌ Siftly サーバー (${SIFTLY_URL}) に接続できません。\n   先に npm run dev を起動してください。`)
      process.exit(1)
    }
  }

  const needLogin = forceLogin || !hasSession()

  if (needLogin) {
    console.log('🔐 Chrome Canary でログインしてください (初回のみ)')
    console.log('   セッションは .playwright-session/ に保存されます')
  }

  console.log(`🚀 Chrome Canary で ${username} のいいね履歴をキャプチャ`)

  // launchPersistentContext: セッション (cookies等) が PROFILE_DIR に永続保存される
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME_CANARY,
    headless: false,
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

    const likesUrl = `https://x.com/${username}/likes`
    console.log(`🌐 ${likesUrl} を開いています...`)
    await page.goto(likesUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    await page.waitForTimeout(3000)

    // Check if redirected to login (session expired)
    if (page.url().includes('/login') || page.url().includes('/i/flow/login')) {
      console.error('❌ セッションが期限切れです。--login フラグで再ログインしてください。')
      process.exit(1)
    }

    // Inject the interception script
    await page.evaluate(INJECT_SCRIPT)
    console.log('📡 API インターセプト開始')

    // Scroll to top to trigger re-fetch (initial load wasn't intercepted)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(500)

    console.log('📜 自動スクロール開始...')
    const count = await autoScroll(page)

    if (count === 0) {
      console.log('⚠️  いいねが見つかりませんでした。')
      console.log('   ページが正しく読み込まれたか確認してください。')
      process.exit(0)
    }

    const tweets = await page.evaluate(() => (window as any).__siftlyTweets)
    const data = { bookmarks: tweets, source: 'like' as const }
    console.log(`📦 ${tweets.length} tweets を取得`)

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
