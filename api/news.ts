import type { VercelRequest, VercelResponse } from '@vercel/node';

interface ApiTubeArticle {
  id?: string;
  title: string;
  description?: string;
  body?: string;
  url: string;
  image?: string;
  image_url?: string;
  published_at?: string;
  publishedAt?: string;
  source?: {
    name?: string;
    url?: string;
  } | string;
  category?: string;
  language?: string;
}

interface NormalizedNewsItem {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  source: string;
  sourceUrl: string;
  publishedAt: string;
  topic: string;
  suggestedTags: string[];
  score: number;
}

// In-memory cache fallback for serverless warm instances
let cachedData: {
  timestamp: number;
  items: NormalizedNewsItem[];
  key: string;
} | null = null;

const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_SECONDS || '10800', 10)) * 1000;

// ---------------------------------------------------------------------------
// Filtro editorial Arpón IA v2 (2026-09-27)
// Alineado al buyer persona: dueño de pyme, gerente comercial/marketing,
// emprendedor tech (ver arpon-website/monetizacion/persona/).
// Reglas: 1 query por request (no multiplicar llamadas a ApiTube) →
// normalizar → excluir basura/duplicados → scoring → ordenar → top N.
// El contrato de la API (params, forma de respuesta) NO cambia.
//
// Perfiles de consulta (misma key de ApiTube, 2026-09-27):
//  - "blog" (arpon.lat): topic=xxx|all (queries ES afinadas en queryMap),
//    sin lang/country. 2 ciclos/día, ~2-4 req/día. NO TOCAR su afinación.
//  - "tiktok" (canal US, noticias tech EN): q=<query EN> + lang=en +
//    country=us. El perfil vive en ~/workspace/tiktok/ingesta/ (keywords,
//    rotación experimental, caché local). ~4-6 req/día.
// Combinado: <11 req/día contra 500/mes del plan Free
// (blog 2-4/día + tiktok ~7/día; ver ESTRATEGIA-CUOTA.md en tiktok/ingesta/).
// ---------------------------------------------------------------------------

/** Topics disponibles. `all` es el default que usa el cron: no cambiar su query. */
export const queryMap: Record<string, string> = {
  ia: 'inteligencia artificial',
  // Queries verificadas en vivo 2026-09-27: las multi-palabra estrechas devolvían 0
  // en ApiTube; estas devuelven resultados (probado con debug=true, raw>0).
  agentes: 'agentes IA',
  automatizacion: 'automatización',
  negocios: 'IA empresas',
  costos: 'costo IA',
  modelos: 'modelos IA',
  regulacion: 'ley IA',
  marketing: 'marketing IA',
  automation: 'automatizacion', // compat: clave histórica
  business: 'tecnologia empresas', // compat: clave histórica
  all: 'inteligencia artificial',
};

