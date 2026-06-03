/**
 * Cloudflare Pages Function — Élite Homes · DEXA Advisory
 * Captura, cualificación IA y almacenamiento de leads · v2 (2026-06-03)
 *
 * Variables de entorno (Cloudflare Pages → Settings → Environment Variables):
 *   OPENAI_API_KEY     — GPT-4o (cualificación IA)
 *   SUPABASE_URL       — URL del proyecto Supabase
 *   SUPABASE_ANON_KEY  — Clave anon de Supabase
 *   NOTION_API_KEY     — Guardar leads cualificados en Notion
 *   RESEND_API_KEY     — Email de notificación (opcional)
 *   WHATSAPP_ENDPOINT  — URL pública Evolution API
 *   WHATSAPP_INSTANCE  — Nombre de instancia (default: elitehomes)
 *   WHATSAPP_API_KEY   — API key de Evolution API
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const NOTION_DB_ID = '374a0e0909a3817a82e6d8269573a46d'; // Élite Homes CRM — cuenta DEXA Advisory

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
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
    email:    (body.email    || '').trim(),
    zona:     (body.zona     || '').trim(),
    mensaje:  (body.mensaje  || '').trim(),
    fecha:    body.timestamp || new Date().toISOString(),
    fuente:   body.fuente    || 'elitehomesdemo.com',
  };

  // 1. Comprobar si es un lead que vuelve (reactivación)
  const leadPrevio = await buscarLeadFrio(payload.telefono, env);
  if (leadPrevio) {
    payload.es_retorno    = true;
    payload.contexto_prev = leadPrevio;
  }

  // 2. Análisis IA
  const analysis = await analyzeWithAI(payload, env);

  // 3. Acciones en paralelo: Supabase (todos) + Notion (solo cualificados) + email + WhatsApp
  await Promise.allSettled([
    saveToSupabase(payload, analysis, env),
    analysis?.cualificado ? saveToNotion(payload, analysis, env) : Promise.resolve(),
    sendEmail(payload, analysis, env),
    sendWhatsApp(payload, analysis, env),
  ]);

  return new Response(
    JSON.stringify({ ok: true, analysis: { ...analysis, zona: payload.zona } }),
    { headers: { 'Content-Type': 'application/json', ...CORS } }
  );
}

// ─── GPT-4o: cualificación + mensaje WhatsApp personalizado ──────────────────

async function analyzeWithAI(payload, env) {
  if (!env.OPENAI_API_KEY) return defaultAnalysis(payload);

  const systemPrompt = `Eres el sistema de cualificación de leads de una agencia inmobiliaria española.
Devuelve ÚNICAMENTE un objeto JSON válido, sin texto adicional, sin markdown, sin explicaciones.

CRITERIOS DE PUNTUACIÓN (1 a 10):
+3  Presupuesto concreto o hipoteca aprobada confirmada
+2  Urgencia clara: fecha límite, mudanza inminente, compra decidida
+2  Mensaje específico sobre el inmueble (zona, m², precio, características)
+1  Teléfono proporcionado
+1  Email proporcionado
-3  Señales de baja intención: "solo mirando", "sin presupuesto", "curiosidad"
-1  Mensaje completamente genérico

REGLA: CUALIFICADO si score >= 6.

FORMATO — exactamente este JSON, nada más:
{"cualificado":true,"score":8,"razon":"Breve explicación interna para el agente","tipo_operacion":"compra","urgencia":"1-3_meses","presupuesto_viable":true,"siguiente_paso":"Acción concreta para el agente","whatsapp_mensaje":"Texto listo para enviar al lead"}

Valores tipo_operacion: "compra" | "alquiler" | "inversion" | "desconocido"
Valores urgencia: "inmediata" | "1-3_meses" | "6+_meses" | "explorando"

REGLAS para whatsapp_mensaje:
- Saluda por el PRIMER NOMBRE del lead
- En 1 frase, muestra que has leído su consulta con referencia DIRECTA a lo que escribió (zona, tipo, intención)
- Haz EXACTAMENTE 2 preguntas, las mínimas para cualificar. NO preguntes lo que ya sabes:
  · Si mencionó "comprar" → no preguntes compra/alquiler
  · Si mencionó una zona concreta → no preguntes por zona
  · Si mencionó un presupuesto → no preguntes presupuesto
  · Prioridad: (1) presupuesto máximo, (2) plazo/urgencia, (3) hipoteca/financiación, (4) m²/habitaciones
- Tono: cálido y directo, como un agente real desde el móvil. No suenes a bot
- Sin asteriscos ni markdown. Texto plano, emojis solo si es natural
- Máximo 100 palabras
- Firma: "Equipo Élite Homes"`;

  const retornoCtx = payload.es_retorno
    ? `\n\nCONTEXTO ESPECIAL — LEAD QUE VUELVE: Este contacto ya nos consultó antes y fue marcado como frío. Su consulta anterior: "${payload.contexto_prev?.mensaje_original || ''}". Genera el whatsapp_mensaje como una bienvenida de vuelta cálida: menciona que ya habíais hablado, muestra que recuerdas lo que buscaba, y ofrece novedades concretas. NO hagas preguntas genéricas — ya le conoces.`
    : '';

  const userMsg = `LEAD:
Nombre: ${payload.nombre}
Mensaje: ${payload.mensaje || 'Sin mensaje'}
Zona: ${payload.zona || 'No especificada'}
Teléfono: ${payload.telefono ? 'Sí' : 'No'}
Email: ${payload.email ? 'Sí' : 'No'}${retornoCtx}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMsg },
        ],
      }),
    });

    if (!res.ok) return defaultAnalysis(payload);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '{}';
    return JSON.parse(text);
  } catch {
    return defaultAnalysis(payload);
  }
}

function defaultAnalysis(payload) {
  const nombre = payload?.nombre?.split(' ')[0] || '';
  const zona   = payload?.zona || 'la zona indicada';
  return {
    cualificado: false,
    score: 3,
    razon: 'No se pudo analizar el lead automáticamente.',
    tipo_operacion: 'desconocido',
    urgencia: 'explorando',
    presupuesto_viable: false,
    siguiente_paso: 'Revisar manualmente y contactar en 24h.',
    whatsapp_mensaje: `Hola ${nombre} 👋\n\nGracias por contactar con Élite Homes. Hemos recibido tu consulta sobre ${zona}.\n\nPara poder ayudarte mejor:\n\n1️⃣ ¿Cuál sería tu presupuesto aproximado?\n2️⃣ ¿Para cuándo lo necesitarías?\n\nUn saludo,\nEquipo Élite Homes`,
  };
}

// ─── Notion: guardar leads CUALIFICADOS ──────────────────────────────────────

async function saveToNotion(payload, analysis, env) {
  if (!env.NOTION_API_KEY) return;

  // Mapear score numérico a etiqueta Notion
  const score = analysis?.score ?? 0;
  const scoreIA = score >= 7 ? 'Alta' : score >= 4 ? 'Media' : 'Baja';

  // Mapear zona del formulario a opciones del select en Notion
  const zonaMap = {
    'Madrid Centro': 'Madrid Centro',
    'Salamanca': 'Salamanca',
    'Chamberí': 'Chamberí',
    'Retiro': 'Retiro',
    'Chamartín': 'Chamartín',
  };
  const zonaNotion = zonaMap[payload.zona] || 'Otras zonas';

  const analisisTexto = [
    `Score: ${score}/10`,
    analysis?.razon || '',
    analysis?.siguiente_paso ? `→ ${analysis.siguiente_paso}` : '',
  ].filter(Boolean).join('\n');

  try {
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DB_ID },
        properties: {
          'Nombre':      { title:        [{ text: { content: payload.nombre } }] },
          'Teléfono':    { phone_number: payload.telefono },
          'Mensaje':     { rich_text:    [{ text: { content: payload.mensaje || '' } }] },
          'Zona':        { select:       { name: zonaNotion } },
          'Estado':      { select:       { name: 'Nuevo' } },
          'Score IA':    { select:       { name: scoreIA } },
          'Análisis IA': { rich_text:    [{ text: { content: analisisTexto } }] },
          'Fuente':      { rich_text:    [{ text: { content: payload.fuente } }] },
          'Fecha':       { date:         { start: payload.fecha.split('T')[0] } },
        },
      }),
    });
  } catch { /* silencioso */ }
}

