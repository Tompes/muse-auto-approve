/*
** Message catalogs and translation for the popup.
**
** chrome.i18n always follows the browser's UI language and cannot be
** switched at run time, so the popup loads the same _locales catalogs itself.
** chrome.i18n is still used to learn which catalog Chrome would pick: every
** catalog contains a localeCode message equal to its own directory name.
*/

// Must match the directories under _locales. The first entry is the default
// locale declared in manifest.json and the fallback for missing messages.
export const LOCALES = ['en', 'zh_CN'];

export async function loadCatalogs(fetchJson) {
  const entries = await Promise.all(
    LOCALES.map(async locale => [locale, await fetchJson(`_locales/${locale}/messages.json`)]),
  );
  return Object.fromEntries(entries);
}

/*
** preference is 'auto' or a locale code chosen by the user; autoLocale is the
** catalog Chrome picked for the browser language. Anything unsupported
** resolves to the default locale.
*/
export function resolveLocale(preference, autoLocale) {
  const wanted = preference && preference !== 'auto' ? preference : autoLocale;
  return LOCALES.includes(wanted) ? wanted : LOCALES[0];
}

/*
** Return t(key, substitutions) for one locale. Like chrome.i18n.getMessage,
** it replaces $1..$9, falls back to the default locale for a missing key and
** returns '' for an unknown key. The catalogs use no other placeholder syntax.
*/
export function translator(catalogs, locale) {
  const primary = catalogs[locale] ?? {};
  const fallback = catalogs[LOCALES[0]] ?? {};
  return (key, subs = []) => {
    const message = primary[key]?.message ?? fallback[key]?.message ?? '';
    return message.replace(/\$(\d)/g, (_, n) => subs[n - 1] ?? '');
  };
}
