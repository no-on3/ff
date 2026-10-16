#!/usr/bin/env node

import { program } from 'commander';
import * as dotenv from 'dotenv';
import { deploy } from './commands/deploy';
import { pack } from './commands/pack';
import { upload } from './commands/upload';

dotenv.config();

program
  .name('ff')
  .description('FF CLI - Package and deploy lambda functions')
  .version('0.1.0');

program
  .command('pack')
  .description('Package a lambda function into a zip file')
  .argument('<path>', 'Path to the lambda function directory')
  .option('-o, --output <path>', 'Output path for the zip file')
  .action(pack);

program
  .command('upload')
  .description('Upload a packaged lambda to MinIO')
  .argument('<path>', 'Path to the zip file')
  .action(upload);

program
  .command('deploy')
  .description('Package and upload a lambda function')
  .argument('<path>', 'Path to the lambda function directory')
  .action(deploy);

program.parse();
