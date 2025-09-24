import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true });
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
