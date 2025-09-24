#!/usr/bin/env node
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib';
import { StepawayInfraStack } from '../lib/stepaway-infra-stack.js';

const app = new cdk.App();

const stackName = app.node.tryGetContext('stackName') || 'StepawayInfra';

new StepawayInfraStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-southeast-2'
  }
});
