import { Stack, CfnOutput, aws_lambda as lambda, aws_lambda_nodejs as lambdaNode, aws_dynamodb as dynamodb, } from 'aws-cdk-lib';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpApi, CorsHttpMethod, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as path from 'node:path';
export class ApiStack extends Stack {
    httpApi;
    constructor(scope, id, props) {
        super(scope, id, props);
        const table = dynamodb.Table.fromTableName(this, 'QueueTableRef', props.tableName);
        const apiFn = new lambdaNode.NodejsFunction(this, 'ApiHandler', {
            runtime: lambda.Runtime.NODEJS_20_X,
            entry: path.resolve(process.cwd(), '../services/api/src/index.ts'),
            handler: 'handler',
            bundling: { minify: true, sourceMap: true },
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
        // Public routes
        this.httpApi.addRoutes({
            path: '/{proxy+}',
            methods: [HttpMethod.ANY],
            integration: lambdaIntegration
        });
        // Staff protected routes with Cognito User Pool authorizer
        const authorizer = new HttpUserPoolAuthorizer('StaffAuthorizer', props.userPool, {
            userPoolClients: [props.userPoolClient]
        });
        this.httpApi.addRoutes({
            path: '/staff/{proxy+}',
            methods: [HttpMethod.ANY],
            integration: lambdaIntegration,
            authorizer
        });
        new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    }
}
//# sourceMappingURL=api-stack.js.map