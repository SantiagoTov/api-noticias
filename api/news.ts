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
    secret = ''
  } = req.query;

  const now = Date.now();
  const maxItems = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 30);
  const isForceRefresh = force_refresh === 'true' && secret === process.env.CRON_SECRET;

  // Servir desde caché en memoria si está vigente
  if (!isForceRefresh && cachedData && (now - cachedData.timestamp < CACHE_TTL_MS) && cachedData.topic === topic) {
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

  // Definir queries especializadas para B2B e IA
  const queryMap: Record<string, string> = {
    ia: 'inteligencia artificial OR "artificial intelligence" OR "agentes de IA" OR LLM OR OpenAI OR Claude',
    automation: 'automatizacion empresas OR "workflow automation" OR n8n OR "procesos de negocio"',
    business: '"economia mundial" OR "tecnologia empresarial" OR "transformacion digital" OR startups',
    all: '("inteligencia artificial" OR "artificial intelligence" OR "agentes IA" OR "automatizacion") AND (empresas OR negocios OR software)'
  };

  const selectedQuery = queryMap[topic as string] || queryMap.all;
  const baseUrl = process.env.APITUBE_BASE_URL || 'https://api.apitube.io/v1/news';

  try {
    // Petición a ApiTube
    const targetUrl = new URL(baseUrl);
    targetUrl.searchParams.set('q', selectedQuery);
    targetUrl.searchParams.set('per_page', '25');
    targetUrl.searchParams.set('language', 'es,en');
    targetUrl.searchParams.set('sort', 'published_at_desc');

    const apiResponse = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
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
    const articlesList: ApiTubeArticle[] = Array.isArray(rawData)
      ? rawData
      : (rawData.data || rawData.articles || rawData.results || []);

    // Normalizar y enriquecer noticias para Arpón IA
    const normalized: NormalizedNewsItem[] = articlesList.map((art, index) => {
      const pubDate = art.published_at || art.publishedAt || new Date().toISOString();
      const rawImage = art.image || art.image_url || '';
      
      // Fallback a imagen tecnológica de alta resolución si ApiTube no trae imagen
      const safeImage = rawImage.startsWith('http') 
        ? rawImage 
        : `https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&w=1200&q=80`;

      const sourceName = typeof art.source === 'object' && art.source?.name
        ? art.source.name
        : (typeof art.source === 'string' ? art.source : 'Tech News Hub');

      // Crear slug amigable para URL
      const cleanSlug = (art.title || `noticia-${index}`)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

      return {
        id: `${cleanSlug}-${Date.parse(pubDate) || Date.now()}`.slice(0, 100),
        title: (art.title || '').trim(),
        description: (art.description || art.body || '').slice(0, 320).trim(),
        imageUrl: safeImage,
        source: sourceName,
        sourceUrl: art.url || '',
        publishedAt: pubDate,
        topic: (topic as string) || 'all',
        suggestedTags: ['IA', 'Tecnología', 'Automatización', 'Empresas']
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
