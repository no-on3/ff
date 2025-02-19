declare function require(name:string): any;
import * as Hostel from '@chatsight/hostel';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nomad from "@pulumi/nomad";
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Function } from '../functions/entities/function.entity';
import { MinioClientService } from '../minio-client/minio-client.service';

@Injectable()
export class NomadService {
  private nomad: any;
  private nomadApi: any;
  private readonly templatePath: string;

  constructor(
    private configService: ConfigService,
    private minioClientService: MinioClientService,
  ) {
    this.nomad = new nomad.Provider(
      'nomad',
      {
        address: `http://${this.configService.get<string>('nomad.host')}:4646`,
        caFile: this.configService.get<string>('nomad.ssl.ca'),
        certFile: this.configService.get<string>('nomad.ssl.cert'),
        keyFile: this.configService.get<string>('nomad.ssl.key'),
        skipVerify: !this.configService.get<boolean>('nomad.tlsVerify', true)
      }
    );

    // Initialize Nomad API client
    this.nomadApi = axios.create({
      baseURL: `http://${this.configService.get<string>('nomad.host')}:4646/v1`,
      headers: {
        'Content-Type': 'application/json',
      }
    });

    this.templatePath = path.join(process.cwd(), 'templates');
  }

  async onModuleInit() {
    // No initialization needed for @pulumi/nomad
  }

  async deployFunction(function_: Function): Promise<void> {
    const jobSpec = await this.createJobSpec(function_);
    const hostel = new Hostel({
      connection: {
        hostname: this.configService.get<string>('nomad.host') as string,
        port: 4646,
        ssl: {
          ca: this.configService.get<string>('nomad.ssl.ca'),
          cert: this.configService.get<string>('nomad.ssl.cert'),
          privateKey: this.configService.get<string>('nomad.ssl.key')
        },
        ignoreTLSWarning: !this.configService.get<boolean>('nomad.tlsVerify', true)
      }
    });
    await hostel.initialize();
   
    const job = await hostel.jobs.create({
      jobId: function_.id,
      Job: {...jobSpec},
      PolicyOverride: false
    });

 

    if (!job) {
      throw new Error('Failed to deploy function');
    }
  }

  async updateFunction(function_: Function): Promise<void> {
    // const job = await this.createJobSpec(function_);
    // const response = await this.nomad.updateJob(function_.id, job);
    // if (!response || response.error) {
    //   throw new Error('Failed to update function: ' + JSON.stringify(response));
    // }
  }

  async removeFunction(function_: Function): Promise<void> {
    // const response = await this.nomad.deregisterJob(function_.id);
    // if (!response || response.error) {
    //   throw new Error('Failed to remove function: ' + JSON.stringify(response));
    // }
  }

