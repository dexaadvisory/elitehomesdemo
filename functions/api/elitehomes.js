/**
 * Cloudflare Pages Function — Captura de leads Élite Homes
 *
 * Flujo:
 *   1. Valida payload y responde 200 de forma inmediata
 *   2. Análisis IA: cualificación inmobiliaria (score + zona normalizada)
 *   3. En paralelo: escribe en Notion + envía briefing a Dave
 *
 * Variables de entorno (Cloudflare Pages → Settings → Environment Variables):
 *   NOTION_API_KEY   — misma integración Notion que DEXA
 *   RESEND_API_KEY   — misma que el pipeline principal
 *   OPENAI_API_KEY   — misma que el pipeline principal
 */

const NOTION_DATABASE_ID = '5d3c4f5eaf6f4f2b9c52367384116ca4';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ZONA_OPCIONES = ['Madrid Centro', 'Salamanca', 'Chamberí', 'Retiro', 'Chamartín', 'Otras zonas'];

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env, waitUntil }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  const jsonHeaders = { 'Content-Type': 'application/json', ...CORS_HEADERS };

  if (!body.nombre?.trim() || !body.telefono?.trim()) {
    return new Response(JSON.stringify({ ok: false, error: 'missing_required_fields' }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const payload = {
    nombre:   (body.nombre   || '').trim(),
    telefono: (body.telefono || '').trim(),
    zona:     (body.zona     || '').trim(),
    mensaje:  (body.mensaje  || '').trim(),
    fecha:    body.timestamp || new Date().toISOString(),
    fuente:   body.fuente    || 'elitehomesdexa.com',
  };

  waitUntil(runPipeline(payload, env));

  return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
}

async function runPipeline(payload, env) {
  const analysis = await analyzeLeadIA(payload, env) ?? { score: null, zona_normalizada: null, resumen: null };

  await Promise.allSettled([
    writeToNotion(payload, analysis, env),
    sendBriefingEmail(payload, analysis, env),
  ]);
}

async function analyzeLeadIA(payload, env) {
  if (!env.OPENAI_API_KEY) return null;

  const prompt = `Eres un analista de ventas de una agencia inmobiliaria de alto standing en Madrid llamada Élite Homes.

Un prospecto ha enviado el siguiente formulario de contacto:
- Nombre: ${payload.nombre}
- Teléfono: ${payload.telefono}
- Zona de interés: ${payload.zona || 'No especificada'}
- Mensaje: ${payload.mensaje || 'Sin mensaje'}

Responde ÚNICAMENTE con un objeto JSON válido, sin markdown, sin explicaciones:

{
  "score": "Alta" | "Media" | "Baja",
  "zona_normalizada": "Madrid Centro" | "Salamanca" | "Chamberí" | "Retiro" | "Chamartín" | "Otras zonas",
  "tipo_operacion": "Compra" | "Alquiler" | "No especificado",
  "urgencia": "Alta" | "Media" | "Baja",
  "resumen": "2-3 frases ejecutivas sobre el lead: qué busca, por qué tiene potencial, y el próximo paso recomendado."
}

Criterios de score:
- Alta: zona premium (Salamanca, Chamberí, Retiro, Chamartín), intención clara de compra, mensaje con datos concretos.
- Media: zona semi-premium o intención difusa, compra/alquiler sin confirmar.
- Baja: mensaje muy genérico, zona periférica, sin señales de urgencia.

Para zona_normalizada: mapea la zona libre del usuario a la opción más cercana de la lista. Si no hay coincidencia, usa "Otras zonas".`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
  });

  if (!res.ok) throw new Error(`OpenAI ${res.status}`);

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    if (!ZONA_OPCIONES.includes(parsed.zona_normalizada)) parsed.zona_normalizada = 'Otras zonas';
    return parsed;
  } catch {
    return null;
  }
}

async function writeToNotion(payload, analysis, env) {
  if (!env.NOTION_API_KEY) return;

  const properties = {
    'Nombre':   { title:        [{ text: { content: payload.nombre } }] },
    'Teléfono': { phone_number: payload.telefono },
    'Mensaje':  { rich_text:    [{ text: { content: payload.mensaje || '' } }] },
    'Fuente':   { rich_text:    [{ text: { content: payload.fuente } }] },
    'Fecha':    { date:         { start: payload.fecha } },
    'Estado':   { select:       { name: 'Nuevo' } },
  };

  if (analysis?.zona_normalizada) properties['Zona']     = { select:    { name: analysis.zona_normalizada } };
  else if (payload.zona)          properties['Zona']     = { select:    { name: 'Otras zonas' } };
  if (analysis?.score)            properties['Score IA'] = { select:    { name: analysis.score } };
  if (analysis?.resumen) {
    const texto = [
      analysis.resumen,
      analysis.tipo_operacion ? `Operación: ${analysis.tipo_operacion}` : '',
      analysis.urgencia       ? `Urgencia: ${analysis.urgencia}`       : '',
    ].filter(Boolean).join(' | ');
    properties['Análisis IA'] = { rich_text: [{ text: { content: texto } }] };
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: NOTION_DATABASE_ID }, properties }),
  });

  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
}

