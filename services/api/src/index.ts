import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  // Authorizer shape on HTTP API v2 is not represented in APIGatewayProxyEventV2 type; access via any
  const auth = (event.requestContext as any).authorizer;
  const sub = auth?.jwt?.claims?.sub as string | undefined;

  function todayStr() {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Public: simple token issue for a specific business
  const tokenBiz = path.match(/^\/b\/([^/]+)\/token$/);
  if (tokenBiz && method === 'POST') {
    try {
      const businessId = decodeURIComponent(tokenBiz[1]);
      const now = new Date();
      const dayKey = todayStr();
      const pkDay = `BIZ#${businessId}`;
      const skDay = `DAY#${dayKey}`;
      const tableName = process.env.TABLE_NAME as string;
      if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });

      // Atomically increment per-day counter
      const up = await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: pkDay, SK: skDay },
        UpdateExpression: 'SET nextNumber = if_not_exists(nextNumber, :zero) + :one, updatedAt = :now',
        ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':now': now.toISOString() },
        ReturnValues: 'UPDATED_NEW'
      }));
      const ticketNo = (up.Attributes?.nextNumber as number) || 1;

      // Persist ticket entry for the day
      const pkTickets = `BIZ#${businessId}#DAY#${dayKey}`;
      const ticketId = `t_${businessId}_${dayKey}_${ticketNo}`;
      const skTicket = `TKT#${String(ticketNo).padStart(4, '0')}`;
      const item = {
        PK: pkTickets,
        SK: skTicket,
        ticketId,
        ticketNo,
        businessId,
        day: dayKey,
        service: 'general',
        name: 'guest',
        status: 'pending',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };

      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
      }));

      return json(201, { ticketNo, ticketId, status: 'pending' });
    } catch (err: any) {
      return json(500, { message: 'failed to issue token', error: err?.message || String(err) });
    }
  }

  // Simple HTML page that auto-requests a token and shows it large
  if (tokenBiz && method === 'GET') {
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

  // Public: enqueue for a specific business
  const enqueueBiz = path.match(/^\/b\/([^/]+)\/enqueue$/);
  if (method === 'POST' && enqueueBiz) {
    try {
      const businessId = decodeURIComponent(enqueueBiz[1]);
      const body = event.body ? JSON.parse(event.body) : {};
      const name = (body.name || '').toString().trim();
      const service = (body.service || '').toString().trim() || 'general';
      if (!name) return json(400, { message: 'name is required' });

      const now = new Date();
      const dayKey = todayStr();
      const pkDay = `BIZ#${businessId}`;
      const skDay = `DAY#${dayKey}`;
      const tableName = process.env.TABLE_NAME as string;
      if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });

      const up = await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: pkDay, SK: skDay },
        UpdateExpression: 'SET nextNumber = if_not_exists(nextNumber, :zero) + :one, updatedAt = :now',
        ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':now': now.toISOString() },
        ReturnValues: 'UPDATED_NEW'
      }));
      const ticketNo = (up.Attributes?.nextNumber as number) || 1;

      const pkTickets = `BIZ#${businessId}#DAY#${dayKey}`;
      const ticketId = `t_${businessId}_${dayKey}_${ticketNo}`;
      const skTicket = `TKT#${String(ticketNo).padStart(4, '0')}`;
      const item = {
        PK: pkTickets,
        SK: skTicket,
        ticketId,
        ticketNo,
        businessId,
        day: dayKey,
        service,
        name,
        status: 'pending',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };

      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
      }));

      return json(201, { ticketNo, ticketId, status: 'pending' });
    } catch (err: any) {
      return json(500, { message: 'failed to enqueue', error: err?.message || String(err) });
    }
  }

  // Staff: get next pending for a specific business
  const staffNextBiz = path.match(/^\/staff\/([^/]+)\/next$/);
  if (method === 'POST' && staffNextBiz) {
    try {
      const businessId = decodeURIComponent(staffNextBiz[1]);
      const tableName = process.env.TABLE_NAME as string;
      if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });
      const dayKey = todayStr();
      const pkTickets = `BIZ#${businessId}#DAY#${dayKey}`;

      const q = await ddb.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :tkt)',
        ExpressionAttributeValues: { ':pk': pkTickets, ':tkt': 'TKT#', ':pending': 'pending' },
        FilterExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        Limit: 1
      }));

      const item = q.Items && q.Items[0];
      if (!item) return json(404, { message: 'no pending tickets' });

      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: 'SET #s = :serving, updatedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':serving': 'serving', ':now': new Date().toISOString(), ':pending': 'pending' },
        ConditionExpression: '#s = :pending'
      }));

      return json(200, { ticketNo: item.ticketNo, status: 'serving' });
    } catch (err: any) {
      return json(500, { message: 'failed to get next', error: err?.message || String(err) });
    }
  }

  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true });
  }

  // ========== Business (staff) endpoints ==========
  // Create a new business profile -> returns businessId and unique URL fragment
  if (method === 'POST' && path === '/staff/business') {
    try {
      const tableName = process.env.TABLE_NAME as string;
      if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });
      const body = event.body ? JSON.parse(event.body) : {};
      const name = (body.name || '').toString().trim() || 'My Business';
      const services = Array.isArray(body.services) ? body.services : ['general'];
      const avgMinutes = (body.avgMinutes || {}) as Record<string, number>;

      const businessId = `b_${Math.random().toString(36).slice(2, 10)}`;
      const pk = `BIZ#${businessId}`;
      const profile = {
        PK: pk,
        SK: 'PROFILE',
        businessId,
        name,
        services,
        avgMinutes,
        status: 'open',
        createdAt: new Date().toISOString(),
        createdBy: sub || 'unknown'
      };

      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: profile,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
      }));

      return json(201, { businessId, name, services, status: 'open' });
    } catch (err: any) {
      return json(500, { message: 'failed to create business', error: err?.message || String(err) });
    }
  }

  // Daily reset for a business (sets counter to 0 for today)
  const resetMatch = path.match(/^\/staff\/([^/]+)\/reset$/);
  if (method === 'POST' && resetMatch) {
    try {
      const businessId = decodeURIComponent(resetMatch[1]);
      const tableName = process.env.TABLE_NAME as string;
      if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });
      const dayKey = todayStr();
      const pkDay = `BIZ#${businessId}`;
      const skDay = `DAY#${dayKey}`;
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: { PK: pkDay, SK: skDay, nextNumber: 0, updatedAt: new Date().toISOString() }
      }));
      return json(200, { businessId, day: dayKey, nextNumber: 0 });
    } catch (err: any) {
      return json(500, { message: 'failed to reset day', error: err?.message || String(err) });
    }
  }

  // Staff: get next pending ticket and mark it as "serving"
  if (method === 'POST' && path === '/staff/next') {
    try {
      const tableName = process.env.TABLE_NAME as string;
      if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });

      const locationId = 'default';
      const pk = `LOC#${locationId}`;

      // Query tickets for this location; filter pending; pick first
      const q = await ddb.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :tkt)'
          ,
        ExpressionAttributeValues: {
          ':pk': pk,
          ':tkt': 'TKT#',
          ':pending': 'pending'
        },
        FilterExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        Limit: 1
      }));

      const item = q.Items && q.Items[0];
      if (!item) return json(404, { message: 'no pending tickets' });

      // Update status to serving
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: 'SET #s = :serving, updatedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':serving': 'serving', ':now': new Date().toISOString(), ':pending': 'pending' },
        ConditionExpression: '#s = :pending'
      }));

      return json(200, { ticketId: item.ticketId, status: 'serving' });
    } catch (err: any) {
      return json(500, { message: 'failed to get next', error: err?.message || String(err) });
    }
  }

  // Public: get ticket by id
  const ticketMatch = path.match(/^\/tickets\/([^/]+)$/);
  if (method === 'GET' && ticketMatch) {
    try {
      const tableName = process.env.TABLE_NAME as string;
      if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });
      const ticketId = decodeURIComponent(ticketMatch[1]);
      const locationId = 'default';
      const pk = `LOC#${locationId}`;
      const sk = `TKT#${ticketId}`;
      const res = await ddb.send(new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk } }));
      if (!res.Item) return json(404, { message: 'not found' });
      return json(200, res.Item);
    } catch (err: any) {
      return json(500, { message: 'failed to get ticket', error: err?.message || String(err) });
    }
  }

  if (method === 'POST' && path === '/enqueue') {
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      const name = (body.name || '').toString().trim();
      const service = (body.service || '').toString().trim() || 'general';
      if (!name) return json(400, { message: 'name is required' });

      const now = new Date();
      const ticketId = `t_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const locationId = 'default'; // TODO: make dynamic when multi-location is added
      const pk = `LOC#${locationId}`;
      const sk = `TKT#${ticketId}`;

      const item = {
        PK: pk,
        SK: sk,
        ticketId,
        locationId,
        service,
        name,
        status: 'pending',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };

      const tableName = process.env.TABLE_NAME as string;
      if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });

      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
      }));

      return json(201, { ticketId, status: 'pending' });
    } catch (err: any) {
      return json(500, { message: 'failed to enqueue', error: err?.message || String(err) });
    }
  }

  // Placeholder routing for MVP
  return json(200, {
    message: 'Stepaway API online',
    method,
    path,
    table: process.env.TABLE_NAME
  });
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': '*',
      'access-control-allow-headers': '*'
    },
    body: JSON.stringify(body)
  };
}

function html(statusCode: number, body: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': '*',
      'access-control-allow-headers': '*'
    },
    body
  };
}
