# 🚀 Arpón News Feed Microservice (`api-noticias`)

Microservicio Serverless desplegado en **Vercel** para ingesta, filtrado, normalización y caché inteligente de noticias tecnológicas y de negocios vía **ApiTube** para **Arpón IA**.

---

## ⚡ Endpoints Disponibles

| Método | Endpoint | Descripción |
| :--- | :--- | :--- |
| `GET` | `/api` | Health check y estado del microservicio |
| `GET` | `/api/news` | Noticias generales de IA, software y negocios (Caché 3h) |
| `GET` | `/api/news?topic=ia&limit=10` | 10 noticias especializadas en Inteligencia Artificial y LLMs |
| `GET` | `/api/news?topic=automation&limit=10` | Noticias de automatización empresarial, n8n y flujos |
| `GET` | `/api/news?topic=business&limit=10` | Noticias de economía mundial, transformación digital y startups |
| `GET` | `/api/news?force_refresh=true&secret=...` | Forzar recarga inmediata ignorando el caché |

---

## ⚙️ Configuración de Variables de Entorno

1. Copia `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```
2. Añade tu API Key de ApiTube:
   ```ini
   APITUBE_API_KEY=tu_api_key_de_apitube
   CACHE_TTL_SECONDS=10800
   CRON_SECRET=arpon_news_secret_2026
   ```

---

## 🛠️ Ejecución Local

Para probar localmente usando el CLI de Vercel:

```bash
npm install
vercel dev
```

El servidor estará disponible en `http://localhost:3000/api/news`.

---

## 🚀 Despliegue en Vercel

```bash
# Vincular y desplegar a producción
vercel --prod
```

En el dashboard de Vercel (o mediante `vercel env add APITUBE_API_KEY`), asegúrate de registrar la variable `APITUBE_API_KEY`.