async function sendBriefingEmail(payload, analysis, env) {
  if (!env.RESEND_API_KEY) return;

  const scoreColor = { Alta: '#2d8a4e', Media: '#b07d11', Baja: '#c0392b' }[analysis?.score] || '#666';
  const scoreBg    = { Alta: '#eafaf1', Media: '#fefce8', Baja: '#fdf2f2' }[analysis?.score]  || '#f5f5f5';
  const fecha = new Date(payload.fecha).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid', dateStyle: 'full', timeStyle: 'short',
  });

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from:    'DEXA Advisory <onboarding@resend.dev>',
      to:      ['dexaadvisory@gmail.com'],
      subject: `[Élite Homes] Nuevo lead${analysis?.score ? ' — Score ' + analysis.score : ''}: ${payload.nombre}`,
      html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f0f0f0">
<tr><td align="center" style="padding:32px 20px;">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px;">
  <tr><td style="background:#1a1a1a;padding:14px 32px;">
    <span style="font-family:monospace;font-size:11px;letter-spacing:.2em;color:#c4a882;text-transform:uppercase;">Élite Homes · Lead Alert</span>
  </td></tr>
  ${analysis?.score ? `<tr><td style="padding:20px 32px 0;">
    <div style="background:${scoreBg};border:1px solid ${scoreColor};padding:12px 20px;border-radius:4px;">
      <span style="font-size:13px;font-weight:700;color:${scoreColor};letter-spacing:.05em;">Score IA: ${analysis.score}</span>
      ${analysis.tipo_operacion ? `<span style="font-size:12px;color:#666;margin-left:12px;">· ${analysis.tipo_operacion}</span>` : ''}
      ${analysis.urgencia ? `<span style="font-size:12px;color:#666;margin-left:8px;">· Urgencia ${analysis.urgencia}</span>` : ''}
    </div>
  </td></tr>` : ''}
  <tr><td style="padding:24px 32px 8px;">
    <table cellpadding="0" cellspacing="0" width="100%">
      <tr><td style="padding:6px 0;width:90px;font-size:13px;font-weight:600;color:#666;">Nombre</td><td style="padding:6px 0;font-size:13px;color:#111;">${e(payload.nombre)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;font-weight:600;color:#666;">Teléfono</td><td style="padding:6px 0;font-size:13px;color:#111;"><a href="tel:${e(payload.telefono)}" style="color:#a0856a;text-decoration:none;">${e(payload.telefono)}</a></td></tr>
      <tr><td style="padding:6px 0;font-size:13px;font-weight:600;color:#666;">Zona</td><td style="padding:6px 0;font-size:13px;color:#111;">${e(payload.zona || '—')}${analysis?.zona_normalizada ? ` <span style="color:#999;font-size:12px;">(→ ${e(analysis.zona_normalizada)})</span>` : ''}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;font-weight:600;color:#666;">Recibido</td><td style="padding:6px 0;font-size:13px;color:#111;">${e(fecha)}</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 32px 20px;">
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#666;">Mensaje</p>
    <div style="background:#fafafa;border-left:3px solid #a0856a;padding:14px 18px;">
      <p style="margin:0;font-size:14px;color:#444;line-height:1.75;font-style:italic;">"${e(payload.mensaje || '—')}"</p>
    </div>
  </td></tr>
  ${analysis?.resumen ? `<tr><td style="padding:0 32px 28px;">
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.05em;">Análisis IA</p>
    <p style="margin:0;font-size:14px;color:#333;line-height:1.75;">${e(analysis.resumen)}</p>
  </td></tr>` : ''}
  <tr><td style="padding:14px 32px;background:#f8f8f8;border-top:1px solid #eee;">
    <p style="margin:0;font-family:monospace;font-size:11px;color:#aaa;">Élite Homes Demo · DEXA Advisory · ${e(payload.fecha)}</p>
  </td></tr>
</table></td></tr></table></body></html>`,
    }),
  });
}

function e(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
