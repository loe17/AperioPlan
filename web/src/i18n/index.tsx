/**
 * Mehrsprachigkeit: Deutsch ist die Ausgangssprache. Weitere Sprachen sind einfache
 * Sprachdateien (Objekt "deutscher Text" -> Übersetzung), siehe en.ts.
 * Fehlt eine Übersetzung, wird der deutsche Text angezeigt.
 */
import { createContext, useContext, type ReactNode } from 'react';
import en from './en';

export const LANGUAGES: Record<string, { label: string; dict: Record<string, string> }> = {
  de: { label: 'Deutsch', dict: {} },
  en: { label: 'English', dict: en },
};

export type TFn = (text: string, vars?: Record<string, string | number>) => string;

const make = (lang: string): TFn => (text, vars) => {
  let s = LANGUAGES[lang]?.dict[text] ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  return s;
};

const Ctx = createContext<{ lang: string; t: TFn }>({ lang: 'de', t: make('de') });

export function I18nProvider({ lang, children }: { lang: string; children: ReactNode }) {
  document.documentElement.lang = lang;
  return <Ctx.Provider value={{ lang, t: make(lang) }}>{children}</Ctx.Provider>;
}

export const useT = () => useContext(Ctx).t;
export const useLang = () => useContext(Ctx).lang;
