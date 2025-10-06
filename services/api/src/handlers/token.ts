import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, todayStr } from '../utils/db';
import { html, json } from '../utils/http';

export async function handleTokenPost(businessId: string, bodyRaw: string | null, now = new Date()): Promise<APIGatewayProxyStructuredResultV2> {
  const dayKey = todayStr();
  const pkDay = `BIZ#${businessId}`;
  const skDay = `DAY#${dayKey}`;
  const tableName = process.env.TABLE_NAME as string;
  if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });

  // Load business PROFILE (require existence)
  const profileRes = await ddb.send(new GetCommand({ TableName: tableName, Key: { PK: pkDay, SK: 'PROFILE' } }));
  const profile = profileRes.Item as any | undefined;
  if (!profile) return json(404, { message: 'business profile not found' });

  const body = bodyRaw ? JSON.parse(bodyRaw) : {};
  const serviceId = (body.serviceId || '').toString().trim();
  const tokenMode = (profile.tokenMode as string) || 'standard';

  let ticketNo = 0;
  let serviceToUse: string | undefined = undefined;

  if (tokenMode === 'perService') {
    if (!serviceId) return json(400, { message: 'serviceId is required for perService mode' });
    const services = Array.isArray(profile.services) ? profile.services : [];
    const svc = services.find((s: any) => s.id === serviceId && (s.enabled ?? true));
    if (!svc) return json(400, { message: `unknown or disabled serviceId: ${serviceId}` });

    const up = await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: pkDay, SK: skDay },
      UpdateExpression: 'SET counters.#svc = if_not_exists(counters.#svc, :zero) + :one, updatedAt = :now',
      ExpressionAttributeNames: { '#svc': serviceId },
      ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':now': now.toISOString() },
      ReturnValues: 'UPDATED_NEW'
    }));
    ticketNo = (up.Attributes?.counters?.[serviceId] as number) || 1;
    serviceToUse = serviceId;
  } else {
    const up = await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: pkDay, SK: skDay },
      UpdateExpression: 'SET nextNumber = if_not_exists(nextNumber, :zero) + :one, updatedAt = :now',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':now': now.toISOString() },
      ReturnValues: 'UPDATED_NEW'
    }));
    ticketNo = (up.Attributes?.nextNumber as number) || 1;
  }

  const pkTickets = `BIZ#${businessId}#DAY#${dayKey}`;
  const ticketId = `t_${businessId}_${dayKey}_${ticketNo}${serviceToUse ? '_' + serviceToUse : ''}`;
  const skTicket = `TKT#${String(ticketNo).padStart(4, '0')}`;
  const item: any = {
    PK: pkTickets,
    SK: skTicket,
    ticketId,
    ticketNo,
    businessId,
    day: dayKey,
    status: 'pending',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  if (serviceToUse) item.serviceId = serviceToUse;

  await ddb.send(new PutCommand({ TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)' }));

  let etaMinutes: number | undefined;
  try {
    const workers = Number(profile.workersPerDay || 1) || 1;
    let avg = 0;
    if (serviceToUse && profile.avgMinutes && profile.avgMinutes[serviceToUse]) avg = Number(profile.avgMinutes[serviceToUse]);
    else if (profile.avgMinutes && profile.avgMinutes.default) avg = Number(profile.avgMinutes.default);
    if (avg > 0 && workers > 0) etaMinutes = Math.ceil(avg / workers);
  } catch {}

  return json(201, { ticketNo, ticketId, status: 'pending', serviceId: serviceToUse, etaMinutes });
}

export function handleTokenPageGet(): APIGatewayProxyStructuredResultV2 {
  const htmlBody = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Get Token</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0b1020; color: #fff; }
      .card { text-align: center; padding: 2rem 3rem; background: #121836; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
      h1 { margin: 0 0 1rem; font-size: 1.5rem; font-weight: 600; color: #9fb4ff; }
      .token { font-size: 20vw; line-height: 1; font-weight: 800; letter-spacing: 0.05em; color: #e6ecff; text-shadow: 0 4px 20px rgba(80,120,255,0.35); }
      .err { color: #ff8892; font-size: 1rem; margin-top: 1rem; }
      .small { opacity: 0.7; margin-top: 1rem; font-size: 0.9rem; }
      @media (min-width: 640px) { .token { font-size: 10rem; } }
      button { margin-top: 1.5rem; padding: .75rem 1rem; font-weight: 600; border-radius: 10px; border: 1px solid #32408f; background: #1a2352; color: #e6ecff; cursor: pointer; }
      button:hover { filter: brightness(1.1); }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Your token number</h1>
      <div id="token" class="token">…</div>
      <div id="error" class="err" hidden></div>
      <div class="small">This page asks the server for a new token on load. Use the button for another.</div>
      <button id="again">Get another token</button>
    </div>
    <script>
      async function getToken() {
        const $t = document.getElementById('token');
        const $e = document.getElementById('error');
        $e.hidden = true; $e.textContent = '';
        $t.textContent = '…';
        try {
          const res = await fetch(window.location.pathname, { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data && data.message || 'Request failed');
          const n = (data && (data.ticketNo || data.number || data.token)) || '—';
          $t.textContent = n;
        } catch (err) {
          $t.textContent = '—';
          $e.hidden = false; $e.textContent = 'Error: ' + (err && err.message || err);
        }
      }
      document.getElementById('again').addEventListener('click', getToken);
      getToken();
    </script>
  </body>
</html>`;
  return html(200, htmlBody);
}

export function handleTokenServicePageGet(businessId: string, serviceId: string): APIGatewayProxyStructuredResultV2 {
  const htmlBody = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Get Token - ${serviceId}</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0b1020; color: #fff; }
      .card { text-align: center; padding: 2rem 3rem; background: #121836; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
      h1 { margin: 0 0 1rem; font-size: 1.25rem; font-weight: 600; color: #9fb4ff; }
      .svc { font-weight: 700; color: #d2dcff; }
      .token { font-size: 20vw; line-height: 1; font-weight: 800; letter-spacing: 0.05em; color: #e6ecff; text-shadow: 0 4px 20px rgba(80,120,255,0.35); }
      .err { color: #ff8892; font-size: 1rem; margin-top: 1rem; }
      .small { opacity: 0.7; margin-top: 1rem; font-size: 0.9rem; }
      @media (min-width: 640px) { .token { font-size: 10rem; } }
      button { margin-top: 1.5rem; padding: .75rem 1rem; font-weight: 600; border-radius: 10px; border: 1px solid #32408f; background: #1a2352; color: #e6ecff; cursor: pointer; }
      button:hover { filter: brightness(1.1); }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Service: <span class="svc">${serviceId}</span></h1>
      <div id="token" class="token">…</div>
      <div id="error" class="err" hidden></div>
      <div class="small">This page requests a token for the <span class="svc">${serviceId}</span> service.</div>
      <button id="again">Get another token</button>
    </div>
    <script>
      async function getToken() {
        const $t = document.getElementById('token');
        const $e = document.getElementById('error');
        $e.hidden = true; $e.textContent = '';
        $t.textContent = '…';
        try {
          const res = await fetch('/b/${businessId}/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceId: '${serviceId}' }) });
          const data = await res.json();
          if (!res.ok) throw new Error(data && data.message || 'Request failed');
          const n = (data && (data.ticketNo || data.number || data.token)) || '—';
          $t.textContent = n;
        } catch (err) {
          $t.textContent = '—';
          $e.hidden = false; $e.textContent = 'Error: ' + (err && err.message || err);
        }
      }
      document.getElementById('again').addEventListener('click', getToken);
      getToken();
    </script>
  </body>
</html>`;
  return html(200, htmlBody);
}
