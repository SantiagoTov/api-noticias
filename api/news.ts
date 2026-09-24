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
}

// In-memory cache fallback for serverless warm instances
let cachedData: {
  timestamp: number;
  items: NormalizedNewsItem[];
  topic: string;
} | null = null;

const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_SECONDS || '10800', 10)) * 1000;

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
    debug = 'false'
  } = req.query;

  const now = Date.now();
  const maxItems = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 30);
  const isForceRefresh = force_refresh === 'true' && secret === process.env.CRON_SECRET;

  // Servir desde caché en memoria si está vigente
  if (!isForceRefresh && debug !== 'true' && cachedData && (now - cachedData.timestamp < CACHE_TTL_MS) && cachedData.topic === topic) {
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

  // Queries directas y limpias sin operadores booleanos que confundan al motor de ApiTube
  const queryMap: Record<string, string> = {
    ia: 'inteligencia artificial',
    automation: 'automatizacion',
    business: 'tecnologia empresas',
    all: 'inteligencia artificial'
  };

  const selectedTitle = (q as string) || queryMap[topic as string] || 'inteligencia artificial';
  const baseUrl = process.env.APITUBE_BASE_URL || 'https://api.apitube.io/v1/news/everything';

  try {
    // Petición a ApiTube (/v1/news/everything)
    const targetUrl = new URL(baseUrl);
    targetUrl.searchParams.set('title', selectedTitle);
    targetUrl.searchParams.set('per_page', String(maxItems));
    targetUrl.searchParams.set('has_image', '1');
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
      
      // Fallback a imagen tecnológica de alta resolución si ApiTube no trae imagen
      const safeImage = (typeof rawImage === 'string' && rawImage.startsWith('http'))
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

      return {
        id: `${cleanSlug}-${Date.parse(pubDate) || Date.now()}`.slice(0, 100),
        title: (art.title || '').trim(),
        description: cleanDesc.slice(0, 350).trim(),
        imageUrl: safeImage,
        source: sourceName,
        sourceUrl: art.url || '',
        publishedAt: pubDate,
        topic: (topic as string) || 'all',
        suggestedTags: tags
      };
    });

    // Guardar en caché
    cachedData = {
      timestamp: now,
      items: normalized,
      topic: topic as string
    };

    // Cache-Control Edge de Vercel (3 horas en CDN)
    res.setHeader('X-Cache-Status', 'MISS');
    res.setHeader('Cache-Control', `public, max-age=60, s-maxage=${Math.floor(CACHE_TTL_MS / 1000)}, stale-while-revalidate=3600`);

    return res.status(200).json({
      status: 'success',
      source: 'live_fetch',
      fetchedAt: new Date(now).toISOString(),
      expiresInMinutes: Math.round(CACHE_TTL_MS / 60000),
      count: normalized.slice(0, maxItems).length,
      data: normalized.slice(0, maxItems)
    });

  } catch (error: any) {
    return res.status(500).json({
      error: 'Error interno al procesar noticias.',
      message: error?.message || 'Error desconocido'
    });
  }
}
