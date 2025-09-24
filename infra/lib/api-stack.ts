import {
  Stack,
  StackProps,
  CfnOutput,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNode,
  aws_dynamodb as dynamodb,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpApi, CorsHttpMethod, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import * as path from 'node:path';

export interface ApiStackProps extends StackProps {
  tableName: string;
}

export class ApiStack extends Stack {
  public readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const table = dynamodb.Table.fromTableName(this, 'QueueTableRef', props.tableName);

    const apiFn = new lambdaNode.NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.resolve(process.cwd(), '../services/api/src/index.ts'),
      handler: 'handler',
      bundling: { minify: true, sourcemap: true },
      environment: {
        TABLE_NAME: props.tableName
      }
    });

    table.grantReadWriteData(apiFn);

    this.httpApi = new HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowCredentials: false,
        allowHeaders: ['*'],
        allowMethods: [CorsHttpMethod.ANY],
        allowOrigins: ['*']
      }
    });

    const lambdaIntegration = new HttpLambdaIntegration('LambdaIntegration', apiFn);

    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.ANY],
      integration: lambdaIntegration
    });

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
  }
}
