/**
 * Inferência de país/moeda/locale a partir de headers HTTP.
 * Cloudflare envia CF-IPCountry; Vercel envia x-vercel-ip-country.
 */

type CountryInfo = { currency: string; locale: string };

// Ordem: EUR primeiro (zona do euro), BRL, senão USD
const COUNTRY_MAP: Record<string, CountryInfo> = {
  BR: { currency: 'BRL', locale: 'pt-BR' },
  PT: { currency: 'EUR', locale: 'pt-PT' },
  US: { currency: 'USD', locale: 'en-US' },
  GB: { currency: 'USD', locale: 'en-GB' },
  CA: { currency: 'USD', locale: 'en-CA' },
  AU: { currency: 'USD', locale: 'en-AU' },
  DE: { currency: 'EUR', locale: 'de-DE' },
  FR: { currency: 'EUR', locale: 'fr-FR' },
  ES: { currency: 'EUR', locale: 'es-ES' },
  IT: { currency: 'EUR', locale: 'it-IT' },
  NL: { currency: 'EUR', locale: 'nl-NL' },
  IE: { currency: 'EUR', locale: 'en-IE' },
  AT: { currency: 'EUR', locale: 'de-AT' },
  BE: { currency: 'EUR', locale: 'nl-BE' },
  FI: { currency: 'EUR', locale: 'fi-FI' },
};

const EUR_COUNTRIES = new Set([
  'GR', 'LU', 'EE', 'LV', 'LT', 'SK', 'SI', 'CY', 'MT', 'HR',
]);

export interface LocaleContext {
  country: string | null;
  currency: string;
  locale: string;
}

function parseAcceptLanguage(header: string | undefined): { currency: string; locale: string } | null {
  if (!header || typeof header !== 'string') return null;
  const preferred = header.split(',')[0]?.trim().toLowerCase();
  if (!preferred) return null;
  if (preferred.startsWith('pt')) return { currency: 'BRL', locale: 'pt-BR' };
  if (preferred.startsWith('en')) return { currency: 'USD', locale: 'en-US' };
  if (preferred.startsWith('es')) return { currency: 'USD', locale: 'es-ES' };
  if (preferred.startsWith('de') || preferred.startsWith('fr') || preferred.startsWith('it') || preferred.startsWith('nl')) {
    return { currency: 'EUR', locale: preferred };
  }
  return null;
}

export function detectLocaleFromHeaders(headers: Record<string, any>): LocaleContext {
  const raw =
    headers['cf-ipcountry'] ??
    headers['x-vercel-ip-country'] ??
    headers['x-country-code'] ??
    null;
  const country = typeof raw === 'string' ? raw.toUpperCase() : null;

  if (country && country !== 'XX' && country !== 'T1') {
    const info = COUNTRY_MAP[country];
    if (info) return { country, ...info };
    if (EUR_COUNTRIES.has(country)) return { country, currency: 'EUR', locale: 'en-GB' };
    return { country, currency: 'USD', locale: 'en-US' };
  }

  // Fallback: parse Accept-Language header
  const fromLang = parseAcceptLanguage(headers['accept-language']);
  if (fromLang) return { country: null, ...fromLang };

  return { country: null, currency: 'USD', locale: 'en-US' };
}
