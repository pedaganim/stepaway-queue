import {
  Stack,
  StackProps,
  Duration,
  CfnOutput,
  RemovalPolicy,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNode,
  aws_iam as iam,
  aws_apigatewayv2 as apigwv2,
  aws_cognito as cognito,
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_s3_deployment as s3deploy
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HttpLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import { HttpApi, CorsHttpMethod } from '@aws-cdk/aws-apigatewayv2-alpha';
import * as path from 'node:path';

export class StepawayInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // DynamoDB single-table
    const table = new dynamodb.Table(this, 'QueueTable', {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Lambda for API
    const apiFn = new lambdaNode.NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      // Resolve relative to the infra/ directory (CDK app CWD)
      entry: path.resolve(process.cwd(), '../services/api/src/index.ts'),
      handler: 'handler',
      bundling: { minify: true, sourcemap: true },
      environment: {
        TABLE_NAME: table.tableName
      }
    });

    table.grantReadWriteData(apiFn);

    // HTTP API (API Gateway v2)
    const httpApi = new HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowCredentials: false,
        allowHeaders: ['*'],
        allowMethods: [
          CorsHttpMethod.ANY
        ],
        allowOrigins: ['*']
      }
    });

    const lambdaIntegration = new HttpLambdaIntegration('LambdaIntegration', apiFn);

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [
        apigwv2.HttpMethod.ANY
      ],
      integration: lambdaIntegration
    });

    // Cognito User Pool for staff auth
    const userPool = new cognito.UserPool(this, 'StaffUserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      removalPolicy: RemovalPolicy.DESTROY
    });
    const userPoolClient = new cognito.UserPoolClient(this, 'StaffUserPoolClient', {
      userPool,
      generateSecret: false
    });

    // Static site hosting
    const siteBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    const oac = new cloudfront.OriginAccessControl(this, 'OAC', {
      originAccessControlName: `${id}-oac`,
      signingBehavior: cloudfront.OriginAccessControlSigningBehaviors.SIGNING_ENABLED,
      originAccessControlOriginType: cloudfront.OriginAccessControlOriginTypes.S3,
      signingProtocol: cloudfront.OriginAccessControlSigningProtocols.SIGV4
    });

    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      defaultRootObject: 'index.html'
    });

    // Grant CloudFront access to S3 bucket
    siteBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [siteBucket.arnForObjects('*')],
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': distribution.distributionArn
        }
      }
    }));

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      destinationBucket: siteBucket,
      distribution,
      // Resolve relative to the infra/ directory (CDK app CWD)
      sources: [s3deploy.Source.asset(path.resolve(process.cwd(), '../web'))]
    });

    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'SiteUrl', { value: `https://${distribution.domainName}` });
  }
}