// ─── WhatsApp: mensaje IA personalizado ──────────────────────────────────────

async function sendWhatsApp(payload, analysis, env) {
  if (!env.WHATSAPP_ENDPOINT) return;

  const mensaje = analysis?.whatsapp_mensaje
    || `Hola ${payload.nombre.split(' ')[0]} 👋\n\nGracias por contactar con Élite Homes. En breve nos ponemos en contacto contigo.\n\nUn saludo,\nEquipo Élite Homes`;

  // Normalizar teléfono: solo dígitos con código de país sin +
  let telefono = payload.telefono.replace(/[\s\-\.\+]/g, '');
  if (!telefono.startsWith('34') && telefono.length === 9) telefono = '34' + telefono;

  try {
    await fetch(`${env.WHATSAPP_ENDPOINT}/message/sendText/${env.WHATSAPP_INSTANCE || 'elitehomes'}`, {
      method: 'POST',
      headers: {
        'apikey': env.WHATSAPP_API_KEY || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ number: telefono, text: mensaje }),
    });
  } catch { /* silencioso */ }
}

// ─── Supabase: guardar todos los leads ───────────────────────────────────────

async function saveToSupabase(payload, analysis, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return;

  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        nombre:             payload.nombre,
        telefono:           payload.telefono,
        email:              payload.email || null,
        mensaje_original:   payload.mensaje,
        portal_origen:      payload.fuente,
        inmueble_zona:      payload.zona,
        estado:             analysis?.cualificado ? 'cualificado' : 'nurturing',
        score_ia:           analysis?.score,
        razon_ia:           analysis?.razon,
        tipo_operacion:     analysis?.tipo_operacion || 'desconocido',
        urgencia:           analysis?.urgencia || 'explorando',
        presupuesto_viable: analysis?.presupuesto_viable,
        siguiente_paso_ia:  analysis?.siguiente_paso,
        agencia_nombre:     'Élite Homes',
        agencia_agente:     'Sistema DEXA',
        modo:               'demo',
        nurturing_day:      0,
      }),
    });
  } catch { /* silencioso */ }
}

