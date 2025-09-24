import {
  Stack,
  StackProps,
  CfnOutput,
  RemovalPolicy,
  aws_dynamodb as dynamodb,
  aws_cognito as cognito,
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_s3_deployment as s3deploy
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface BaseInfraStackProps extends StackProps {}

export class BaseInfraStack extends Stack {
  public readonly table: dynamodb.Table;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props?: BaseInfraStackProps) {
    super(scope, id, props);

    // DynamoDB single-table
    this.table = new dynamodb.Table(this, 'QueueTable', {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Cognito User Pool for staff auth
    this.userPool = new cognito.UserPool(this, 'StaffUserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      removalPolicy: RemovalPolicy.DESTROY
    });
    this.userPoolClient = new cognito.UserPoolClient(this, 'StaffUserPoolClient', {
      userPool: this.userPool,
      generateSecret: false
    });

    // Static site hosting
    this.siteBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    this.distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      defaultRootObject: 'index.html'
    });

    // Grant CloudFront access to S3 bucket (OAC path): allow service principal with SourceArn of the distribution
    const cfArn = `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${this.distribution.distributionId}`;
    this.siteBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [this.siteBucket.arnForObjects('*')],
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': cfArn
        }
      }
    }));

    // Deploy local web/ assets to the site bucket
    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      // Resolve relative to the infra/ directory (CDK app CWD)
      sources: [s3deploy.Source.asset(path.resolve(process.cwd(), '../web'))]
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'SiteUrl', { value: `https://${this.distribution.domainName}` });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
