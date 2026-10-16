import archiver from 'archiver';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class PackageService {
  async packFunction(sourcePath: string, outputPath?: string): Promise<string> {
    const absSourcePath = path.resolve(sourcePath);
    const defaultOutputPath = path.join(absSourcePath, '..', `${path.basename(absSourcePath)}.zip`);
    const finalOutputPath = outputPath || defaultOutputPath;

    // Validate source directory
    if (!fs.existsSync(absSourcePath)) {
      throw new Error(`Source directory ${absSourcePath} does not exist`);
    }

    // Ensure it has package.json
    const packageJsonPath = path.join(absSourcePath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error('package.json not found in source directory');
    }

    // Install dependencies
    await this.installDependencies(absSourcePath);

    // Compile TypeScript if needed
    await this.compileTypeScript(absSourcePath);

    // Create zip file
    await this.createZip(absSourcePath, finalOutputPath);

    return finalOutputPath;
  }

  private async installDependencies(sourcePath: string): Promise<void> {
    try {
      await execAsync('npm install --production', { cwd: sourcePath });
    } catch (error) {
      throw new Error(`Failed to install dependencies: ${error}`);
    }
  }

  private async compileTypeScript(sourcePath: string): Promise<void> {
    const tsconfigPath = path.join(sourcePath, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) {
      return; // Not a TypeScript project
    }

    try {
      await execAsync('npm run build', { cwd: sourcePath });
    } catch (error) {
      throw new Error(`Failed to compile TypeScript: ${error}`);
    }
  }

  private async createZip(sourcePath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', {
        zlib: { level: 9 }
      });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);

      // Add dist directory if it exists (compiled TypeScript)
      const distPath = path.join(sourcePath, 'dist');
      if (fs.existsSync(distPath)) {
        archive.directory(distPath, 'dist');
      }

      // Add node_modules
      archive.directory(path.join(sourcePath, 'node_modules'), 'node_modules');

      // Add package.json and tsconfig.json
      archive.file(path.join(sourcePath, 'package.json'), { name: 'package.json' });
      const tsconfigPath = path.join(sourcePath, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath)) {
        archive.file(tsconfigPath, { name: 'tsconfig.json' });
      }

      archive.finalize();
    });
  }
}
