import { ENGLISH } from './catalog'
import { simp } from '../features/shared/zh'

export type Locale = 'zh-CN' | 'en'
export type TranslationParams = Record<string, string | number>
const normalizeKey = (source: string) => simp(source).replace(/\s+/g, ' ').trim()
const normalizedCatalog = Object.fromEntries(Object.entries(ENGLISH).map(([source, english]) => [normalizeKey(source), english]))

const templatePatterns = Object.entries(ENGLISH).filter(([source]) => /\{v\d+\}/.test(source)).map(([source, english]) => {
  const keys: string[] = []
  let pattern = '^'
  let position = 0
  for (const match of source.matchAll(/\{(v\d+)\}/g)) {
    pattern += source.slice(position, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\S]*?)'
    keys.push(match[1])
    position = match.index! + match[0].length
  }
  pattern += source.slice(position).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
  return { source, regex: new RegExp(pattern), keys, english }
}).sort((left, right) => right.source.replace(/\{v\d+\}/g, '').length - left.source.replace(/\{v\d+\}/g, '').length)

/** Translate only explicitly identified UI text. Parameters stay original data. */
export function translate(source: string, locale: Locale, params?: TranslationParams): string {
  if (!params && locale === 'en' && !/[\u3400-\u9fff]/.test(source)) return ENGLISH[source] ?? source
  let template = locale === 'en' ? ENGLISH[source] ?? source : source
  if (locale === 'en' && template === source && normalizedCatalog[normalizeKey(source)]) {
    template = source.replace(source.trim(), normalizedCatalog[normalizeKey(source)])
  }
  if (locale === 'en' && !params && template === source && !ENGLISH[source]) {
    for (const entry of templatePatterns) {
      const match = entry.regex.exec(source)
      if (!match) continue
      const captured = Object.fromEntries(entry.keys.map((key, index) => [key, match[index + 1]]))
      return entry.english.replace(/\{(v\d+)\}/g, (token, key: string) => captured[key] ?? token)
    }
  }
  return params ? template.replace(/\{([\w]+)\}/g, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : token) : template
}

/** Convert newly authored UI text into a stable approved template and raw parameters. */
export function describeUiTranslation(source: string): { key: string; params?: TranslationParams } {
  if (Object.prototype.hasOwnProperty.call(ENGLISH, source)) return { key: source }
  for (const entry of templatePatterns) {
    const match = entry.regex.exec(source)
    if (!match) continue
    return { key: entry.source, params: Object.fromEntries(entry.keys.map((key, index) => [key, match[index + 1]])) }
  }
  return { key: source }
}
