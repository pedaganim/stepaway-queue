#!/usr/bin/env node
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib';
import { BaseInfraStack } from '../lib/base-infra-stack.js';
import { ApiStack } from '../lib/api-stack.js';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-southeast-2'
};

const base = new BaseInfraStack(app, 'Stepaway-BaseInfra', { env });
const api = new ApiStack(app, 'Stepaway-Api', { env, tableName: base.table.tableName });