export function norm(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Relevancia comercial para los servicios de Arpón IA (agentes IA,
// automatización, SEO, sitios web; mercado Bogotá/Colombia).
const COMMERCIAL_KEYWORDS = [
  'empresa', 'empresas', 'negocio', 'negocios', 'pyme', 'pymes',
  'costo', 'costos', 'precio', 'precios', 'implementar', 'implementacion',
  'automatizacion', 'automatizar', 'agente', 'agentes', 'ventas',
  'marketing', 'seo', 'productividad', 'roi', 'inversion',
  'colombia', 'latinoamerica', 'bogota', 'medellin',
  'startup', 'startups', 'saas', 'crm', 'whatsapp', 'chatbot',
  'diagnostico', 'consultoria',
];

// Noticias globales de IA que le importan al buyer persona tech
// (y nutren el ciclo editorial de 2 artículos/día).
const GLOBAL_AI_KEYWORDS = [
  'modelo', 'modelos', 'lanzamiento', 'gpt', 'claude', 'gemini',
  'openai', 'anthropic', 'deepseek', 'regulacion', 'big tech',
  'agentes autonomos', 'llm',
];

// Patrones de ruido: se excluyen (no solo se penalizan).
// (2026-09-28: agregados patrones de ofertas afiliadas — contaminaban las
// queries de big tech del perfil tiktok, p. ej. "Apple" ~60% deals.)
const JUNK_PATTERNS = [
  'horoscopo', 'farándula', 'farandula', 'deportes', 'meme',
  'sorteo', 'obituario', 'fallece', 'boda', 'divorcio', 'reality',
  'deals', 'clearance', 'price drop', 'prime day',
];

// Boost leve (no filtro) para prensa con historial de calidad.
const QUALITY_SOURCES = [
  'techcrunch', 'the verge', 'wired', 'technology review', 'reuters',
  'bloomberg', 'forbes', 'xataka', 'genbeta', 'el tiempo', 'semana',
];

export function isJunk(title: string, description: string): boolean {
  const t = norm(title);
  const d = norm(description);
  if (!t) return true;
  return JUNK_PATTERNS.some((p) => t.includes(norm(p)) || d.includes(norm(p)));
}

export function scoreArticle(
  title: string,
  description: string,
  source: string,
  publishedAt: string
): number {
  const t = norm(title);
  const d = norm(description);
  const s = norm(source);
  let score = 0;

  for (const k of COMMERCIAL_KEYWORDS) {
    if (t.includes(k)) score += 3;
    else if (d.includes(k)) score += 1;
  }
  for (const k of GLOBAL_AI_KEYWORDS) {
    if (t.includes(k)) score += 2;
    else if (d.includes(k)) score += 1;
  }
  for (const q of QUALITY_SOURCES) {
    if (s.includes(q)) {
      score += 1;
      break;
    }
  }

  // Recencia: lo mejor de lo mejor = lo último.
  const ageHours = (Date.now() - Date.parse(publishedAt)) / 3.6e6;
  if (ageHours >= 0 && ageHours <= 48) score += 2;
  else if (ageHours > 48 && ageHours <= 168) score += 1;

  // Material delgado = mala materia prima para el redactor.
  if (d.length < 60) score -= 2;

  return score;
}

/**
 * Elimina duplicados/sindicados: misma noticia publicada por N medios.
 * Conserva la más reciente de cada grupo (Jaccard > 0.65 en tokens del título,
 * ignorando palabras vacías). El umbral captura copias de notas de prensa
 * sindicadas sin fusionar coberturas distintas del mismo tema.
 */
const STOPWORDS = new Set([
  'de', 'la', 'el', 'en', 'y', 'que', 'los', 'del', 'se', 'las', 'por',
  'un', 'una', 'con', 'para', 'como', 'mas', 'sus', 'este', 'esta',
  'son', 'entre', 'cuando', 'donde', 'sobre', 'tras', 'ante', 'bajo',
  'contra', 'desde', 'hasta', 'hacia', 'durante', 'mediante', 'segun',
  'ser', 'hay', 'fue', 'han', 'tiene', 'tienen', 'sin',
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    norm(title).split(' ').filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Elimina duplicados/sindicados: misma noticia publicada por N medios.
 * Conserva la más reciente de cada grupo (Jaccard > 0.75 en tokens del título).
 */
export function dedupeByTitle<T extends { title: string; publishedAt: string }>(items: T[]): T[] {
  const sorted = [...items].sort(
    (a, b) => Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || '')
  );
  const kept: T[] = [];
  const keptTokens: Array<Set<string>> = [];
  for (const item of sorted) {
    const tokens = titleTokens(item.title);
    const isDup = keptTokens.some((kt) => jaccard(tokens, kt) > 0.65);
    if (!isDup) {
      kept.push(item);
      keptTokens.push(tokens);
    }
  }
  return kept;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido. Usa GET.' });
  }

  const apiKey = process.env.APITUBE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'APITUBE_API_KEY no configurada.',
      message: 'Por favor añade APITUBE_API_KEY en tu archivo .env o en el panel de Vercel.'
    });
  }

  const {
    topic = 'all',
    limit = '10',
    force_refresh = 'false',
    secret = '',
    q = '',
    lang = '',
    country = '',
    debug = 'false'
  } = req.query;

  const now = Date.now();
  const maxItems = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 30);
  const isForceRefresh = force_refresh === 'true' && secret === process.env.CRON_SECRET;

  // Queries directas y limpias sin operadores booleanos que confundan al motor de ApiTube
  const selectedTitle = (q as string) || queryMap[topic as string] || 'inteligencia artificial';
  // lang/country son opcionales y solo los usa el perfil "tiktok" (2026-09-27):
  // se reenvían a ApiTube como language.code / source.country.code.
  // Sin ellos, el comportamiento es idéntico al histórico (perfil "blog").
  const cacheKey = `${topic}_${maxItems}_${selectedTitle}_${lang}_${country}`;

  // Servir desde caché en memoria si está vigente
  if (!isForceRefresh && debug !== 'true' && cachedData && (now - cachedData.timestamp < CACHE_TTL_MS) && cachedData.key === cacheKey) {
    res.setHeader('X-Cache-Status', 'HIT');
    res.setHeader('Cache-Control', `public, max-age=60, s-maxage=${Math.floor(CACHE_TTL_MS / 1000)}, stale-while-revalidate=3600`);
    return res.status(200).json({
      status: 'success',
      source: 'cache',
      cachedAt: new Date(cachedData.timestamp).toISOString(),
      expiresInMinutes: Math.round((CACHE_TTL_MS - (now - cachedData.timestamp)) / 60000),
      count: cachedData.items.slice(0, maxItems).length,
      data: cachedData.items.slice(0, maxItems)
    });
  }
  const baseUrl = process.env.APITUBE_BASE_URL || 'https://api.apitube.io/v1/news/everything';

  try {
    // Petición a ApiTube (/v1/news/everything)
    const targetUrl = new URL(baseUrl);
    targetUrl.searchParams.set('title', selectedTitle);
    targetUrl.searchParams.set('per_page', String(maxItems));
    targetUrl.searchParams.set('has_image', '1');
    // Filtros del perfil "tiktok" (opcionales; el perfil "blog" no los envía)
    if (lang) targetUrl.searchParams.set('language.code', String(lang));
    if (country) targetUrl.searchParams.set('source.country.code', String(country));
    targetUrl.searchParams.set('api_key', apiKey);

    const apiResponse = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      return res.status(apiResponse.status).json({
        error: `Error de ApiTube API (${apiResponse.status})`,
        details: errText
      });
    }

    const rawData = await apiResponse.json();

    if (debug === 'true') {
      return res.status(200).json({
        debug: true,
        targetUrl: targetUrl.toString().replace(apiKey, 'REDACTED'),
        rawData
      });
    }

    const articlesList: any[] = Array.isArray(rawData)
      ? rawData
      : (rawData.results || rawData.data || rawData.articles || []);

    // Normalizar y enriquecer noticias para Arpón IA
    const normalized: NormalizedNewsItem[] = articlesList.map((art: any, index: number) => {
      const pubDate = art.published_at || art.publish_date || art.publishedAt || new Date().toISOString();

      // ApiTube entrega las imágenes en el arreglo 'media'
      const mediaImage = Array.isArray(art.media)
        ? art.media.find((m: any) => m.type === 'image' || typeof m.url === 'string')?.url
        : null;

      const rawImage = mediaImage ||
        (typeof art.image === 'object' && art.image?.url ? art.image.url : (art.image || art.image_url || art.imageUrl || ''));

      // Validar que la imagen sea un archivo gráfico real (no un pdf ni un icono diminuto)
      const isValidGraphic = typeof rawImage === 'string'
        && rawImage.startsWith('http')
        && !rawImage.toLowerCase().endsWith('.pdf')
        && !rawImage.toLowerCase().includes('flaticon')
        && !rawImage.toLowerCase().includes('icon');

      const safeImage = isValidGraphic
        ? rawImage
        : `https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&w=1200&q=80`;

      const sourceName = typeof art.source === 'object'
        ? (art.source.name || art.source.title || art.source.domain || 'Tech News')
        : (typeof art.source === 'string' ? art.source : 'Tech News Hub');

      // Descripción limpia
      const cleanDesc = art.description
        || (Array.isArray(art.sentences) && art.sentences.length > 0 ? art.sentences[0].sentence : '')
        || art.summary
        || '';

      // Crear slug amigable para URL
      const cleanSlug = (art.title || `noticia-${index}`)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

      const tags = Array.isArray(art.keywords) && art.keywords.length > 0
        ? art.keywords.slice(0, 5)
        : ['IA', 'Tecnología', 'Automatización', 'Empresas'];

      const title = (art.title || '').trim();
      const description = cleanDesc.slice(0, 350).trim();

      return {
        id: `${cleanSlug}-${Date.parse(pubDate) || Date.now()}`.slice(0, 100),
        title,
        description,
        imageUrl: safeImage,
        source: sourceName,
        sourceUrl: art.url || '',
        publishedAt: pubDate,
        topic: (topic as string) || 'all',
        suggestedTags: tags,
        score: scoreArticle(title, description, sourceName, pubDate),
      };
    });

    // Filtro editorial v2: excluir basura y duplicados/sindicados, ordenar por score.
    const filtered = dedupeByTitle(
      normalized.filter((n) => !isJunk(n.title, n.description))
    ).sort((a, b) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

    // Guardar en caché
    cachedData = {
      timestamp: now,
      items: filtered,
      key: cacheKey
    };

    // Cache-Control Edge de Vercel (3 horas en CDN)
    res.setHeader('X-Cache-Status', 'MISS');
    res.setHeader('Cache-Control', `public, max-age=60, s-maxage=${Math.floor(CACHE_TTL_MS / 1000)}, stale-while-revalidate=3600`);

    return res.status(200).json({
      status: 'success',
      source: 'live_fetch',
      fetchedAt: new Date(now).toISOString(),
      expiresInMinutes: Math.round(CACHE_TTL_MS / 60000),
      count: filtered.slice(0, maxItems).length,
      data: filtered.slice(0, maxItems)
    });

  } catch (error: any) {
    return res.status(500).json({
      error: 'Error interno al procesar noticias.',
      message: error?.message || 'Error desconocido'
    });
  }
}
