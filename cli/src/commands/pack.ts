import * as chalk from 'chalk';
import ora from 'ora';
import { PackageService } from '../services/package.service';

export async function pack(path: string, options: { output?: string }) {
  const spinner = ora('Packaging lambda function...').start();
  const packageService = new PackageService();

  try {
    const outputPath = await packageService.packFunction(path, options.output);
    spinner.succeed(chalk.green(`Lambda function packaged successfully to ${outputPath}`));
  } catch (error) {
    spinner.fail(chalk.red(`Failed to package lambda function: ${error}`));
    process.exit(1);
  }
}