// ─── Resend: email de notificación interna ────────────────────────────────────

async function sendEmail(payload, analysis, env) {
  if (!env.RESEND_API_KEY) return;

  const scoreColor = analysis?.cualificado ? '#4ade80' : '#fbbf24';
  const scoreLabel = analysis?.cualificado ? '✓ CUALIFICADO' : '○ EN NURTURING';

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from:    'Élite Homes · DEXA <onboarding@resend.dev>',
        to:      ['dexaadvisory@gmail.com'],
        subject: `[DEMO] Lead ${scoreLabel} — ${payload.nombre} · Score ${analysis?.score ?? 0}/10`,
        html:    buildEmailHtml(payload, analysis, scoreColor, scoreLabel),
      }),
    });
  } catch { /* silencioso */ }
}

function buildEmailHtml(payload, analysis, scoreColor, scoreLabel) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f0f0f">
  <tr><td align="center" style="padding:32px 20px;">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1a1a;max-width:560px;">
      <tr><td style="background:#0f0f0f;padding:16px 28px;border-bottom:1px solid #2e2e2e;">
        <span style="font-family:monospace;font-size:10px;letter-spacing:.2em;color:#c4a882;text-transform:uppercase;">Élite Homes · DEXA Advisory · Lead Alert</span>
      </td></tr>
      <tr><td style="padding:24px 28px 0;">
        <div style="display:inline-block;padding:8px 14px;border:1px solid ${scoreColor};margin-bottom:20px;">
          <span style="font-family:monospace;font-size:11px;letter-spacing:.15em;color:${scoreColor};">${scoreLabel} · ${analysis?.score ?? 0}/10</span>
        </div>
        <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #2e2e2e;padding-top:16px;">
          <tr>
            <td style="padding:6px 0;width:80px;font-size:11px;color:#6b6b6b;font-family:monospace;letter-spacing:.1em;text-transform:uppercase;">Nombre</td>
            <td style="padding:6px 0;font-size:13px;color:#f5f0e8;">${esc(payload.nombre)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:11px;color:#6b6b6b;font-family:monospace;letter-spacing:.1em;text-transform:uppercase;">Teléfono</td>
            <td style="padding:6px 0;font-size:13px;color:#c4a882;">${esc(payload.telefono)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:11px;color:#6b6b6b;font-family:monospace;letter-spacing:.1em;text-transform:uppercase;">Zona</td>
            <td style="padding:6px 0;font-size:13px;color:#f5f0e8;">${esc(payload.zona || '—')}</td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 28px;">
        <div style="background:#0f0f0f;border-left:2px solid #c4a882;padding:12px 16px;margin-bottom:20px;">
          <p style="margin:0;font-size:13px;color:#9e9e8f;line-height:1.65;font-style:italic;">"${esc(payload.mensaje || '—')}"</p>
        </div>
        <p style="margin:0 0 6px;font-size:10px;color:#6b6b6b;font-family:monospace;letter-spacing:.15em;text-transform:uppercase;">Análisis IA</p>
        <p style="margin:0 0 20px;font-size:13px;color:#f5f0e8;line-height:1.6;">${esc(analysis?.razon || '—')}</p>
        <p style="margin:0 0 6px;font-size:10px;color:#c4a882;font-family:monospace;letter-spacing:.15em;text-transform:uppercase;">⚡ Siguiente paso</p>
        <p style="margin:0;font-size:13px;color:#f5f0e8;line-height:1.6;">${esc(analysis?.siguiente_paso || '—')}</p>
      </td></tr>
      <tr><td style="padding:14px 28px;border-top:1px solid #2e2e2e;">
        <p style="margin:0;font-family:monospace;font-size:10px;color:#4a4a4a;letter-spacing:.1em;">DEXA Advisory · Sistema Automático de Cualificación · Modo Demo</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function esc(s) {
  return s == null ? '' : String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ─── Supabase: buscar lead frío por teléfono (reactivación) ──────────────────

async function buscarLeadFrio(telefono, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  try {
    let t = telefono.replace(/[\s\-\.\+]/g, '');
    if (!t.startsWith('34') && t.length === 9) t = '34' + t;
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/leads?telefono=eq.${encodeURIComponent(t)}&estado=eq.frio&order=created_at.desc&limit=1&select=nombre,mensaje_original,inmueble_zona,tipo_operacion`,
      {
        headers: {
          'apikey':        env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
        }
      }
    );
    const data = await res.json();
    return data?.[0] || null;
  } catch { return null; }
}
