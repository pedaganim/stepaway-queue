import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, todayStr } from '../utils/db';
import { json } from '../utils/http';

export async function createBusiness(bodyRaw: string | null, sub?: string): Promise<APIGatewayProxyStructuredResultV2> {
  const tableName = process.env.TABLE_NAME as string;
  if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });
  const body = bodyRaw ? JSON.parse(bodyRaw) : {};
  const name = (body.name || '').toString().trim() || 'My Business';
  const industry = (body.industry || '').toString().trim() || 'general';
  const workersPerDay = Number(body.workersPerDay || 1) || 1;
  const tokenMode = (body.tokenMode || 'perService').toString();
  const servicesInput = Array.isArray(body.services) ? body.services : [];
  const services = servicesInput.map((s: any, i: number) => {
    if (typeof s === 'string') return { id: s, name: s, enabled: true };
    const id = (s.id || s.name || `svc_${i}`).toString();
    return { id, name: (s.name || id).toString(), enabled: s.enabled ?? true };
  });
  const avgMinutes = (body.avgMinutes || {}) as Record<string, number>;

  const businessId = `b_${Math.random().toString(36).slice(2, 10)}`;
  const pk = `BIZ#${businessId}`;
  const profile = {
    PK: pk,
    SK: 'PROFILE',
    businessId,
    name,
    industry,
    services,
    avgMinutes,
    workersPerDay,
    tokenMode,
    status: 'open',
    createdAt: new Date().toISOString(),
    createdBy: sub || 'unknown'
  };

  await ddb.send(new PutCommand({ TableName: tableName, Item: profile, ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)' }));
  return json(201, { businessId, name, industry, services, workersPerDay, tokenMode, status: 'open' });
}

export async function updateBusiness(businessId: string, bodyRaw: string | null): Promise<APIGatewayProxyStructuredResultV2> {
  const tableName = process.env.TABLE_NAME as string;
  if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });
  const pk = `BIZ#${businessId}`;
  const body = bodyRaw ? JSON.parse(bodyRaw) : {};

  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};

  function addSet(field: string, value: any) {
    const nameKey = `#${field}`;
    const valueKey = `:${field}`;
    names[nameKey] = field;
    values[valueKey] = value;
    sets.push(`${nameKey} = ${valueKey}`);
  }

  if (body.name != null) addSet('name', String(body.name));
  if (body.industry != null) addSet('industry', String(body.industry));
  if (body.workersPerDay != null) addSet('workersPerDay', Number(body.workersPerDay));
  if (body.tokenMode != null) addSet('tokenMode', String(body.tokenMode));
  if (body.services != null) addSet('services', body.services);
  if (body.avgMinutes != null) addSet('avgMinutes', body.avgMinutes);
  addSet('updatedAt', new Date().toISOString());

  if (!sets.length) return json(400, { message: 'no fields to update' });

  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: pk, SK: 'PROFILE' },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)'
  }));

  return json(200, { businessId, updated: true });
}

export async function nextTicket(businessId: string, serviceId?: string): Promise<APIGatewayProxyStructuredResultV2> {
  const tableName = process.env.TABLE_NAME as string;
  if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });
  const dayKey = todayStr();
  const pkTickets = `BIZ#${businessId}#DAY#${dayKey}`;

  const q = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :tkt)',
    ExpressionAttributeValues: serviceId
      ? { ':pk': pkTickets, ':tkt': 'TKT#', ':pending': 'pending', ':svc': serviceId }
      : { ':pk': pkTickets, ':tkt': 'TKT#', ':pending': 'pending' },
    FilterExpression: serviceId ? '#s = :pending AND serviceId = :svc' : '#s = :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    Limit: 1
  }));

  const item = q.Items && q.Items[0];
  if (!item) return json(404, { message: 'no pending tickets' });

  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: (item as any).PK, SK: (item as any).SK },
    UpdateExpression: 'SET #s = :serving, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':serving': 'serving', ':now': new Date().toISOString(), ':pending': 'pending' },
    ConditionExpression: '#s = :pending'
  }));

  return json(200, { ticketNo: (item as any).ticketNo, status: 'serving', serviceId: (item as any).serviceId });
}

export async function resetDay(businessId: string): Promise<APIGatewayProxyStructuredResultV2> {
  const tableName = process.env.TABLE_NAME as string;
  if (!tableName) return json(500, { message: 'TABLE_NAME not configured' });
  const dayKey = todayStr();
  const pkDay = `BIZ#${businessId}`;
  const skDay = `DAY#${dayKey}`;
  await ddb.send(new PutCommand({ TableName: tableName, Item: { PK: pkDay, SK: skDay, nextNumber: 0, updatedAt: new Date().toISOString() } }));
  return json(200, { businessId, day: dayKey, nextNumber: 0 });
}
