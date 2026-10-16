import * as chalk from 'chalk';
import ora from 'ora';
import { pack } from './pack';
import { upload } from './upload';

export async function deploy(path: string) {
  const spinner = ora('Deploying lambda function...').start();

  try {
    // First pack the function
    await pack(path, {});
    const zipPath = `${path}.zip`;

    // Then upload it
    await upload(zipPath);

    spinner.succeed(chalk.green('Lambda function deployed successfully'));
  } catch (error) {
    spinner.fail(chalk.red(`Failed to deploy lambda function: ${error}`));
    process.exit(1);
  }
}
