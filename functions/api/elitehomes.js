/**
 * Cloudflare Pages Function — Captura de leads Élite Homes
 * Archivo: /functions/api/elitehomes.js
 *
 * Variables de entorno (Cloudflare Pages → Settings → Environment Variables):
 *   NOTION_API_KEY · OPENAI_API_KEY · RESEND_API_KEY
 */

const NOTION_DATABASE_ID = '5d3c4f5eaf6f4f2b9c52367384116ca4';
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const ZONA_OPCIONES = ['Madrid Centro', 'Salamanca', 'Chamberí', 'Retiro', 'Chamartín', 'Otras zonas'];

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env, waitUntil }) {
  let body;
  try { body = await request.json(); }
  catch {
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid_json' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  if (!body.nombre?.trim() || !body.telefono?.trim()) {
    return new Response(
      JSON.stringify({ ok: false, error: 'missing_fields' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  const payload = {
    nombre:   body.nombre.trim(),
    telefono: body.telefono.trim(),
    zona:     (body.zona    || '').trim(),
    mensaje:  (body.mensaje || '').trim(),
    fecha:    body.timestamp || new Date().toISOString(),
    fuente:   body.fuente    || 'elitehomesdexa.com',
  };

  waitUntil(runPipeline(payload, env));

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { 'Content-Type': 'application/json', ...CORS } }
  );
}

async function runPipeline(payload, env) {
  const analysis = await analyzeLeadIA(payload, env) ?? {};
  await Promise.allSettled([
    writeToNotion(payload, analysis, env),
    sendBriefingEmail(payload, analysis, env),
  ]);
}

async function analyzeLeadIA(payload, env) {
  if (!env.OPENAI_API_KEY) return null;

  const prompt = `Eres analista de ventas de Élite Homes, agencia inmobiliaria de alto standing en Madrid.

Prospecto:
- Nombre: ${payload.nombre}
- Teléfono: ${payload.telefono}
- Zona: ${payload.zona || 'No especificada'}
- Mensaje: ${payload.mensaje || 'Sin mensaje'}

Responde SOLO con JSON válido sin markdown:
{"score":"Alta"|"Media"|"Baja","zona_normalizada":"Madrid Centro"|"Salamanca"|"Chamberí"|"Retiro"|"Chamartín"|"Otras zonas","tipo_operacion":"Compra"|"Alquiler"|"No especificado","urgencia":"Alta"|"Media"|"Baja","resumen":"2-3 frases ejecutivas sobre el lead y el próximo paso recomendado."}

Score: Alta=zona premium+intención clara de compra. Media=zona semi-premium o intención difusa. Baja=genérico o zona periférica.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  try {
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    if (!ZONA_OPCIONES.includes(parsed.zona_normalizada)) parsed.zona_normalizada = 'Otras zonas';
    return parsed;
  } catch { return null; }
}

async function writeToNotion(payload, analysis, env) {
  if (!env.NOTION_API_KEY) return;

  const props = {
    'Nombre':   { title:        [{ text: { content: payload.nombre } }] },
    'Teléfono': { phone_number: payload.telefono },
    'Mensaje':  { rich_text:    [{ text: { content: payload.mensaje || '' } }] },
    'Fuente':   { rich_text:    [{ text: { content: payload.fuente } }] },
    'Fecha':    { date:         { start: payload.fecha } },
    'Estado':   { select:       { name: 'Nuevo' } },
  };

  if (analysis?.zona_normalizada || payload.zona) {
    props['Zona'] = { select: { name: analysis?.zona_normalizada || 'Otras zonas' } };
  }
  if (analysis?.score) {
    props['Score IA'] = { select: { name: analysis.score } };
  }
  if (analysis?.resumen) {
    props['Análisis IA'] = {
      rich_text: [{ text: { content: [
        analysis.resumen,
        analysis.tipo_operacion && `Operación: ${analysis.tipo_operacion}`,
        analysis.urgencia && `Urgencia: ${analysis.urgencia}`,
      ].filter(Boolean).join(' | ') } }],
    };
  }

  await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: NOTION_DATABASE_ID }, properties: props }),
  });
}

async function sendBriefingEmail(payload, analysis, env) {
  if (!env.RESEND_API_KEY) return;

  const scoreColor = { Alta: '#2d8a4e', Media: '#b07d11', Baja: '#c0392b' }[analysis?.score] || '#666';
  const scoreBg    = { Alta: '#eafaf1', Media: '#fefce8', Baja: '#fdf2f2' }[analysis?.score]  || '#f5f5f5';
  const fecha = new Date(payload.fecha).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'DEXA Advisory <onboarding@resend.dev>',
      to:   ['dexaadvisory@gmail.com'],
      subject: `[Élite Homes] Nuevo lead${analysis?.score ? ' — Score ' + analysis.score : ''}: ${payload.nombre}`,
      html: buildEmailHtml(payload, analysis, scoreColor, scoreBg, fecha),
    }),
  });
}

function buildEmailHtml(payload, analysis, scoreColor, scoreBg, fecha) {
  const scoreBadge = analysis?.score ? `
    <tr><td style="padding:20px 32px 0;">
      <div style="background:${scoreBg};border:1px solid ${scoreColor};padding:12px 20px;border-radius:4px;">
        <span style="font-size:13px;font-weight:700;color:${scoreColor};">Score IA: ${analysis.score}</span>
        ${analysis.tipo_operacion ? `<span style="font-size:12px;color:#666;margin-left:12px;">· ${e(analysis.tipo_operacion)}</span>` : ''}
        ${analysis.urgencia ? `<span style="font-size:12px;color:#666;margin-left:8px;">· Urgencia ${e(analysis.urgencia)}</span>` : ''}
      </div>
    </td></tr>` : '';

  const analisisRow = analysis?.resumen ? `
    <tr><td style="padding:0 32px 28px;">
      <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.05em;">Análisis IA</p>
      <p style="margin:0;font-size:14px;color:#333;line-height:1.75;">${e(analysis.resumen)}</p>
    </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f0f0f0">
  <tr><td align="center" style="padding:32px 20px;">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px;">
      <tr><td style="background:#1a1a1a;padding:14px 32px;">
        <span style="font-family:monospace;font-size:11px;letter-spacing:.2em;color:#c4a882;text-transform:uppercase;">Élite Homes · Lead Alert</span>
      </td></tr>
      ${scoreBadge}
      <tr><td style="padding:24px 32px 8px;">
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="padding:6px 0;width:90px;font-size:13px;font-weight:600;color:#666;">Nombre</td>
            <td style="padding:6px 0;font-size:13px;color:#111;">${e(payload.nombre)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:13px;font-weight:600;color:#666;">Teléfono</td>
            <td style="padding:6px 0;font-size:13px;color:#111;">
              <a href="tel:${e(payload.telefono)}" style="color:#a0856a;text-decoration:none;">${e(payload.telefono)}</a>
            </td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:13px;font-weight:600;color:#666;">Zona</td>
            <td style="padding:6px 0;font-size:13px;color:#111;">
              ${e(payload.zona || '—')}
              ${analysis?.zona_normalizada ? `<span style="color:#999;font-size:12px;">(→ ${e(analysis.zona_normalizada)})</span>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:13px;font-weight:600;color:#666;">Recibido</td>
            <td style="padding:6px 0;font-size:13px;color:#111;">${e(fecha)}</td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 32px 20px;">
        <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#666;">Mensaje</p>
        <div style="background:#fafafa;border-left:3px solid #a0856a;padding:14px 18px;">
          <p style="margin:0;font-size:14px;color:#444;line-height:1.75;font-style:italic;">"${e(payload.mensaje || '—')}"</p>
        </div>
      </td></tr>
      ${analisisRow}
      <tr><td style="padding:14px 32px;background:#f8f8f8;border-top:1px solid #eee;">
        <p style="margin:0;font-family:monospace;font-size:11px;color:#aaa;">Élite Homes Demo · DEXA Advisory</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function e(s) {
  return s == null ? '' : String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