  async invokeFunction(function_: Function, input?: Record<string, any>): Promise<any> {
    console.log('here')
    try {
      // Get job allocations
      const allocResponse = await this.nomadApi.get(`/job/${function_.id}/allocations`);

      if (!allocResponse.data || allocResponse.data.length === 0) {
        throw new Error('No active allocations found for function');
      }

      const latestAlloc = allocResponse.data[0];
      console.log('Latest allocation ID:', latestAlloc.ID);
      console.log('Latest allocation ID:', JSON.stringify(latestAlloc, null, 2));

      // Get detailed allocation information
      const allocDetailsResponse = await this.nomadApi.get(`/allocation/${latestAlloc.ID}`);
      const allocDetails = allocDetailsResponse.data;



      const port = allocDetails.AllocatedResources?.Shared?.Networks?.[0]?.DynamicPorts?.find(
        (p: any) => p.Label === 'http' || p.Label === 'api'
      )?.Value;

      if (!port) {
        throw new Error('No port found for function invocation');
      }

      const invocationUrl = `http://${this.configService.get<string>('nomad.host')}:${port}/invoke`;
      console.log('Invocation URL:', invocationUrl);

      // Prepare for actual invocation
      const responseInvoke = await axios.post(
        invocationUrl,
        input || {},
        {
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      return {
        ...responseInvoke.data,
        memoryUsed: allocDetails.Resources?.MemoryStats?.RSS,
        cpuUsed: allocDetails.Resources?.CpuStats?.TotalTicks,
      };

    } catch (error) {
      console.error('Error invoking function:', error);
      throw new Error('Failed to invoke function: ' + (error as Error).message);
    }
  }

  async listJobs(function_: Function, input?: Record<string, any>): Promise<any> {
    // const response = await this.nomad.getJobs();

    // if (!response || !response.Jobs || response.Jobs.length === 0) {
    //   throw new Error('No active allocations found for function');
    // }
    // return response;

  }

  private async createJobSpec(function_: Function): Promise<any> {
    const runtimePath = path.join(this.templatePath, function_.runtime);
    const basePath = `${function_.id}`;
    const codePath = `${basePath}/code.${this.getFileExtension(function_.runtime)}`;
    const packageJsonPath = `${basePath}/package.json`;
    const tsConfigPath = `${basePath}/tsconfig.json`;
    // Get code from MinIO
    console.log('here')
    const code = await this.minioClientService.getCode(codePath);
    console.log('here')

    const packageJson = await this.minioClientService.getCode(packageJsonPath);
    console.log('here')

    const tsConfig = await this.minioClientService.getCode(tsConfigPath);
    console.log('here')
    
    // Read template files
    const wrapperCode = await fs.promises.readFile(
      path.join(runtimePath, 'wrapper.ts'),
      'utf8'
    );
    // const packageJson = await fs.promises.readFile(
    //   path.join(runtimePath, 'package.template.json'),
    //   'utf8'
    // );
    // const tsConfig = await fs.promises.readFile(
    //   path.join(runtimePath, 'tsconfig.json'),
    //   'utf8'
    // );

    return {
      ID: function_.id,
      Name: function_.name,
      Type: 'service',
      Datacenters: [this.configService.get<string>('nomad.dc', 'dc1')],
      TaskGroups: [
        {
          Name: 'function',
          Count: 1,
          Networks: [
            {
              Mode: 'bridge',
              DynamicPorts: [
                {
                  Label: 'http',
                }
              ],
            }
          ],
          Tasks: [
            {
              Name: 'function',
              Driver: 'docker',
              Config: {
                image: this.getRuntime(function_.runtime),
                command: '/bin/sh',
                args: ['-c', this.getBuildAndStartCommand()],
                ports : ['http']
              },
              Resources: {
                CPU: function_.cpu || 100,
                MemoryMB: 512,
              },
              Templates: [
                {
                  EmbeddedTmpl: code,
                  DestPath: 'local/function.ts',
                },
                {
                  EmbeddedTmpl: wrapperCode,
                  DestPath: 'local/wrapper.ts',
                },
                {
                  EmbeddedTmpl: packageJson,
                  DestPath: 'local/package.json',
                },
                {
                  EmbeddedTmpl: tsConfig,
                  DestPath: 'local/tsconfig.json',
                },
              ],
              Env: {
                FUNCTION_MEMORY_LIMIT: `${function_.memory}`,
                FUNCTION_TIMEOUT: `${function_.timeout * 1000}`,
                FUNCTION_NAME: function_.name,
                FUNCTION_VERSION: '1.0.0',
                NODE_ENV: 'production',
                PORT: '3005',
              },
              LogConfig: {
                MaxFiles: 10,
                MaxFileSizeMB: 10,
              },
              
              // Services: [
              //   {
              //     Name: function_.name,
              //     PortLabel: 'http',
              //     Tags: ['urlprefix-/'],
              //     Checks: [
              //       {
              //         Name: 'http-check',
              //         Type: 'http',
              //         Path: '/',
              //         Interval: '10s',
              //         Timeout: '2s',
              //         PortLabel: 'http',
              //       }
              //     ]
              //   }
              // ]
            },
          ],
          RestartPolicy: {
            Attempts: 3,
            Interval: 5000000000,
            Delay: 25,
            Mode: 'fail',
          },
        },
      ],
    };
  }

  private getRuntime(runtime: string): string {
    switch (runtime) {
      case 'nodejs':
        return 'node:18-alpine';
      case 'python':
        return 'python:3.9-alpine';
      default:
        throw new Error(`Unsupported runtime: ${runtime}`);
    }
  }

  private getBuildAndStartCommand(): string {
    return `
cd /local && \
npm install -g ts-node typescript '@types/node' && \
echo 'installing package.json' && \
npm install --include=dev && \
echo 'starting wrapper.ts' && \
npm run start
`;
  }

  private getFileExtension(runtime: string): string {
    switch (runtime) {
      case 'nodejs':
        return 'ts';
      case 'python':
        return 'py';
      default:
        throw new Error(`Unsupported runtime: ${runtime}`);
    }
  }
}
