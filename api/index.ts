import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  return res.status(200).json({
    name: 'Arpón IA — News Feed Microservice',
    status: 'online',
    version: '1.0.0',
    description: 'Microservicio serverless en Vercel para extracción y caché inteligente de noticias tecnológicas vía ApiTube.',
    endpoints: {
      allNews: '/api/news',
      aiNews: '/api/news?topic=ia&limit=10',
      automationNews: '/api/news?topic=automation&limit=10',
      businessNews: '/api/news?topic=business&limit=10'
    },
    documentation: {
      cacheDuration: '3 horas (10,800 segundos)',
      targetConsumer: 'Arpón Blog Generator Cron Task',
      author: 'Santiago Tovar'
    }
  });
}
