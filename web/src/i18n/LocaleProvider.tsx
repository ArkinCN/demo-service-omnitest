import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { LocaleContext, initialLocale, LOCALE_STORAGE_KEY } from './locale'
import type { Locale } from './runtime'
const originalDocumentTitle = document.title

/** This provider has no business state and never remounts its children on a language change. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  useEffect(() => {
    document.documentElement.lang = locale
    document.title = locale === 'en' ? 'OmniTest · Industrial Automated Testing' : originalDocumentTitle
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* Session preference still works. */ }
  }, [locale])
  const value = useMemo(() => ({ locale, setLocale }), [locale])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

