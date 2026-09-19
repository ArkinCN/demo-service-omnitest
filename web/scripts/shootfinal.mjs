/**
 * 收尾交付截图：六页 1920×1080 + 1440×810，放大态三张，汽车包两张，对照拼图一张。
 *   npm run build && npm run preview   然后   node scripts/shootfinal.mjs
 * 环境变量：BASE（默认 http://localhost:4173）、ONLY（只出某一张）、PREFIX（默认 final）
 */
import { chromium } from 'playwright'
import { globSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:4173'
const OUT = new URL('../shots2/', import.meta.url).pathname
const P = process.env.PREFIX ?? 'final'
mkdirSync(OUT, { recursive: true })

const exe = globSync(`${process.env.HOME}/.cache/puppeteer/chrome/*/chrome-linux64/chrome`).sort().at(-1)
if (!exe) throw new Error('本机未找到 Chrome')

const MOTOR = 'motor.cooling-fan.fortior-fu6832'
const AUTO = 'automotive.body-motor.window-regulator'
const PAGES = [
  ['kb', '/kb'],
  ['init', '/init'],
  ['req', '/requirements'],
  ['run', '/run'],
  ['tune', '/tune'],
  ['report', '/report'],
]

/** 放大态：点开某张卡的「放大」按钮再截 */
const ZOOM = [
  ['zoom-canvas', '/requirements', 0],
  ['zoom-timeseries', '/run', 0],
  ['zoom-evidence', '/kb', 1],
]

const SHOTS = []
for (const [n, path] of PAGES) {
  SHOTS.push({ name: `${P}-${n}`, path, scene: MOTOR, w: 1920, h: 1080 })
  SHOTS.push({ name: `${P}-${n}-1440`, path, scene: MOTOR, w: 1440, h: 810 })
}
for (const [n, path, slot] of ZOOM) {
  SHOTS.push({ name: `${P}-${n}`, path, scene: MOTOR, w: 1920, h: 1080, zoom: slot })
}
SHOTS.push({ name: `${P}-auto-run`, path: '/run', scene: AUTO, w: 1920, h: 1080 })
SHOTS.push({ name: `${P}-auto-init`, path: '/init', scene: AUTO, w: 1920, h: 1080 })

const ONLY = process.env.ONLY
const browser = await chromium.launch({ executablePath: exe, args: ['--force-device-scale-factor=1'] })
for (const s of SHOTS) {
  if (ONLY && !s.name.includes(ONLY)) continue
  const page = await browser.newPage({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 })
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text().slice(0, 160)))
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)))
  await page.goto(`${BASE}${s.path}?scene=${s.scene}`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(4200)
  if (s.zoom != null) {
    const btns = page.locator('[aria-label$="放大"]')
    await btns.nth(s.zoom).click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(1400)
  }
  await page.screenshot({ path: `${OUT}${s.name}.png` })
  console.log('✓', `${s.name}.png ${s.w}×${s.h}`)
  await page.close()
}
await browser.close()
