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
